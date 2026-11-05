'use strict';

// ─── workspace.js ───────────────────────────────────────────────────────────
// The user's plans and the goals they share, kept in memory and mirrored to
// browser storage. It answers the app's questions about them (list, get, add,
// put, delete, reorder; get and put the goals), so the app's code does not know
// where they live.
//
// Reads are synchronous and come from memory. Writes are async functions: they
// validate and update memory right away, start the storage write in the same
// tick, and resolve once it is stored. Starting the write at once is what lets
// a save issued while the page is closing still reach the database. If a write
// fails, add, delete and reorder undo their memory change; a failed put is left
// for the caller to retry, which the store does.
//
// Storage holds one record per plan plus the tab order and the goal list, so
// saving an edit writes one plan, not all of them. A stored plan that fails
// validation (say, one saved by a newer build) is left untouched in storage
// and only counted; stored goals that fail it are left alone too, and goals
// are not saved over them.
//
// Goals were once kept in each plan. The first load with no shared list
// gathers them from the plans into one (Plan.legacyGoals, Plan.mergeGoals),
// and importing an older plan file adds its goals the same way.
//
// `storage` is { load() -> { plans, meta, goals }, write({ put, remove, meta, goals }) }.
// `maxPlans` caps how many plans there can be (the free sandbox allows one).
// Dual-environment: window.PrismWeb.createWorkspace in the page, CommonJS for
// tests, which pass an in-memory storage.

