// Encrypted sync between two devices, each a real workspace on its own storage,
// against the real worker: first sync, changes both ways, every kind of
// conflict, offline, and a vault started over elsewhere.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { createSite, subscriptionEvent } from './harness.mjs';

const require = createRequire(import.meta.url);
const Plan = require('../../static/js/sim/plan.js');
const { createWorkspace } = require('../../static/js/web/workspace.js');
const { createVaultApi } = require('../../static/js/web/vault-api.js');
const { createVaultSession } = require('../../static/js/web/vault-session.js');
const { createSync, trackChanges, claimStorage, mergeGoals, readVault } = require('../../static/js/web/sync.js');
const VaultCrypto = require('../../static/js/web/vault-crypto.js');
const { createMemoryStorage } = require('../memory-storage.js');

const silent = { warn() {}, error() {}, log() {} };

function samplePlan(name) {
    const plan = Plan.createPlan({ name, start: '2026-01', years: 2 });
    const salary = Plan.createNode(plan, 'salary', 0, 0);
    const savings = Plan.createNode(plan, 'bank-account', 300, 0);
    plan.nodes.push(salary, savings);
    plan.links.push(Plan.createLink(plan, salary.id, savings.id));
    return plan;
}

const goal = (name) => Plan.createGoal({ name, color: Plan.GOAL_COLORS[0] });

/** A device: its own storage and key store, signed in to the account. */
function device(site, cookie, { maxPlans, clock } = {}) {
    const raw = createMemoryStorage();
    const stored = new Map();
    const keys = {
        get: async (id) => stored.get(id) ?? null,
        put: async (r) => { stored.set(r.vaultId, r); },
        remove: async (id) => { stored.delete(id); },
    };
    const net = { offline: false, beforePushReply: null };
    const fetch = async (path, init) => {
        if (net.offline) throw new TypeError('Failed to fetch');
        const response = await site.call(path, { method: init.method, cookie, headers: init.headers, body: init.body });
        if (init.method === 'PUT' && path.startsWith('/api/vault/items/') && net.beforePushReply) await net.beforePushReply();
        return response;
    };
    const api = createVaultApi({ fetch });
    const dev = {
        raw, net, remote: [], statuses: [],
        session: createVaultSession({ api, keys }),
        async open() {
            const storage = trackChanges(raw);
            dev.ws = createWorkspace({ storage, logger: silent, ...(clock ? { clock } : {}) });
            await dev.ws.init();
            dev.sync = createSync({
                storage: raw, workspace: dev.ws, api, logger: silent, ...(maxPlans ? { maxPlans } : {}),
                hooks: { onRemote: (c) => dev.remote.push(c), onStatus: (s, d) => dev.statuses.push([s, d]) },
            });
            return dev;
        },
        async start() {
            const state = await dev.session.check();
            return dev.sync.start(state);
        },
        names: () => dev.ws.listPlans().order.map((id) => dev.ws.getPlan(id).name),
        goalNames: () => dev.ws.getGoals().goals.map((g) => g.name).sort(),
    };
    return dev;
}

/** An account with a vault set up on the laptop (holding `plans`), and a phone that unlocked it. */
async function account(t, { plans = [], goals = [], maxPlans, phoneMaxPlans, clocks = {} } = {}) {
    const site = createSite();
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com' });
    const cookie = await site.signIn('alice@example.com');

    const laptop = await device(site, cookie, { maxPlans, clock: clocks.laptop }).open();
    for (const p of plans) await laptop.ws.addPlan(structuredClone(p));
    if (goals.length) await laptop.ws.putGoals(goals);
    const pending = await laptop.session.prepareSetup();
    await pending.commit();
    assert.deepEqual(await laptop.start(), { ok: true });

    const phone = await device(site, cookie, { maxPlans: phoneMaxPlans ?? maxPlans, clock: clocks.phone }).open();
    await phone.session.unlock(pending.recoveryKey);
    return { site, cookie, laptop, phone, recoveryKey: pending.recoveryKey };
}

