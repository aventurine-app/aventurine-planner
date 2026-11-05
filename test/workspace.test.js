'use strict';

// The browser workspace: what it keeps in memory, what it writes to storage and
// when, and what it does when storage refuses a write.

const test = require('node:test');
const assert = require('node:assert/strict');

const Plan = require('../static/js/sim/plan.js');
const { createWorkspace, MAX_PLANS } = require('../static/js/web/workspace.js');
const { createMemoryStorage } = require('./memory-storage');

const silent = { warn() {}, error() {} };
const NOW = new Date('2026-03-01T12:00:00.000Z');

function samplePlan(name = 'Sample') {
    const plan = Plan.createPlan({ name, start: '2026-01', years: 2 });
    const salary = Plan.createNode(plan, 'salary', 0, 0);
    const savings = Plan.createNode(plan, 'bank-account', 300, 0);
    plan.nodes.push(salary, savings);
    plan.links.push(Plan.createLink(plan, salary.id, savings.id));
    return plan;
}

async function open(storage = createMemoryStorage()) {
    const ws = createWorkspace({ storage, clock: () => NOW, logger: silent });
    await ws.init();
    return { ws, storage };
}

const rejectsWith = (promise, status, message) =>
    assert.rejects(promise, (e) => e.status === status && (message === undefined || e.message === message));

test('a new browser starts with no plans', async () => {
    const { ws } = await open();
    assert.deepEqual(ws.listPlans(), { plans: [], order: [], active: null });
    assert.deepEqual(ws.status(), { storage: 'browser', busy: false, plans: 0, quarantined: 0 });
});

test('adding a plan stores it with the tab order and makes it active', async () => {
    const { ws, storage } = await open();
    const plan = await ws.addPlan(samplePlan());
    assert.equal(plan.updatedAt, NOW.toISOString());
    assert.deepEqual(ws.listPlans().order, [plan.id]);
    assert.equal(ws.listPlans().active, plan.id);

    const stored = storage.snapshot();
    assert.deepEqual(stored.plans.map((p) => p.id), [plan.id]);
    assert.deepEqual(stored.meta, { order: [plan.id], active: plan.id });
});

test('plans come back after a reload, in the saved tab order', async () => {
    const { ws, storage } = await open();
    const a = await ws.addPlan(samplePlan('A'));
    const b = await ws.addPlan(samplePlan('B'));
    const c = await ws.addPlan(samplePlan('C'));
    await ws.setTabs({ order: [c.id, a.id, b.id], active: a.id });

    const { ws: again } = await open(storage);
    assert.deepEqual(again.listPlans().order, [c.id, a.id, b.id]);
    assert.equal(again.listPlans().active, a.id);
    assert.equal(again.getPlan(b.id).name, 'B');
});

test('plans missing from the saved order follow it, oldest first', async () => {
    const older = { ...samplePlan('Older'), createdAt: '2026-01-01T00:00:00.000Z' };
    const newer = { ...samplePlan('Newer'), createdAt: '2026-02-01T00:00:00.000Z' };
    const listed = { ...samplePlan('Listed'), createdAt: '2026-03-01T00:00:00.000Z' };
    const storage = createMemoryStorage({
        plans: [newer, listed, older],
        meta: { order: [listed.id, 'plan-that-was-deleted'], active: 'plan-that-was-deleted' },
    });
    const { ws } = await open(storage);
    assert.deepEqual(ws.listPlans().order, [listed.id, older.id, newer.id]);
    assert.equal(ws.listPlans().active, listed.id, 'an active plan that no longer exists falls back to the first tab');
});

test('putting a plan writes that plan only, and keeps its creation date', async () => {
    const { ws, storage } = await open();
    const plan = await ws.addPlan(samplePlan());
    const edited = structuredClone(plan);
    edited.name = 'Renamed';
    edited.createdAt = '1999-01-01T00:00:00.000Z';

    const result = await ws.putPlan(plan.id, edited);
    assert.equal(result.updatedAt, NOW.toISOString());
    assert.equal(ws.getPlan(plan.id).name, 'Renamed');
    assert.equal(ws.getPlan(plan.id).createdAt, plan.createdAt);

    const write = storage.writes.at(-1);
    assert.equal(write.put.length, 1);
    assert.equal(write.meta, undefined, 'an edit leaves the tab order alone');
});

test('a write is started in the same tick as the call, so a closing page can still save', async () => {
    const { ws, storage } = await open();
    const plan = await ws.addPlan(samplePlan());
    const before = storage.writes.length;
    const pending = ws.putPlan(plan.id, structuredClone(plan));
    assert.equal(storage.writes.length, before + 1, 'the storage write began before any await');
    await pending;
});

