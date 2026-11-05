'use strict';

// ─── sync.js ────────────────────────────────────────────────────────────────
// Encrypted sync of the plans with the account's vault (worker/src/vault.js).
// This browser's IndexedDB stays the working copy, so editing is instant and
// works offline; sync copies changes both ways in the background.
//
// What is synced, as vault items (each sealed by vault-crypto.js):
//
//   plan-<id>   one plan                  goals   { goals }, the shared list
//   tabs        { order }, the plans' order in the navigation (which plan is
//               open stays each device's own)
//
// How:
//   • trackChanges(storage) wraps the storage the workspace writes through, so
//     every local change marks its items unsent ("dirty") in the same
//     transaction as the change itself.
//   • A sync pulls what changed since the last one, then pushes what is
//     unsent. Each push names the version it replaces, so a device that missed
//     a change is refused (409) and takes the other device's change first.
//   • Two devices changing the same thing never lose either change:
//       a plan     the other device's version keeps the plan; this device's is
//                  kept beside it as "<name> (this device)". With no room for
//                  another plan, the later edit wins and a notice says so.
//       goals      merged goal by goal against the last synced list.
//       the order  whichever device moved the plans; if both did, the other
//                  device's, with plans only this one has at the end.
//       deleted there, edited here (or the reverse): the edit wins.
//   • The first sync of a browser with a vault (or of a vault started over)
//     sends everything already here, merged with what the vault holds.
//
// createSync's `hooks`: flushPage() saves the page's pending edits before a
// pull, onRemote(change) shows another device's changes, onStatus(status,
// detail) reports 'syncing' | 'synced' | 'offline' | 'error'.
//
// Dual-environment: window.PrismWeb in the page, CommonJS for tests (which run
// two devices against the real worker, test/worker/sync.test.mjs).