const syncBoth = async (a, b) => {
    assert.deepEqual(await a.sync.syncNow(), { ok: true });
    assert.deepEqual(await b.sync.syncNow(), { ok: true });
    assert.deepEqual(await a.sync.syncNow(), { ok: true });
};

// ── First sync ─────────────────────────────────────────────────────────────

test('a browser\'s plans and goals go to the vault sealed, and a new device opens on them', async (t) => {
    const house = samplePlan('House fund');
    const retire = samplePlan('Retire at 55');
    const { site, phone } = await account(t, { plans: [house, retire], goals: [goal('Emergency fund')] });

    const rows = site.db.sqlite.prepare('SELECT id, data FROM vault_items').all();
    assert.deepEqual(rows.map((r) => r.id).sort(), ['goals', `plan-${house.id}`, `plan-${retire.id}`, 'tabs'].sort());
    for (const row of rows) {
        for (const secret of ['House fund', 'Retire', 'Emergency', 'salary']) assert.ok(!row.data.includes(secret), `${row.id} is readable`);
    }

    // A new device starts with the blank plan the app makes; it goes once the vault's plans arrive.
    await phone.ws.addPlan(Plan.createPlan({ name: 'Untitled plan' }));
    assert.deepEqual(await phone.start(), { ok: true });
    assert.deepEqual(phone.names(), ['House fund', 'Retire at 55']);
    assert.deepEqual(phone.goalNames(), ['Emergency fund']);
    assert.equal(await phone.sync.hasUnsent(), false);
    assert.equal(site.db.sqlite.prepare("SELECT COUNT(*) AS n FROM vault_items WHERE id LIKE 'plan-%' AND data IS NOT NULL").get().n, 2, 'the blank plan never reached the vault');
});

test('a device\'s own plans join the vault\'s on its first sync', async (t) => {
    const { laptop, phone } = await account(t, { plans: [samplePlan('Laptop plan')], goals: [goal('Laptop goal')] });
    await phone.ws.addPlan(samplePlan('Phone plan'));
    await phone.ws.putGoals([goal('Phone goal')]);
    await phone.start();
    await laptop.sync.syncNow();
    for (const dev of [laptop, phone]) {
        assert.deepEqual(dev.names(), ['Laptop plan', 'Phone plan']);
        assert.deepEqual(dev.goalNames(), ['Laptop goal', 'Phone goal']);
    }
});

// ── Changes both ways ──────────────────────────────────────────────────────

test('edits, new plans and deletions reach the other device', async (t) => {
    const keep = samplePlan('Keep');
    const drop = samplePlan('Drop');
    const { laptop, phone } = await account(t, { plans: [keep, drop] });
    await phone.start();

    const edited = structuredClone(laptop.ws.getPlan(keep.id));
    edited.name = 'Keep (edited)';
    await laptop.ws.putPlan(keep.id, edited);
    await laptop.ws.addPlan(samplePlan('New'));
    await laptop.ws.deletePlan(drop.id);
    await syncBoth(laptop, phone);

    assert.deepEqual(phone.names(), ['Keep (edited)', 'New']);
    const change = phone.remote.at(-1);
    assert.ok(change.plans.some((p) => p.name === 'Keep (edited)'), 'the page is told what changed');
    assert.ok(phone.remote.some((c) => c.removed.includes(drop.id)));
});

test('opening another plan changes nothing to send; a new order does', async (t) => {
    const a = samplePlan('A');
    const b = samplePlan('B');
    const { laptop, phone } = await account(t, { plans: [a, b] });
    await phone.start();

    await laptop.ws.setTabs({ order: [a.id, b.id], active: b.id });
    assert.equal(await laptop.sync.hasUnsent(), false);
    await laptop.ws.setTabs({ order: [b.id, a.id] });
    assert.equal(await laptop.sync.hasUnsent(), true);
    await syncBoth(laptop, phone);
    assert.deepEqual(phone.names(), ['B', 'A']);
    assert.equal(phone.ws.listPlans().active, a.id, 'which plan is open stays the phone\'s own');
});

