'use strict';

// Taking plans away: the run's summary (shared with Analyze), the CSVs, the
// every-plan file and Download All's zip, and importing that file again.

const test = require('node:test');
const assert = require('node:assert/strict');

const Plan = require('../static/js/sim/plan.js');
const { simulate } = require('../static/js/sim/engine.js');
const Summary = require('../static/js/sim/summary.js');
const { Exports } = require('../static/js/web/exports.js');
const { PlanFiles } = require('../static/js/web/plan-files.js');
const { createWorkspace } = require('../static/js/web/workspace.js');
const { createBackend } = require('../static/js/web/backend.js');
const { createMemoryStorage } = require('./memory-storage');

const silent = { log() {}, warn() {}, error() {} };

/** Pay into a bank account that pays down a loan, over `years`. */
function samplePlan(name = 'Sample', years = 3) {
    const plan = Plan.createPlan({ name, start: '2026-01', years });
    const salary = Plan.createNode(plan, 'salary', 0, 0);
    const bank = Plan.createNode(plan, 'bank-account', 300, 0);
    const loan = Plan.createNode(plan, 'loan', 600, 0);
    loan.name = 'Car loan';
    loan.params.balance = 8000;
    loan.params.rate = 6;
    plan.nodes.push(salary, bank, loan);
    plan.links.push(Plan.createLink(plan, salary.id, bank.id));
    plan.links.push({ ...Plan.createLink(plan, bank.id, loan.id), mode: 'fixed', value: 300 });
    return Plan.validatePlan(plan);
}

