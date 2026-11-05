'use strict';

// The free sandbox: where it keeps its plan, and that its limits hold through
// the same backend the full app uses (one plan, seven modules, one goal).

const test = require('node:test');
const assert = require('node:assert/strict');

const Plan = require('../static/js/sim/plan.js');
const { ApiError } = require('../static/js/web/api-error.js');
const { createWorkspace } = require('../static/js/web/workspace.js');
const { createBackend } = require('../static/js/web/backend.js');
const { createSandboxStorage, SANDBOX_STORAGE_KEY } = require('../static/js/demo/storage.js');

const silent = { warn() {}, error() {} };

/** The bits of sessionStorage the sandbox uses. */
function fakeSession(initial = {}) {
    const items = new Map(Object.entries(initial));
    return {
        items,
        getItem: (k) => (items.has(k) ? items.get(k) : null),
        setItem: (k, v) => { items.set(k, String(v)); },
        removeItem: (k) => { items.delete(k); },
    };
}

const plan = (id = 'p1') => ({ ...Plan.createPlan({ name: 'Mine', start: '2026-01', years: 2 }), id });

// ── Storage ────────────────────────────────────────────────────────────────

test('a new sandbox is empty, with no goals record yet', async () => {
    const storage = createSandboxStorage({ session: fakeSession(), logger: silent });
    assert.deepEqual(await storage.load(), { plans: [], meta: null, goals: null });
});

test('what is written is loaded back, and survives a reload of the page', async () => {
    const session = fakeSession();
    const first = createSandboxStorage({ session, logger: silent });
    await first.write({ put: [plan('a'), plan('b')], remove: ['b'], meta: { order: ['a'], active: 'a' }, goals: [] });

    const reloaded = createSandboxStorage({ session, logger: silent });
    const loaded = await reloaded.load();
    assert.deepEqual(loaded.plans.map((p) => p.id), ['a']);
    assert.deepEqual(loaded.meta, { order: ['a'], active: 'a' });
    assert.deepEqual(loaded.goals, []);
});

test('the sandbox hands out copies, so the caller cannot edit what is kept', async () => {
    const storage = createSandboxStorage({ session: fakeSession(), logger: silent });
    const original = plan('a');
    await storage.write({ put: [original] });
    original.name = 'changed after saving';
    const [kept] = (await storage.load()).plans;
    assert.equal(kept.name, 'Mine');
    kept.name = 'changed after loading';
    assert.equal((await storage.load()).plans[0].name, 'Mine');
});

test('reset forgets everything, including the copy kept for a reload', async () => {
    const session = fakeSession();
    const storage = createSandboxStorage({ session, logger: silent });
    await storage.write({ put: [plan('a')] });
    assert.ok(session.items.has(SANDBOX_STORAGE_KEY));
    storage.reset();
    assert.ok(!session.items.has(SANDBOX_STORAGE_KEY));
    assert.deepEqual((await storage.load()).plans, []);
});

test('a damaged saved sandbox is dropped with a warning, not a crash', async () => {
    const warnings = [];
    const session = fakeSession({ [SANDBOX_STORAGE_KEY]: '{not json' });
    const storage = createSandboxStorage({ session, logger: { warn: (...a) => warnings.push(a) } });
    assert.deepEqual(await storage.load(), { plans: [], meta: null, goals: null });
    assert.equal(warnings.length, 1);
});

test('with no sessionStorage, or a full one, the sandbox keeps working from memory', async () => {
    const none = createSandboxStorage({ session: null, logger: silent });
    await none.write({ put: [plan('a')] });
    assert.equal((await none.load()).plans.length, 1);

    const warnings = [];
    const full = { ...fakeSession(), setItem() { throw new DOMException('full', 'QuotaExceededError'); } };
    const storage = createSandboxStorage({ session: full, logger: { warn: (...a) => warnings.push(a) } });
    await storage.write({ put: [plan('a')] });
    assert.equal((await storage.load()).plans.length, 1);
    assert.equal(warnings.length, 1);
});

// ── Limits, through the backend the page uses ──────────────────────────────

/** A backend as demo/boot.js builds it, with the sandbox's three limits. */
async function sandbox() {
    const limits = { nodes: Plan.LIMITS.nodes, goals: Plan.LIMITS.goals };
    Plan.LIMITS.nodes = 7;
    Plan.LIMITS.goals = 1;
    const workspace = createWorkspace({ storage: createSandboxStorage({ session: fakeSession(), logger: silent }), logger: silent, maxPlans: 1 });
    await workspace.init();
    const files = {
        save: async () => true,
        open: async () => { throw new ApiError('the sandbox holds one plan', 409); },
    };
    return {
        backend: createBackend({ workspace, files, logger: silent }),
        restore: () => Object.assign(Plan.LIMITS, limits),
    };
}

function planWith(count) {
    const p = Plan.createPlan({ name: 'Mine', start: '2026-01', years: 2 });
    for (let i = 0; i < count; i++) p.nodes.push(Plan.createNode(p, 'bank-account', i * 300, 0));
    return p;
}

test('the sandbox holds one plan', async (t) => {
    const { backend, restore } = await sandbox();
    t.after(restore);
    assert.equal((await backend.dispatch('POST', '/api/plans', { plan: planWith(0) })).status, 200);
    const second = await backend.dispatch('POST', '/api/plans', { plan: planWith(0) });
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'at most 1 plan');
});

test('a plan may hold seven modules and no more', async (t) => {
    const { backend, restore } = await sandbox();
    t.after(restore);
    const full = planWith(7);
    const { body } = await backend.dispatch('POST', '/api/plans', { plan: full });
    assert.equal(body.plan.nodes.length, 7);

    // Saving an eighth module is refused, so the limit holds even if the page lets one through.
    const eight = structuredClone(body.plan);
    eight.nodes.push(Plan.createNode(eight, 'bank-account', 9999, 0));
    const refused = await backend.dispatch('PUT', `/api/plans/${eight.id}`, { plan: eight });
    assert.equal(refused.status, 422);
    assert.match(refused.body.error, /at most 7 modules/);
});

test('the sandbox holds one goal', async (t) => {
    const { backend, restore } = await sandbox();
    t.after(restore);
    const goal = (name) => Plan.createGoal({ name });
    const one = goal('First');
    assert.equal((await backend.dispatch('PUT', '/api/goals', { goals: [one] })).status, 200);
    const two = await backend.dispatch('PUT', '/api/goals', { goals: [one, goal('Second')] });
    assert.equal(two.status, 422);
    assert.match(two.body.error, /at most 1 goal/);
});

test('importing a plan file is refused before any file picker opens', async (t) => {
    const { backend, restore } = await sandbox();
    t.after(restore);
    const r = await backend.dispatch('POST', '/api/plans/import');
    assert.equal(r.status, 409);
    assert.equal(r.body.error, 'the sandbox holds one plan');
});

test('deleting the only plan leaves room for a new one', async (t) => {
    const { backend, restore } = await sandbox();
    t.after(restore);
    const { body } = await backend.dispatch('POST', '/api/plans', { plan: planWith(0) });
    assert.equal((await backend.dispatch('DELETE', `/api/plans/${body.plan.id}`)).status, 200);
    assert.equal((await backend.dispatch('POST', '/api/plans', { plan: planWith(0) })).status, 200);
});