// ── Conflicts ──────────────────────────────────────────────────────────────

test('a plan changed on both devices keeps both changes', async (t) => {
    const budget = samplePlan('Budget');
    const { laptop, phone } = await account(t, { plans: [budget] });
    await phone.start();

    const onLaptop = structuredClone(laptop.ws.getPlan(budget.id));
    onLaptop.settings.years = 10;
    await laptop.ws.putPlan(budget.id, onLaptop);
    const onPhone = structuredClone(phone.ws.getPlan(budget.id));
    onPhone.nodes.pop();
    onPhone.links = [];
    await phone.ws.putPlan(budget.id, onPhone);

    await syncBoth(laptop, phone);
    for (const dev of [laptop, phone]) {
        assert.deepEqual(dev.names(), ['Budget', 'Budget (this device)']);
        assert.equal(dev.ws.getPlan(budget.id).settings.years, 10, 'the first to sync keeps the plan');
        const copy = dev.ws.getPlan(dev.ws.listPlans().order[1]);
        assert.equal(copy.nodes.length, 1, 'the other device\'s changes are in the copy');
    }
    assert.match(phone.remote.flatMap((c) => c.notices).join(), /kept as “Budget \(this device\)”/);
    assert.equal(phone.ws.listPlans().active, budget.id, 'the copy does not take over the screen');
});

test('with no room for a copy, the later edit wins and says so', async (t) => {
    const budget = samplePlan('Budget');
    let laptopTime = Date.UTC(2026, 10, 1, 9);
    let phoneTime = Date.UTC(2026, 10, 1, 9);
    const { laptop, phone } = await account(t, {
        plans: [budget], maxPlans: 1,
        clocks: { laptop: () => new Date(laptopTime), phone: () => new Date(phoneTime) },
    });
    await phone.start();

    const onPhone = structuredClone(phone.ws.getPlan(budget.id));
    onPhone.name = 'Budget, later on the phone';
    phoneTime += 60000;
    await phone.ws.putPlan(budget.id, onPhone);
    const onLaptop = structuredClone(laptop.ws.getPlan(budget.id));
    onLaptop.name = 'Budget, earlier on the laptop';
    laptopTime += 1000;
    await laptop.ws.putPlan(budget.id, onLaptop);

    await laptop.sync.syncNow();
    await phone.sync.syncNow();
    await laptop.sync.syncNow();
    for (const dev of [laptop, phone]) assert.deepEqual(dev.names(), ['Budget, later on the phone']);
    assert.match(phone.remote.flatMap((c) => c.notices).join(), /later changes here were kept/);
});

test('goals changed on both devices are merged goal by goal', async (t) => {
    const keep = goal('Keep');
    const rename = goal('Rename me');
    const remove = goal('Remove me');
    const { laptop, phone } = await account(t, { plans: [samplePlan('P')], goals: [keep, rename, remove] });
    await phone.start();

    await laptop.ws.putGoals([...laptop.ws.getGoals().goals.filter((g) => g.id !== remove.id), goal('From the laptop')]);
    await phone.ws.putGoals([
        ...phone.ws.getGoals().goals.map((g) => (g.id === rename.id ? { ...g, name: 'Renamed on the phone' } : g)),
        goal('From the phone'),
    ]);
    await syncBoth(laptop, phone);
    for (const dev of [laptop, phone]) {
        assert.deepEqual(dev.goalNames(), ['From the laptop', 'From the phone', 'Keep', 'Renamed on the phone']);
    }
});