const near = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} ≈ ${b}`);

// ── The summary ────────────────────────────────────────────────────────────

test('the years add up to the whole run, and end where it ends', () => {
    const plan = samplePlan('Sample', 3);
    const res = simulate(plan);
    const all = Summary.headline(res);
    const years = Summary.years(plan, res);
    assert.equal(years.length, 3);
    for (const key of ['takeHome', 'spent', 'growth', 'interest', 'change']) {
        near(years.reduce((s, y) => s + y[key], 0), all[key]);
    }
    near(years.at(-1).worth, all.end);
    near(all.change, all.end - all.start);
    assert.ok(all.interest > 0, 'the loan charged interest');
});

test('the month table has a row a month and a column for every balance', () => {
    const plan = samplePlan('Sample', 2);
    const res = simulate(plan);
    const { columns, rows } = Summary.months(plan, res);
    assert.equal(rows.length, 24);
    assert.equal(rows[0][0], '2026-01');
    assert.equal(rows.at(-1)[0], '2027-12');
    assert.ok(columns.includes('Car loan (owed)'));
    const bank = plan.nodes.find((n) => n.type === 'bank-account');
    assert.ok(columns.includes(`${bank.name} (balance)`));
    near(rows.at(-1)[columns.indexOf('Net worth')], res.netWorth[24]);
    near(rows.at(-1)[columns.indexOf('Car loan (owed)')], res.nodes[plan.nodes[2].id].balance[24]);
    assert.ok(!columns.includes('Age'), 'no age without one set');
});

// ── CSV ────────────────────────────────────────────────────────────────────

test('CSV cells are quoted where needed, numbers stay numbers, and formulas stay text', () => {
    const text = Exports.toCsv({
        columns: ['Name', 'Value'],
        rows: [['a, "b"', 1.5], ['line\nbreak', -2], ['=HYPERLINK("x")', null], ['@SUM(A1)', 0]],
    });
    assert.ok(text.startsWith('\uFEFFName,Value\r\n'), 'a byte-order mark, then CRLF lines');
    const lines = text.slice(1).split('\r\n');
    assert.equal(lines[1], '"a, ""b""",1.5');
    assert.equal(lines[2], '"line\nbreak",-2', 'a line break inside a cell stays in its quotes');
    assert.ok(text.includes('"\'=HYPERLINK(""x"")",'), 'a formula is written as text');
    assert.ok(text.includes('\'@SUM(A1),0'));
});

test('a plan\'s CSV is its month table', () => {
    const plan = samplePlan('Sample', 1);
    const lines = Exports.planCsv(plan).slice(1).trim().split('\r\n');
    assert.equal(lines.length, 13);
    assert.ok(lines[0].startsWith('Month,Take-home pay,'));
});

test('the goals CSV has every goal against every plan', () => {
    const plans = [samplePlan('A'), samplePlan('B')];
    const goals = [Plan.createGoal({ name: 'Rich', value: 1, by: '2028-01' }), Plan.createGoal({ name: 'Richer', value: 1e9, by: '2028-01' })];
    const lines = Exports.goalsCsv(plans, goals).slice(1).trim().split('\r\n');
    assert.equal(lines[0], 'Goal,Plan,Status,Met in,Deadline');
    assert.equal(lines.length, 5);
    assert.ok(lines.some((l) => l.startsWith('Richer,B,Never met,,2028-01')), lines.join('\n'));
});

// ── Zip ────────────────────────────────────────────────────────────────────

/** Read a stored zip back: [{ name, text }], checking every header and CRC on the way. */
function unzip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = bytes.byteLength - 22;
    assert.equal(view.getUint32(end, true), 0x06054b50, 'end of central directory');
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    const dec = new TextDecoder();
    const files = [];
    for (let i = 0; i < count; i++) {
        assert.equal(view.getUint32(at, true), 0x02014b50, 'central entry');
        const crc = view.getUint32(at + 16, true);
        const size = view.getUint32(at + 20, true);
        const nameLen = view.getUint16(at + 28, true);
        const offset = view.getUint32(at + 42, true);
        const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
        assert.equal(view.getUint32(offset, true), 0x04034b50, `local header of ${name}`);
        assert.equal(view.getUint16(offset + 26, true), nameLen);
        const data = bytes.subarray(offset + 30 + nameLen, offset + 30 + nameLen + size);
        assert.equal(Exports.crc32(data), crc, `CRC of ${name}`);
        files.push({ name, text: dec.decode(data) });
        at += 46 + nameLen;
    }
    return files;
}

test('the CRC is the standard one', () => {
    assert.equal(Exports.crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('Download All holds every plan as one file that imports again, the goals and a CSV per plan', () => {
    const plans = [samplePlan('Budget'), samplePlan('budget'), samplePlan('Retire: 2040?')];
    const goals = [Plan.createGoal({ name: 'Rich' })];
    const files = unzip(Exports.archive({ plans, goals }, { logger: silent }));
    assert.deepEqual(files.map((f) => f.name), [
        'All plans.json', 'Goals.csv', 'CSV/Budget.csv', 'CSV/budget (2).csv', 'CSV/Retire 2040.csv',
    ]);
    const back = PlanFiles.read(files[0].text);
    assert.deepEqual(back.plans, plans);
    assert.deepEqual(back.goals, goals);
    assert.ok(files[2].text.includes('Car loan (owed)'));
    assert.match(Exports.archiveName(new Date('2026-11-05T10:00:00Z')), /^Aventurine Planner 2026-11-05\.zip$/);
});

test('a name in any script survives the zip', () => {
    const files = unzip(Exports.zip([{ name: 'CSV/Épargne 貯金.csv', text: 'ü' }]));
    assert.deepEqual(files, [{ name: 'CSV/Épargne 貯金.csv', text: 'ü' }]);
});

// ── The every-plan file ────────────────────────────────────────────────────

test('a plan file reads as one plan; the every-plan file as all of them', () => {
    const plan = samplePlan();
    assert.deepEqual(PlanFiles.read(PlanFiles.serialize(plan)), { plans: [plan], goals: null });
    assert.deepEqual(PlanFiles.read(JSON.stringify(plan)), { plans: [plan], goals: null });
    const all = JSON.parse(PlanFiles.serializeAll({ plans: [plan], goals: [] }));
    assert.equal(all.format, 'aventurine-planner-plans');
    assert.throws(() => PlanFiles.read(JSON.stringify({ format: 'aventurine-planner-plans', plans: 'x' })), { status: 422 });
});

async function workspaceWith(plans = []) {
    const storage = createMemoryStorage();
    const workspace = createWorkspace({ storage, logger: silent });
    await workspace.init();
    for (const p of plans) await workspace.addPlan(p);
    return { storage, workspace };
}

test('importing the every-plan file adds every plan with new ids, and goals it does not hold yet', async () => {
    const goal = Plan.createGoal({ name: 'Rich' });
    const { workspace } = await workspaceWith([samplePlan('Mine')]);
    await workspace.putGoals([goal]);
    const plans = [samplePlan('A'), samplePlan('B')];
    const r = await workspace.importPlans({ plans, goals: [goal, Plan.createGoal({ name: 'Other' })] });
    assert.deepEqual(r.plans.map((p) => p.name), ['A', 'B']);
    assert.ok(r.plans.every((p) => !plans.some((o) => o.id === p.id)), 'new ids');
    const listed = workspace.listPlans();
    assert.equal(listed.order.length, 3);
    assert.equal(listed.active, r.plans[0].id);
    assert.deepEqual(workspace.getGoals().goals.map((g) => g.name), ['Rich', 'Other']);
});

test('an every-plan file that would not fit imports nothing', async () => {
    const { workspace } = await workspaceWith();
    const plans = Array.from({ length: 16 }, (_, i) => samplePlan(`P${i}`));
    await assert.rejects(workspace.importPlans({ plans, goals: null }), { status: 409 });
    assert.equal(workspace.listPlans().order.length, 0);
    await assert.rejects(workspace.importPlans({ plans: [samplePlan(), { nonsense: true }], goals: null }), { status: 422 });
    assert.equal(workspace.listPlans().order.length, 0, 'one bad plan refuses the file');
});

test('a failed write leaves the workspace as it was', async () => {
    const { storage, workspace } = await workspaceWith([samplePlan('Mine')]);
    const write = storage.write;
    storage.write = async () => { throw new Error('disk full'); };
    await assert.rejects(workspace.importPlans({ plans: [samplePlan('A')], goals: [Plan.createGoal()] }));
    storage.write = write;
    assert.deepEqual(workspace.listPlans().plans.map((p) => p.name), ['Mine']);
    assert.deepEqual(workspace.getGoals().goals, []);
});

// ── Over the backend's URLs ────────────────────────────────────────────────

async function backendWith(plans, openResult = null) {
    const { workspace } = await workspaceWith(plans);
    const files = {
        saved: [],
        async save(file) { files.saved.push(file); return true; },
        async open() { return openResult; },
    };
    const backend = createBackend({ workspace, files, logger: silent });
    return { call: (m, u, b) => backend.dispatch(m, u, b), files, workspace };
}

test('a plan exports as a spreadsheet, and an unknown format is refused before any dialog', async () => {
    const { call, files, workspace } = await backendWith([samplePlan('Budget')]);
    const id = workspace.listPlans().order[0];
    assert.deepEqual((await call('POST', `/api/plans/${id}/export`, { format: 'csv' })).body, { saved: true });
    assert.equal(files.saved[0].name, 'Budget.csv');
    assert.equal(files.saved[0].kind, 'csv');
    assert.ok(files.saved[0].text.startsWith('\uFEFFMonth,'));
    assert.equal((await call('POST', `/api/plans/${id}/export`, { format: 'docx' })).status, 400);
    assert.equal(files.saved.length, 1);
});

test('Download All saves one zip of every plan, in navigation order', async () => {
    const { call, files } = await backendWith([samplePlan('First'), samplePlan('Second')]);
    assert.deepEqual((await call('POST', '/api/export')).body, { saved: true });
    assert.equal(files.saved[0].kind, 'zip');
    assert.match(files.saved[0].name, /^Aventurine Planner \d{4}-\d{2}-\d{2}\.zip$/);
    const names = PlanFiles.read(unzip(files.saved[0].data)[0].text).plans.map((p) => p.name);
    assert.deepEqual(names, ['First', 'Second']);
});

test('importing the every-plan file over the backend answers with every plan', async () => {
    const text = PlanFiles.serializeAll({ plans: [samplePlan('A'), samplePlan('B')], goals: [] });
    const { call } = await backendWith([], text);
    const r = await call('POST', '/api/plans/import');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.plans.map((p) => p.name), ['A', 'B']);
});