(function (root, factory) {
    const isNode = typeof module === 'object' && module.exports;
    const { ApiError } = isNode ? require('./api-error.js') : root.PrismWeb;
    const Plan = isNode ? require('../sim/plan.js') : root.CitrinePlan;
    const api = factory(Plan, ApiError);
    if (isNode) module.exports = api;
    else root.PrismWeb = Object.assign(root.PrismWeb || {}, api);
}(typeof self !== 'undefined' ? self : this, function (Plan, ApiError) {

    const MAX_PLANS = 15;

    function planMeta(p) {
        return { id: p.id, name: p.name, updatedAt: p.updatedAt, modules: p.nodes.length };
    }

    /** What went wrong with storage, in words the app can show. */
    function storageError(e) {
        return e && e.name === 'QuotaExceededError'
            ? new ApiError('browser storage is full', 507)
            : new ApiError('browser storage failed', 500);
    }

    function createWorkspace({ storage, clock = () => new Date(), logger = console, maxPlans = MAX_PLANS }) {
        const plans = new Map();
        let order = [];
        let active = null;
        let unreadable = 0;
        let goals = [];
        let goalsUnreadable = false;

        const stamp = () => clock().toISOString();
        const tabMeta = () => ({ order: order.slice(), active });

        async function persist(change, undo) {
            try {
                await storage.write(change);
            } catch (e) {
                if (undo) undo();
                logger.error('[workspace] write failed:', e);
                throw storageError(e);
            }
        }

        function validated(raw) {
            try {
                return Plan.validatePlan(raw);
            } catch (e) {
                if (e instanceof Plan.PlanError) throw new ApiError(e.message, 422);
                throw e;
            }
        }

        /** A plan's own goals, from before goals were shared. A malformed list
         *  is skipped: it is not worth refusing the plan over. */
        function legacyOf(raw) {
            try {
                return Plan.legacyGoals(raw);
            } catch (e) {
                logger.warn('[workspace] a plan\'s old goals were left unread:', e.message);
                return [];
            }
        }

        function find(id) {
            const p = plans.get(id);
            if (!p) throw new ApiError('plan not found', 404);
            return p;
        }

        // ── Loading ────────────────────────────────────────────────────────

        async function init() {
            const stored = await storage.load();
            const readable = [];
            let legacy = [];
            for (const raw of stored.plans) {
                try {
                    readable.push(Plan.validatePlan(raw));
                    legacy = Plan.mergeGoals(legacy, legacyOf(raw));
                } catch (e) {
                    unreadable += 1;
                    logger.warn('[workspace] a stored plan was left unread:', e.message);
                }
            }
            // Plans the saved order does not mention follow it, oldest first.
            readable.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
            for (const p of readable) plans.set(p.id, p);

            const saved = stored.meta && Array.isArray(stored.meta.order) ? stored.meta.order : [];
            const seen = new Set();
            for (const id of saved) {
                if (plans.has(id) && !seen.has(id)) {
                    seen.add(id);
                    order.push(id);
                }
            }
            for (const p of readable) if (!seen.has(p.id)) order.push(p.id);
            active = stored.meta && order.includes(stored.meta.active) ? stored.meta.active : (order[0] || null);

            if (stored.goals == null) {
                // Goals are shared from now on: start the list from the plans' own.
                goals = legacy;
                try {
                    await storage.write({ goals });
                } catch (e) {
                    logger.error('[workspace] the shared goals could not be stored yet:', e);
                }
            } else {
                try {
                    goals = Plan.validateGoals(stored.goals);
                } catch (e) {
                    goalsUnreadable = true;
                    logger.warn('[workspace] the stored goals were left unread:', e.message);
                }
            }
        }

        // ── Reads ──────────────────────────────────────────────────────────

        function listPlans() {
            return { plans: order.map((id) => planMeta(find(id))), order: order.slice(), active };
        }

        function getPlan(id) {
            return find(id);
        }

        function status() {
            return { storage: 'browser', busy: false, plans: plans.size, quarantined: unreadable };
        }

        function getGoals() {
            return { goals };
        }

        // ── Writes ─────────────────────────────────────────────────────────

        /** Add a plan at the end of the order. It becomes the open plan unless
         *  `activate` is false (sync keeping a copy of a conflicting edit). */
        async function addPlan(raw, { activate = true } = {}) {
            const plan = validated(raw);
            if (plans.size >= maxPlans) throw new ApiError(`at most ${maxPlans} ${maxPlans === 1 ? 'plan' : 'plans'}`, 409);
            if (plans.has(plan.id)) throw new ApiError('plan already exists', 409);
            plan.updatedAt = stamp();
            const prevActive = active;
            plans.set(plan.id, plan);
            order.push(plan.id);
            if (activate || !active) active = plan.id;
            await persist({ put: [plan], meta: tabMeta() }, () => {
                plans.delete(plan.id);
                order = order.filter((id) => id !== plan.id);
                active = prevActive;
            });
            return plan;
        }

        /** Add a plan from an exported file. Ids are regenerated, so importing
         *  the same file twice gives two independent plans. Goals an older file
         *  kept in the plan join the shared list, unless it holds them already. */
        async function importPlan(raw) {
            const plan = await addPlan(Plan.cloneWithNewIds(validated(raw)));
            const merged = goalsUnreadable ? goals : Plan.mergeGoals(goals, legacyOf(raw));
            if (merged.length !== goals.length) await putGoals(merged);
            return plan;
        }

        /**
         * Add every plan of an every-plan file (Download All), and its goals
         * that the list does not hold yet, in one write: all of them or none.
         * Refused (409) if they would not fit, so nothing is half imported.
         * Ids are regenerated, as for one plan.
         */
        async function importPlans({ plans: raws, goals: rawGoals }) {
            if (!raws.length) throw new ApiError('the file holds no plans', 422);
            const added = raws.map((raw) => Plan.cloneWithNewIds(validated(raw)));
            const room = maxPlans - plans.size;
            if (added.length > room) {
                throw new ApiError(`the file holds ${added.length} plans and there is room for ${room}`, 409);
            }
            let incoming = raws.flatMap((raw) => legacyOf(raw));
            if (rawGoals) {
                try {
                    incoming = [...Plan.validateGoals(rawGoals), ...incoming];
                } catch (e) {
                    if (e instanceof Plan.PlanError) throw new ApiError(`the file's goals: ${e.message}`, 422);
                    throw e;
                }
            }
            const nextGoals = goalsUnreadable ? null : Plan.mergeGoals(goals, incoming);

            const now = stamp();
            for (const p of added) p.updatedAt = now;
            const prev = { order, active, goals };
            for (const p of added) plans.set(p.id, p);
            order = [...order, ...added.map((p) => p.id)];
            active = added[0].id;
            const goalsChanged = nextGoals && nextGoals.length !== goals.length;
            if (goalsChanged) goals = nextGoals;
            await persist({ put: added, meta: tabMeta(), ...(goalsChanged ? { goals } : {}) }, () => {
                for (const p of added) plans.delete(p.id);
                ({ order, active, goals } = prev);
            });
            return { plans: added, goals };
        }

        /** Replace the goal list. Refused while stored goals could not be
         *  read, so a newer build's goals are never saved over. */
        async function putGoals(raw) {
            if (goalsUnreadable) throw new ApiError('the goals were saved by a newer version', 409);
            if (!Array.isArray(raw)) throw new ApiError('goals required', 400);
            let next;
            try {
                next = Plan.validateGoals(raw);
            } catch (e) {
                if (e instanceof Plan.PlanError) throw new ApiError(e.message, 422);
                throw e;
            }
            const prev = goals;
            goals = next;
            await persist({ goals: next }, () => { goals = prev; });
            return { goals: next };
        }

        async function putPlan(id, raw) {
            const plan = validated(raw);
            if (plan.id !== id) throw new ApiError('plan id mismatch', 400);
            const prev = find(id);
            plan.createdAt = prev.createdAt;
            plan.updatedAt = stamp();
            plans.set(id, plan);
            await persist({ put: [plan] });
            return { updatedAt: plan.updatedAt };
        }

        async function deletePlan(id) {
            const prev = find(id);
            const prevOrder = order;
            const prevActive = active;
            const at = order.indexOf(id);
            plans.delete(id);
            order = order.filter((x) => x !== id);
            if (active === id) active = order[Math.min(at, order.length - 1)] || null;
            const result = { order: order.slice(), active };
            await persist({ remove: [id], meta: tabMeta() }, () => {
                plans.set(id, prev);
                order = prevOrder;
                active = prevActive;
            });
            return result;
        }

        async function setTabs({ order: next, active: nextActive } = {}) {
            if (!Array.isArray(next) || next.length !== order.length
                || new Set(next).size !== next.length || !next.every((id) => plans.has(id))) {
                throw new ApiError('order must list every plan once', 400);
            }
            if (nextActive != null && !next.includes(nextActive)) throw new ApiError('unknown active plan', 400);
            const prevOrder = order;
            const prevActive = active;
            order = next.slice();
            active = nextActive ?? active;
            const result = { order: order.slice(), active };
            await persist({ meta: tabMeta() }, () => {
                order = prevOrder;
                active = prevActive;
            });
            return result;
        }

        // ── Changes from another device (web/sync.js) ──────────────────────

        /** May the goals be sent? Not while they are a newer build's. */
        const canSyncGoals = () => !goalsUnreadable;

        /**
         * Take what another device changed: { put: [plan], remove: [id],
         * order: [id], goals: [goal] }, each part optional. Stored with
         * `remote: true`, so sync does not send it back. A plan this build
         * cannot read is stored as it came but left out of memory, like one
         * found at startup; so are goals. The order is the other device's,
         * with any plan it does not mention kept at the end.
         * Resolves { plans: [plan], removed: [id], order, active, goals|null }.
         */
        async function applyRemote({ put = [], remove = [], order: nextOrder = null, goals: nextGoals = null }) {
            const changed = [];
            const kept = [];
            for (const raw of put) {
                let plan;
                try {
                    plan = Plan.validatePlan(raw);
                } catch (e) {
                    unreadable += 1;
                    logger.warn('[workspace] a synced plan was left unread:', e.message);
                    kept.push(raw);
                    continue;
                }
                if (!plans.has(plan.id)) order.push(plan.id);
                plans.set(plan.id, plan);
                changed.push(plan);
            }
            const removed = remove.filter((id) => plans.delete(id));
            order = order.filter((id) => plans.has(id));
            if (nextOrder) {
                const known = [...new Set(nextOrder)].filter((id) => plans.has(id));
                order = [...known, ...order.filter((id) => !known.includes(id))];
            }
            if (!order.includes(active)) active = order[0] || null;
            if (nextGoals) {
                try {
                    goals = Plan.validateGoals(nextGoals);
                    goalsUnreadable = false;
                } catch (e) {
                    goalsUnreadable = true;
                    logger.warn('[workspace] synced goals were left unread:', e.message);
                }
            }
            await storage.write({
                put: [...changed, ...kept], remove, meta: tabMeta(), goals: nextGoals, remote: true,
            });
            return { plans: changed, removed, order: order.slice(), active, goals: nextGoals && !goalsUnreadable ? goals : null };
        }

        return {
            init, status, listPlans, getPlan, addPlan, importPlan, importPlans, putPlan, deletePlan, setTabs, getGoals, putGoals,
            canSyncGoals, applyRemote,
        };
    }

    return { createWorkspace, MAX_PLANS };
}));