test('an edit beats a deletion, whichever device syncs first', async (t) => {
    const a = samplePlan('A');
    const b = samplePlan('B');
    const { laptop, phone } = await account(t, { plans: [a, b, samplePlan('C')] });
    await phone.start();

    // A: deleted on the phone, edited on the laptop. B: the reverse.
    await phone.ws.deletePlan(a.id);
    const editA = structuredClone(laptop.ws.getPlan(a.id));
    editA.name = 'A edited';
    await laptop.ws.putPlan(a.id, editA);
    await laptop.ws.deletePlan(b.id);
    const editB = structuredClone(phone.ws.getPlan(b.id));
    editB.name = 'B edited';
    await phone.ws.putPlan(b.id, editB);

    await syncBoth(phone, laptop);
    await phone.sync.syncNow();
    for (const dev of [laptop, phone]) assert.deepEqual([...dev.names()].sort(), ['A edited', 'B edited', 'C']);
});

test('a new order and a new plan on different devices are both kept', async (t) => {
    const a = samplePlan('A');
    const b = samplePlan('B');
    const { laptop, phone } = await account(t, { plans: [a, b] });
    await phone.start();
    await laptop.ws.setTabs({ order: [b.id, a.id] });
    await phone.ws.addPlan(samplePlan('From the phone'));
    await syncBoth(laptop, phone);
    for (const dev of [laptop, phone]) assert.deepEqual(dev.names(), ['B', 'A', 'From the phone']);
});

test('a change made while a send is under way is sent next time, not lost', async (t) => {
    const plan = samplePlan('Plan');
    const { laptop, phone } = await account(t, { plans: [plan] });
    await phone.start();
    const first = structuredClone(laptop.ws.getPlan(plan.id));
    first.name = 'First';
    await laptop.ws.putPlan(plan.id, first);
    laptop.net.beforePushReply = async () => {
        laptop.net.beforePushReply = null;
        const second = structuredClone(laptop.ws.getPlan(plan.id));
        second.name = 'Second';
        await laptop.ws.putPlan(plan.id, second);
    };
    await laptop.sync.syncNow();
    assert.equal(await laptop.sync.hasUnsent(), true);
    await syncBoth(laptop, phone);
    assert.deepEqual(phone.names(), ['Second']);
    assert.equal(await laptop.sync.hasUnsent(), false);
});

// ── When it cannot sync ────────────────────────────────────────────────────

test('offline, changes wait on the device and go once it is back', async (t) => {
    const plan = samplePlan('Plan');
    const { laptop, phone } = await account(t, { plans: [plan] });
    await phone.start();
    laptop.net.offline = true;
    const edit = structuredClone(laptop.ws.getPlan(plan.id));
    edit.name = 'Written offline';
    await laptop.ws.putPlan(plan.id, edit);
    assert.deepEqual(await laptop.sync.syncNow(), { ok: false, reason: 'offline' });
    assert.deepEqual(laptop.statuses.at(-1), ['offline', 'offline']);
    assert.equal(await laptop.sync.hasUnsent(), true);

    laptop.net.offline = false;
    await syncBoth(laptop, phone);
    assert.deepEqual(phone.names(), ['Written offline']);
    assert.deepEqual(laptop.statuses.at(-1), ['synced', undefined]);
});

test('a vault started over on another device stops sync here, and nothing is written into the new one', async (t) => {
    const { site, laptop, phone } = await account(t, { plans: [samplePlan('Plan')] });
    await phone.start();
    const locked = await phone.session.check();
    await phone.session.startOver(locked.vault);
    await (await phone.session.prepareSetup()).commit();

    await laptop.ws.addPlan(samplePlan('After the reset'));
    assert.deepEqual(await laptop.sync.syncNow(), { ok: false, reason: 'vault_changed' });
    assert.deepEqual(await laptop.sync.syncNow(), { ok: false, reason: 'vault_changed' }, 'and stays stopped');
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM vault_items').get().n, 0);
});

// ── Pieces ─────────────────────────────────────────────────────────────────