test('putting a plan checks it first', async () => {
    const { ws, storage } = await open();
    const plan = await ws.addPlan(samplePlan());
    const writes = storage.writes.length;

    await rejectsWith(ws.putPlan(plan.id, { nonsense: true }), 422);
    await rejectsWith(ws.putPlan('someone-else', structuredClone(plan)), 400, 'plan id mismatch');
    const stranger = samplePlan();
    await rejectsWith(ws.putPlan(stranger.id, stranger), 404, 'plan not found');
    assert.equal(storage.writes.length, writes, 'nothing invalid reaches storage');
});

test('deleting the active plan moves to its neighbour and removes it from storage', async () => {
    const { ws, storage } = await open();
    const a = await ws.addPlan(samplePlan('A'));
    const b = await ws.addPlan(samplePlan('B'));
    const c = await ws.addPlan(samplePlan('C'));
    await ws.setTabs({ order: [a.id, b.id, c.id], active: b.id });

    const result = await ws.deletePlan(b.id);
    assert.deepEqual(result, { order: [a.id, c.id], active: c.id });
    assert.deepEqual(storage.snapshot().plans.map((p) => p.id).sort(), [a.id, c.id].sort());
    assert.deepEqual(storage.snapshot().meta, { order: [a.id, c.id], active: c.id });

    await rejectsWith(ws.deletePlan(b.id), 404);
    assert.deepEqual(await ws.deletePlan(c.id).then((r) => r.order), [a.id]);
    assert.deepEqual(await ws.deletePlan(a.id), { order: [], active: null });
});

test('reordering tabs must list every plan once', async () => {
    const { ws } = await open();
    const a = await ws.addPlan(samplePlan('A'));
    const b = await ws.addPlan(samplePlan('B'));

    await rejectsWith(ws.setTabs({ order: [a.id] }), 400);
    await rejectsWith(ws.setTabs({ order: [a.id, a.id] }), 400);
    await rejectsWith(ws.setTabs({ order: [a.id, 'other'] }), 400);
    await rejectsWith(ws.setTabs({ order: [b.id, a.id], active: 'other' }), 400, 'unknown active plan');
    assert.deepEqual(await ws.setTabs({ order: [b.id, a.id], active: a.id }), { order: [b.id, a.id], active: a.id });
});

test('a plan is refused past the limit and when its id is taken', async () => {
    const { ws } = await open();
    const first = await ws.addPlan(samplePlan());
    await rejectsWith(ws.addPlan(structuredClone(first)), 409, 'plan already exists');
    for (let i = 1; i < MAX_PLANS; i++) await ws.addPlan(samplePlan(`P${i}`));
    await rejectsWith(ws.addPlan(samplePlan()), 409, `at most ${MAX_PLANS} plans`);
});

test('the plan limit can be lowered, and one plan reads "plan" not "plans"', async () => {
    const storage = createMemoryStorage();
    const ws = createWorkspace({ storage, clock: () => NOW, logger: silent, maxPlans: 1 });
    await ws.init();
    await ws.addPlan(samplePlan());
    await rejectsWith(ws.addPlan(samplePlan('Second')), 409, 'at most 1 plan');
    assert.equal(ws.listPlans().plans.length, 1);
});

test('importing the same plan twice gives two independent plans', async () => {
    const { ws } = await open();
    const raw = samplePlan('Shared');
    const one = await ws.importPlan(raw);
    const two = await ws.importPlan(raw);
    assert.notEqual(one.id, two.id);
    assert.notEqual(one.id, raw.id);
    assert.notEqual(one.nodes[0].id, two.nodes[0].id);
    assert.equal(ws.listPlans().order.length, 2);
});

test('a plan storage cannot read is counted, left alone, and never rewritten', async () => {
    const good = samplePlan('Good');
    const fromTheFuture = { id: 'p_future', name: 'From a newer build', nodes: 'not a list' };
    const storage = createMemoryStorage({ plans: [good, fromTheFuture] });
    const { ws } = await open(storage);

    assert.equal(ws.status().quarantined, 1);
    assert.deepEqual(ws.listPlans().order, [good.id]);

    await ws.putPlan(good.id, structuredClone(good));
    await ws.addPlan(samplePlan('Another'));
    for (const write of storage.writes) {
        assert.ok(!(write.put || []).some((p) => p.id === 'p_future'), 'the unread plan is not in any write');
        assert.ok(!(write.remove || []).includes('p_future'));
    }
    assert.ok(storage.snapshot().plans.some((p) => p.id === 'p_future'), 'it is still stored, byte for byte');
});

// ── When storage refuses a write ───────────────────────────────────────────

const quota = () => Object.assign(new Error('full'), { name: 'QuotaExceededError' });

test('a failed add leaves no trace of the plan', async () => {
    const { ws, storage } = await open();
    const keep = await ws.addPlan(samplePlan('Keep'));
    storage.failNext = quota();
    await rejectsWith(ws.addPlan(samplePlan('Lost')), 507, 'browser storage is full');
    assert.deepEqual(ws.listPlans(), {
        plans: [{ id: keep.id, name: 'Keep', updatedAt: keep.updatedAt, modules: 2 }], order: [keep.id], active: keep.id,
    });
    assert.equal(ws.status().plans, 1);
});