(function (root, factory) {
    const isNode = typeof module === 'object' && module.exports;
    const api = isNode
        ? factory(require('./vault-crypto.js'), require('../sim/plan.js'))
        : factory(root.PrismWeb.VaultCrypto, root.CitrinePlan);
    if (isNode) module.exports = api;
    else root.PrismWeb = Object.assign(root.PrismWeb || {}, api);
}(typeof self !== 'undefined' ? self : this, function (VaultCrypto, Plan) {

    const GOALS = 'goals';
    const TABS = 'tabs';
    const PLAN_PREFIX = 'plan-';
    const planItem = (id) => PLAN_PREFIX + id;
    const planIdOf = (item) => (item.startsWith(PLAN_PREFIX) ? item.slice(PLAN_PREFIX.length) : null);

    // Pull, push, and again if a push was refused: enough for two devices racing.
    const MAX_ROUNDS = 3;

    /** Why a sync stopped. `lasting` ones stop sync until the page is reloaded. */
    class SyncError extends Error {
        constructor(code, lasting = false) {
            super(code);
            this.name = 'SyncError';
            this.code = code; // 'offline' | 'server' | 'vault_full' | 'vault_changed' | 'signed_out'
            this.lasting = lasting;
        }
    }

    function failure(r) {
        if (r.status === 0) return new SyncError('offline');
        if (r.status === 401 || r.status === 403) return new SyncError('signed_out', true);
        const error = r.body && r.body.error;
        if (error === 'vault_changed' || error === 'no_vault') return new SyncError('vault_changed', true);
        if (error === 'vault_full') return new SyncError('vault_full');
        return new SyncError('server');
    }

    // ── Marking local changes ──────────────────────────────────────────────

    const sameOrder = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((id, i) => id === b[i]);

    /**
     * The workspace's storage, marking what each local write changes as unsent.
     * Writes from sync itself say `remote: true` and mark nothing. Moving to
     * another plan rewrites the tab record too, but only a new order is sent.
     * `onWrite` runs after a write that left something to send.
     */
    function trackChanges(storage, { onWrite = () => {} } = {}) {
        let lastOrder = [];
        let counter = 0;
        return {
            ...storage,
            async load() {
                const stored = await storage.load();
                lastOrder = stored.meta && Array.isArray(stored.meta.order) ? stored.meta.order.slice() : [];
                return stored;
            },
            write(change) {
                const { remote, ...rest } = change;
                if (remote) {
                    if (rest.meta) lastOrder = rest.meta.order.slice();
                    return storage.write(rest);
                }
                const dirty = [];
                for (const p of rest.put || []) dirty.push(planItem(p.id));
                for (const id of rest.remove || []) dirty.push(planItem(id));
                if (rest.goals) dirty.push(GOALS);
                if (rest.meta && !sameOrder(rest.meta.order, lastOrder)) dirty.push(TABS);
                if (rest.meta) lastOrder = rest.meta.order.slice();
                // Synchronous to here: the write starts in the caller's tick.
                const written = storage.write({ ...rest, dirty, token: `${Date.now().toString(36)}.${++counter}` });
                if (dirty.length) written.then(onWrite, () => {});
                return written;
            },
        };
    }

    /**
     * Before the workspace loads: if this browser holds another account's
     * plans, forget them (they are that account's, and in its vault). Resolves
     * true if it wiped.
     */
    async function claimStorage(storage, email) {
        const { binding } = await storage.loadSync();
        if (!binding || binding.email === email) return false;
        await storage.wipe();
        return true;
    }

    // ── Merging goals ──────────────────────────────────────────────────────

    /**
     * Two goal lists that both changed since `base`, goal by goal: a goal
     * changed on one side only takes that change (a deletion included); one
     * changed on both keeps this device's edit, and an edit beats a deletion.
     * The other device's order, then goals only this one has.
     */
    function mergeGoals(base, local, remote) {
        const byId = (list) => new Map(list.map((g) => [g.id, g]));
        const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const was = byId(base);
        const here = byId(local);
        const there = byId(remote);
        const merged = [];
        for (const id of new Set([...remote.map((g) => g.id), ...local.map((g) => g.id)])) {
            const before = was.get(id);
            const mine = here.get(id);
            const theirs = there.get(id);
            const changedHere = before ? !mine || !same(mine, before) : !!mine;
            const changedThere = before ? !theirs || !same(theirs, before) : !!theirs;
            let pick = theirs;
            if (changedHere && !changedThere) pick = mine;
            else if (changedHere && changedThere) pick = mine || theirs;
            if (pick) merged.push(pick);
        }
        return merged.slice(0, Plan.LIMITS.goals);
    }

    // ── The engine ─────────────────────────────────────────────────────────

    function createSync({ storage, workspace, api, crypto = VaultCrypto, maxPlans = 15, logger = console, hooks = {} }) {
        const { flushPage = async () => true, onRemote = () => {}, onStatus = () => {} } = hooks;
        let ctx = null;           // { email, vaultId, dataKey }
        let running = null;       // the sync in progress
        let again = false;        // asked for again while one ran
        let stopped = null;       // a lasting reason sync stopped

        const context = (id, version) => ({ vaultId: ctx.vaultId, id, version });

        /** The value to send for an item: undefined if it is not this build's to send, null if deleted. */
        function localValue(id) {
            if (id === GOALS) return workspace.canSyncGoals() ? { goals: workspace.getGoals().goals } : undefined;
            if (id === TABS) return { order: workspace.listPlans().order };
            const planId = planIdOf(id);
            if (!planId) return undefined;
            try {
                return workspace.getPlan(planId);
            } catch (e) {
                if (e.status === 404) return null;
                throw e;
            }
        }

        /** A change for the page that moves nothing, to carry the order, a removal or notices. */
        function unchanged() {
            const { order, active } = workspace.listPlans();
            return { plans: [], removed: [], goals: null, order, active, notices: [] };
        }

        function copyName(name) {
            return `${name} (this device)`.slice(0, Plan.LIMITS.name);
        }

        /**
         * Take items from the vault (a page of a pull, or the current value a
         * refused push was handed). `records` holds this device's record of
         * each, as read before. Applies them to the workspace, tells the page,
         * and records the new versions.
         */
        async function absorb(incoming, records) {
            const change = { put: [], remove: [], order: null, goals: null };
            const updates = [];
            const copies = [];
            const notices = [];
            let planCount = workspace.listPlans().order.length;

            for (const item of incoming) {
                const rec = records.get(item.id) || { id: item.id, version: 0, dirty: null };
                if (rec.version >= item.version) continue; // our own write coming back, or older than ours
                let value = null;
                if (item.data != null) {
                    try {
                        value = await crypto.openItem(ctx.dataKey, item.data, context(item.id, item.version));
                    } catch (e) {
                        logger.error(`[sync] ${item.id} could not be opened, so it was skipped:`, e.message);
                        continue;
                    }
                }
                const dirty = rec.dirty != null;
                const settle = { id: item.id, version: item.version, clearIf: rec.dirty };
                const keep = { id: item.id, version: item.version };
                const planId = planIdOf(item.id);

                if (planId) {
                    const local = dirty ? localValue(item.id) : null;
                    if (!dirty) {
                        if (value) {
                            if (!workspace.listPlans().order.includes(planId)) planCount += 1;
                            change.put.push(value);
                        } else {
                            change.remove.push(planId);
                        }
                        updates.push(keep);
                    } else if (!value) {
                        updates.push(keep); // deleted there, edited here: ours goes back over the deletion
                    } else if (!local) {
                        change.put.push(value); // deleted here, edited there: the edit wins
                        updates.push(settle);
                    } else if (JSON.stringify(local) === JSON.stringify(value)) {
                        updates.push(settle);
                    } else if (planCount + copies.length < maxPlans) {
                        const copy = Plan.cloneWithNewIds(local, copyName(local.name));
                        copies.push(copy);
                        change.put.push(value);
                        updates.push(settle);
                        notices.push(`“${value.name}” was also changed on another device. Your changes here were kept as “${copy.name}”.`);
                    } else if (String(value.updatedAt) > String(local.updatedAt)) {
                        change.put.push(value);
                        updates.push(settle);
                        notices.push(`“${value.name}” was changed on another device after your changes here, so that version was kept.`);
                    } else {
                        updates.push(keep);
                        notices.push(`“${local.name}” was also changed on another device. Your later changes here were kept.`);
                    }
                } else if (item.id === GOALS) {
                    const theirs = value ? value.goals : [];
                    // Changed here too: merge, and the merge is sent next (the item stays unsent).
                    change.goals = dirty ? mergeGoals(rec.base || [], workspace.getGoals().goals, theirs) : theirs;
                    updates.push(dirty ? { ...keep, base: theirs } : { ...settle, base: theirs });
                } else if (item.id === TABS) {
                    const theirs = value ? value.order : [];
                    const base = rec.base || null;
                    const mine = workspace.listPlans().order;
                    if (dirty && base && sameOrder(theirs, base)) {
                        updates.push({ ...keep, base: theirs }); // only this device moved them: ours is sent
                    } else {
                        // Theirs, with any plans only this device has at the end (applyRemote);
                        // sent back only when that differs from theirs.
                        change.order = theirs;
                        const onlyHere = dirty && mine.some((id) => !theirs.includes(id));
                        updates.push({ ...(onlyHere ? keep : settle), base: theirs });
                    }
                }
                // Anything else is a newer build's item: left in the vault, untouched.
            }

            if (change.put.length || change.remove.length || change.order || change.goals) {
                const applied = await workspace.applyRemote(change);
                for (const copy of copies) {
                    try {
                        applied.plans.push(await workspace.addPlan(copy, { activate: false }));
                    } catch (e) {
                        logger.error('[sync] a conflicting copy could not be kept:', e);
                    }
                }
                const { order, active } = workspace.listPlans();
                onRemote({ ...applied, order, active, notices });
            } else if (notices.length) {
                onRemote({ ...unchanged(), notices });
            }
            if (updates.length) await storage.updateSync({ items: updates });
        }

        /** Everything that changed in the vault since the last pull. Resolves how many live plans it saw. */
        async function pull() {
            const { binding, items } = await storage.loadSync();
            const records = new Map(items.map((r) => [r.id, r]));
            let cursor = binding ? binding.cursor : 0;
            let plans = 0;
            for (;;) {
                const r = await api.pull(ctx.vaultId, cursor);
                if (r.status !== 200 || !r.body.ok) throw failure(r);
                plans += r.body.items.filter((i) => planIdOf(i.id) && i.data != null).length;
                await absorb(r.body.items, records);
                cursor = r.body.cursor;
                await storage.updateSync({ binding: { email: ctx.email, vaultId: ctx.vaultId, cursor } });
                if (!r.body.more) return plans;
            }
        }

        /** Send everything unsent. Resolves how many sends were refused for a newer version. */
        async function push() {
            const { items } = await storage.loadSync();
            let refused = 0;
            for (const rec of items) {
                if (rec.dirty == null) continue;
                const value = localValue(rec.id);
                if (value === undefined) continue;
                if (value === null && rec.version === 0) {
                    // Made and deleted here before it was ever sent.
                    await storage.updateSync({ items: [{ id: rec.id, version: 0, clearIf: rec.dirty }] });
                    continue;
                }
                const version = rec.version + 1;
                const data = value === null ? null : await crypto.sealItem(ctx.dataKey, value, context(rec.id, version));
                const r = await api.push(rec.id, { vaultId: ctx.vaultId, baseVersion: rec.version, data });
                if (r.status === 200 && r.body.ok) {
                    const base = rec.id === GOALS ? value.goals : rec.id === TABS ? value.order : undefined;
                    await storage.updateSync({ items: [{ id: rec.id, version: r.body.item.version, clearIf: rec.dirty, base }] });
                } else if (r.status === 409 && r.body.error === 'conflict') {
                    refused += 1;
                    if (r.body.current) await absorb([r.body.current], new Map([[rec.id, rec]]));
                    else await storage.updateSync({ items: [{ id: rec.id, version: 0 }] });
                } else {
                    throw failure(r);
                }
            }
            return refused;
        }

        /** A new device's blank starter plans go, once the vault has plans of its own. */
        async function dropBlankPlans() {
            const { items } = await storage.loadSync();
            const unsentNew = new Set(items.filter((r) => r.version === 0 && r.dirty != null).map((r) => r.id));
            const blank = workspace.listPlans().order
                .filter((id) => unsentNew.has(planItem(id)) && workspace.getPlan(id).nodes.length === 0);
            if (!blank.length) return;
            for (const id of blank) await workspace.deletePlan(id);
            onRemote({ ...unchanged(), removed: blank });
        }

        async function cycle({ adopting }) {
            onStatus('syncing');
            try {
                await flushPage();
                for (let round = 0; round < MAX_ROUNDS; round++) {
                    const remotePlans = await pull();
                    if (adopting && round === 0 && remotePlans > 0) await dropBlankPlans();
                    if (!(await push())) break;
                }
                onStatus('synced');
                return { ok: true };
            } catch (e) {
                if (!(e instanceof SyncError)) {
                    logger.error('[sync] failed:', e);
                    onStatus('error', 'server');
                    return { ok: false, reason: 'server' };
                }
                if (e.lasting) stopped = e.code;
                onStatus(e.code === 'offline' ? 'offline' : 'error', e.code);
                return { ok: false, reason: e.code };
            }
        }

        /** Sync now, or once more after the one running. */
        function syncNow(options = {}) {
            if (stopped || !ctx) return Promise.resolve({ ok: false, reason: stopped || 'not_started' });
            if (running) {
                again = true;
                return running;
            }
            running = (async () => {
                let result;
                let first = options;
                do {
                    again = false;
                    result = await cycle(first);
                    first = {};
                } while (again && result.ok);
                return result;
            })().finally(() => { running = null; });
            return running;
        }

        /**
         * Begin syncing with `vault`. A browser that has not synced with this
         * vault before sends everything it holds, merged with the vault's.
         */
        async function start({ email, vault, dataKey }) {
            ctx = { email, vaultId: vault.id, dataKey };
            const { binding } = await storage.loadSync();
            const adopting = !binding || binding.vaultId !== vault.id;
            if (adopting) {
                await storage.updateSync({ reset: true, binding: { email, vaultId: vault.id, cursor: 0 } });
                const ids = workspace.listPlans().order.map(planItem);
                if (workspace.canSyncGoals()) ids.push(GOALS);
                ids.push(TABS);
                await storage.write({ dirty: ids, token: 'first-sync' });
            }
            return syncNow({ adopting });
        }

        /** Is anything here not yet in the vault? */
        async function hasUnsent() {
            const { items } = await storage.loadSync();
            return items.some((r) => r.dirty != null && localValue(r.id) !== undefined);
        }

        /** Stop for the rest of this page's life (signing out). */
        function stop() {
            stopped = 'stopped';
        }

        return { start, syncNow, hasUnsent, stop };
    }

    // ── Reading the whole vault ──────────────────────────────────────────

    /**
     * Everything in the vault, opened, without touching this browser's
     * storage: for the export page, where someone whose subscription has
     * ended takes their plans away. Resolves { plans, goals, unreadable }:
     * the plans in their saved order, the goal list ([] if it is missing or
     * unreadable), and how many items could not be opened or read. Throws
     * SyncError if the server cannot be reached or refuses.
     */
    async function readVault({ api, crypto = VaultCrypto, vault, dataKey, logger = console }) {
        const latest = new Map();
        let since = 0;
        for (;;) {
            const r = await api.pull(vault.id, since);
            if (r.status !== 200) throw failure(r);
            for (const item of r.body.items) latest.set(item.id, item);
            since = r.body.cursor;
            if (!r.body.more) break;
        }

        const plans = new Map();
        let goals = [];
        let order = [];
        let unreadable = 0;
        for (const item of latest.values()) {
            if (item.data == null) continue;
            try {
                const value = await crypto.openItem(dataKey, item.data, { vaultId: vault.id, id: item.id, version: item.version });
                const planId = planIdOf(item.id);
                if (planId) plans.set(planId, Plan.validatePlan(value));
                else if (item.id === GOALS) goals = Plan.validateGoals(value.goals);
                else if (item.id === TABS) order = Array.isArray(value.order) ? value.order : [];
            } catch (e) {
                unreadable += 1;
                logger.warn(`[sync] ${item.id} could not be read:`, e.message);
            }
        }
        const ordered = [...order.filter((id) => plans.has(id)), ...[...plans.keys()].filter((id) => !order.includes(id))];
        return { plans: ordered.map((id) => plans.get(id)), goals, unreadable };
    }

    return {
        createSync, trackChanges, claimStorage, mergeGoals, readVault, SyncError, SYNC_ITEMS: { GOALS, TABS, planItem },
    };
}));