test('another account\'s plans are cleared from the browser before it loads', async () => {
    const storage = createMemoryStorage({ plans: [samplePlan('Mine')] });
    await storage.updateSync({ binding: { email: 'alice@example.com', vaultId: 'v'.repeat(22), cursor: 4 } });
    assert.equal(await claimStorage(storage, 'alice@example.com'), false);
    assert.equal(storage.snapshot().plans.length, 1);
    assert.equal(await claimStorage(storage, 'bob@example.com'), true);
    assert.equal(storage.snapshot().plans.length, 0);
    assert.equal((await storage.loadSync()).binding, null);
    assert.equal(await claimStorage(createMemoryStorage({ plans: [samplePlan('Before sync')] }), 'bob@example.com'), false, 'a browser that never synced keeps its plans');
});

test('merging goals', () => {
    const a = { id: 'g_a', name: 'A' };
    const b = { id: 'g_b', name: 'B' };
    assert.deepEqual(mergeGoals([], [a], [b]), [b, a], 'both new: both kept, theirs first');
    assert.deepEqual(mergeGoals([a, b], [a], [a, b]), [a], 'deleted here only');
    assert.deepEqual(mergeGoals([a, b], [a, { ...b, name: 'B2' }], [a]), [a, { ...b, name: 'B2' }], 'an edit beats a deletion');
    assert.deepEqual(mergeGoals([a], [{ ...a, name: 'mine' }], [{ ...a, name: 'theirs' }]), [{ ...a, name: 'mine' }], 'edited on both: this device\'s');
    const c = { id: 'g_c', name: 'C' };
    const b2 = { ...b, name: 'B2' };
    assert.deepEqual(mergeGoals([a, b], [b, a], [a, b2]), [b2, a], 'reordered here only: this device\'s order');
    assert.deepEqual(mergeGoals([a, b], [a, b, c], [b, a]), [b, a, c], 'reordered there: theirs, an addition here is no reorder');
    assert.deepEqual(mergeGoals([a, b], [b, a], [a, b, c]), [b, a, c], 'an addition there is no reorder either');
});

// ── After the subscription ends ────────────────────────────────────────────

test('after the subscription ends, the export page reads every plan with the recovery key, and the app stays closed', async (t) => {
    const a = samplePlan('First');
    const b = samplePlan('Second');
    const gone = samplePlan('Deleted');
    const { site, cookie, laptop, recoveryKey } = await account(t, { plans: [a, b, gone], goals: [goal('Emergency fund')] });
    await laptop.ws.setTabs({ order: [b.id, a.id, gone.id] });
    await laptop.ws.deletePlan(gone.id);
    assert.deepEqual(await laptop.sync.syncNow(), { ok: true });

    site.advance(1000);
    await site.webhook(subscriptionEvent({
        subscriptionId: 'sub_01alice', customerId: 'ctm_01alice', status: 'canceled', type: 'subscription.canceled', at: site.iso(),
    }));

    const api = createVaultApi({ fetch: (path, init) => site.call(path, { method: init.method, cookie, headers: init.headers, body: init.body }) });
    const keys = { get: async () => null, put: async () => assert.fail('the export page saves no key'), remove: async () => {} };
    assert.deepEqual(await createVaultSession({ api, keys }).check(), { state: 'unavailable', reason: 'no-access' });

    const { body } = await api.getVault();
    const dataKey = await VaultCrypto.unwrapDataKey(body.vault.wrappedKey, VaultCrypto.parseRecoveryKey(recoveryKey));
    const read = await readVault({ api, vault: body.vault, dataKey, logger: silent });
    assert.deepEqual(read.plans.map((p) => p.name), ['Second', 'First'], 'in the saved order, without the deleted plan');
    assert.deepEqual(read.goals.map((g) => g.name), ['Emergency fund']);
    assert.equal(read.unreadable, 0);

    // The laptop, still open, can no longer change the vault.
    await laptop.ws.putPlan(a.id, { ...laptop.ws.getPlan(a.id), name: 'Edited' });
    assert.equal((await laptop.sync.syncNow()).ok, false);
    const again = await readVault({ api, vault: body.vault, dataKey, logger: silent });
    assert.deepEqual(again.plans.map((p) => p.name), ['Second', 'First']);
});