test('a failed delete brings the plan and its tab back', async () => {
    const { ws, storage } = await open();
    const a = await ws.addPlan(samplePlan('A'));
    const b = await ws.addPlan(samplePlan('B'));
    storage.failNext = new Error('disk');
    await rejectsWith(ws.deletePlan(a.id), 500, 'browser storage failed');
    assert.deepEqual(ws.listPlans().order, [a.id, b.id]);
    assert.equal(ws.getPlan(a.id).name, 'A');
    assert.equal(ws.listPlans().active, b.id);
});

test('a failed reorder restores the old tab order', async () => {
    const { ws, storage } = await open();
    const a = await ws.addPlan(samplePlan('A'));
    const b = await ws.addPlan(samplePlan('B'));
    storage.failNext = new Error('disk');
    await rejectsWith(ws.setTabs({ order: [b.id, a.id], active: a.id }), 500);
    assert.deepEqual(ws.listPlans().order, [a.id, b.id]);
    assert.equal(ws.listPlans().active, b.id);
});

test('a failed put reports the error and can simply be sent again', async () => {
    const { ws, storage } = await open();
    const plan = await ws.addPlan(samplePlan());
    const edited = structuredClone(plan);
    edited.name = 'Edited';
    storage.failNext = quota();
    await rejectsWith(ws.putPlan(plan.id, edited), 507);
    await ws.putPlan(plan.id, edited);
    assert.equal(storage.snapshot().plans[0].name, 'Edited');
});

// ── Shared goals ─────────────────────────────────────────────────────────────

const million = { ...Plan.createGoal({ name: 'First million', value: 1000000 }), id: 'g_million' };

test('goals are stored beside the plans and come back after a reload', async () => {
    const { ws, storage } = await open();
    assert.deepEqual(ws.getGoals(), { goals: [] });
    await ws.putGoals([million]);
    assert.deepEqual(storage.snapshot().goals, [million]);
    const { ws: again } = await open(storage);
    assert.deepEqual(again.getGoals().goals, [million]);
});

test('the first load gathers the goals plans kept before goals were shared', async () => {
    const a = samplePlan('A');
    const b = samplePlan('B');
    // Goals kept in plans, in the kinds from before goals were rules.
    a.goals = [{ id: 'g_million', kind: 'net-worth', name: 'First million', target: 1000000, nodeId: a.nodes[1].id }];
    b.goals = [{ id: 'g_again', kind: 'net-worth', name: 'First million', target: 1000000 }, { id: 'g_fi', kind: 'fi', name: 'FI', rate: 4 }];
    const storage = createMemoryStorage({ plans: [a, b] });
    const { ws } = await open(storage);
    assert.deepEqual(ws.getGoals().goals.map((g) => g.name), ['First million', 'FI'], 'the same goal twice is kept once');
    assert.deepEqual(ws.getGoals().goals.map((g) => g.metric), ['net-worth', 'savings'], 'and each is read as its rule');
    assert.equal(storage.snapshot().goals.length, 2, 'the shared list is stored');
    assert.equal('goals' in ws.getPlan(a.id), false, 'a plan keeps no goals');
    // Once there is a shared list, a plan's leftover goals are not read again.
    await ws.putGoals([]);
    const { ws: again } = await open(storage);
    assert.deepEqual(again.getGoals().goals, []);
});

test('importing an older plan file adds the goals it kept', async () => {
    const { ws } = await open();
    await ws.putGoals([million]);
    const file = { ...samplePlan('Old'), goals: [{ ...million, id: 'g_dup' }, { id: 'g_free', kind: 'debt-free', name: 'Debt-free' }] };
    await ws.importPlan(file);
    assert.deepEqual(ws.getGoals().goals.map((g) => g.name), ['First million', 'Debt-free']);
});

test('putting goals checks them, and refuses a missing list', async () => {
    const { ws, storage } = await open();
    await rejectsWith(ws.putGoals([{ id: 'g_a', kind: 'someday' }]), 422);
    await rejectsWith(ws.putGoals(undefined), 400);
    assert.equal(storage.snapshot().goals.length, 0);
});

test('stored goals saved by a newer build are left alone and never saved over', async () => {
    const storage = createMemoryStorage({ goals: [{ id: 'g_a', kind: 'someday', name: 'Later' }] });
    const { ws } = await open(storage);
    assert.deepEqual(ws.getGoals().goals, []);
    await rejectsWith(ws.putGoals([million]), 409);
    assert.equal(storage.snapshot().goals[0].kind, 'someday');
});

test('a failed goals write keeps the goals as they were', async () => {
    const { ws, storage } = await open();
    await ws.putGoals([million]);
    storage.failNext = new Error('disk');
    await rejectsWith(ws.putGoals([]), 500);
    assert.deepEqual(ws.getGoals().goals, [million]);
});
