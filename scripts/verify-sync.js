'use strict';

// End-to-end check of encrypted sync in a real Chromium: two devices (a
// "laptop" and a "phone"), each its own origin and so its own IndexedDB,
// talking to the real worker (worker/src/, on in-memory SQLite through
// test/worker/harness.mjs) behind a small proxy that also serves the app the
// way the dev server does. Covers upgrading a browser that has plans from
// before sync, the recovery-key screens, changes both ways, a conflict, going
// offline and back, signing out (which clears the browser), another account
// signing in on the same browser, and, once the subscription ends, the export
// page. Exits 0 on PASS.
//
//   npm run verify:sync

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('./dev-server');
const Plan = require('../static/js/sim/plan.js');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-sync-verify-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let failed = false;

function check(label, ok) {
    console.log(`${ok ? 'ok ' : 'FAIL'}  ${label}`);
    if (!ok) failed = true;
}

/** A plan from before sync, as an older build stored it. */
function oldPlan() {
    const plan = Plan.createPlan({ name: 'Plan from before sync', start: '2026-01', years: 3 });
    const salary = Plan.createNode(plan, 'salary', 0, 0);
    const savings = Plan.createNode(plan, 'bank-account', 300, 0);
    plan.nodes.push(salary, savings);
    plan.links.push(Plan.createLink(plan, salary.id, savings.id));
    return plan;
}

// The database as version 1 of storage.js left it (no sync store), with one plan.
const SEED_PAGE = (plan) => `<!doctype html><title>seeding</title><script>
const plan = ${JSON.stringify(plan)};
const req = indexedDB.open('aventurine-prism', 1);
req.onupgradeneeded = () => { req.result.createObjectStore('plans', { keyPath: 'id' }); req.result.createObjectStore('meta'); };
req.onsuccess = () => {
    const db = req.result;
    const tx = db.transaction(['plans', 'meta'], 'readwrite');
    tx.objectStore('plans').put(plan);
    tx.objectStore('meta').put({ order: [plan.id], active: plan.id }, 'tabs');
    tx.objectStore('meta').put([], 'goals');
    tx.oncomplete = () => { db.close(); document.title = 'seeded'; };
};
</script>`;

/** One device's origin: the app's files, and /api/* to the worker as `device.cookie`. */
function deviceServer(site, device) {
    const serveFile = createServer().listeners('request')[0];
    const server = http.createServer((req, res) => {
        if (req.url === '/seed') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(SEED_PAGE(device.seedPlan));
            return;
        }
        if (!req.url.startsWith('/api/')) {
            serveFile(req, res);
            return;
        }
        if (device.offline) {
            req.socket.destroy();
            return;
        }
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', async () => {
            const body = chunks.length ? Buffer.concat(chunks).toString() : undefined;
            const headers = req.headers['content-type'] ? { 'Content-Type': req.headers['content-type'] } : {};
            const r = await site.call(req.url, { method: req.method, cookie: device.cookie, headers, body });
            res.writeHead(r.status, { 'Content-Type': r.headers.get('Content-Type') || 'application/json' });
            res.end(Buffer.from(await r.arrayBuffer()));
        });
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

function openWindow() {
    const win = new BrowserWindow({
        show: false, width: 1280, height: 860,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.webContents.on('console-message', (e) => {
        if (e.level === 'error') errors.push(e.message);
    });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    return { win, js };
}

async function until(js, expression, ms = 12000) {
    for (let t = 0; t < ms; t += 100) {
        if (await js(expression).catch(() => false)) return true;
        await sleep(100);
    }
    return false;
}

const appReady = '!!(window.Store && Store.state.results) && !document.getElementById("app").hidden';
const names = 'Store.state.tabs.map((id) => Store.getPlan(id).name)';
const keyText = `[...document.querySelectorAll('.recovery-key span')].map((s) => s.textContent).join('-')`;
const visible = (sel) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return !!el && !el.closest('[hidden]'); })()`;
const countIn = (db, store) => `new Promise((resolve) => {
    const req = indexedDB.open(${JSON.stringify(db)});
    req.onsuccess = () => { const d = req.result; if (!d.objectStoreNames.contains(${JSON.stringify(store)})) { d.close(); resolve(0); return; }
        const c = d.transaction(${JSON.stringify(store)}).objectStore(${JSON.stringify(store)}).count(); c.onsuccess = () => { d.close(); resolve(c.result); }; };
})`;

/** Tick "I have saved it" and continue, on the setup screen. */
async function finishSetup(js) {
    await js(`document.querySelector('[data-saved]').click(); document.querySelector('.vault-submit').click(); true`);
}

app.whenReady().then(async () => {
    const { createSite, subscriptionEvent } = await import('../test/worker/harness.mjs');
    const site = createSite({ complimentary: '' });
    site.clock.now = Date.now(); // the browser's own clock signs nothing, but keep times sane
    const syncedRows = () => site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM vault_items WHERE data IS NOT NULL').get().n;

    await site.subscribe({ email: 'alice@example.com' });
    const laptopDev = { cookie: await site.signIn('alice@example.com'), seedPlan: oldPlan(), offline: false };
    const phoneDev = { cookie: await site.signIn('alice@example.com'), offline: false };
    const laptopUrl = await deviceServer(site, laptopDev);
    const phoneUrl = await deviceServer(site, phoneDev);

    // ── A browser with plans from before sync ──────────────────────────
    const laptop = openWindow();
    await laptop.win.loadURL(`${laptopUrl}/seed`);
    check('an older build\'s database is there to upgrade', await until(laptop.js, 'document.title === "seeded"'));
    await laptop.win.loadURL(laptopUrl);
    check('the laptop is asked to save a recovery key', await until(laptop.js, visible('.vault-card .recovery-key')));
    const recoveryKey = await laptop.js(keyText);
    await finishSetup(laptop.js);
    check('then opens on its plan from before sync', await until(laptop.js, appReady) && (await laptop.js(names)).join() === 'Plan from before sync');
    check('which is sent, sealed, to the account', await until(laptop.js, 'Store.state.sync === "synced"') && syncedRows() >= 3);
    check('the bar says Synced', await laptop.js(`document.getElementById('titlebar-save').textContent === 'Synced'`));

    // ── A new device ───────────────────────────────────────────────────
    const phone = openWindow();
    await phone.win.loadURL(phoneUrl);
    check('the phone is asked for the recovery key', await until(phone.js, visible('#vault-key')));
    await phone.js(`document.querySelector('#vault-key').value = ${JSON.stringify(recoveryKey)}; document.querySelector('.vault-card form').requestSubmit(); true`);
    check('and opens on the laptop\'s plan, not a blank one', await until(phone.js, appReady) && await until(phone.js, `${names}.join() === 'Plan from before sync'`));

    // ── Changes both ways ──────────────────────────────────────────────
    await laptop.js(`Store.renamePlan(Store.state.activeId, 'Renamed on the laptop'); true`);
    // Sent about two seconds after it is stored.
    await sleep(3000);
    await phone.js(`window.dispatchEvent(new Event('online')); true`);
    check('and appears on the phone', await until(phone.js, `${names}.join() === 'Renamed on the laptop'`));
    check('in the open plan too', await phone.js(`Store.state.plan.name === 'Renamed on the laptop'`));

    await phone.js(`Store.newPlan(); true`);
    await sleep(3000);
    await laptop.js(`window.dispatchEvent(new Event('online')); true`);
    check('a plan made on the phone reaches the laptop', await until(laptop.js, `${names}.length === 2`));
    check('without taking over the plan open there', await laptop.js(`Store.state.plan.name === 'Renamed on the laptop'`));

    // ── A conflict ─────────────────────────────────────────────────────
    const firstId = await laptop.js('Store.state.tabs[0]');
    await phone.js(`Store.openPlan(${JSON.stringify(firstId)}); true`);
    await laptop.js(`Store.renamePlan(${JSON.stringify(firstId)}, 'Laptop name'); true`);
    await sleep(3000);
    await phone.js(`Store.renamePlan(${JSON.stringify(firstId)}, 'Phone name'); true`);
    check('a plan changed on both devices keeps both', await until(phone.js, `${names}.includes('Laptop name') && ${names}.includes('Phone name (this device)')`));
    check('and the phone says what happened', await until(phone.js, `(document.querySelector('.toast') || {}).textContent?.includes('kept as “Phone name (this device)”')`));
    await laptop.js(`window.dispatchEvent(new Event('online')); true`);
    check('the laptop gets the copy too', await until(laptop.js, `${names}.includes('Phone name (this device)')`));

    // ── Offline ────────────────────────────────────────────────────────
    laptopDev.offline = true;
    const errorsBefore = errors.length;
    await laptop.js(`Store.renamePlan(${JSON.stringify(firstId)}, 'Written offline'); true`);
    check('offline, the bar says so and the edit is kept', await until(laptop.js, `document.getElementById('titlebar-save').textContent === 'Offline'`)
        && await laptop.js(`Store.getPlan(${JSON.stringify(firstId)}).name === 'Written offline'`));
    laptopDev.offline = false;
    await laptop.js(`window.dispatchEvent(new Event('online')); true`);
    check('back online, it syncs', await until(laptop.js, `document.getElementById('titlebar-save').textContent === 'Synced'`));
    await phone.js(`window.dispatchEvent(new Event('online')); true`);
    check('and the phone gets the offline edit', await until(phone.js, `${names}.includes('Written offline')`));
    errors.splice(errorsBefore); // the refused connections while "offline" log network errors

    // ── Signing out clears the browser ─────────────────────────────────
    await phone.js(`Settings.open('account'); true`);
    await until(phone.js, visible('[data-account-signout]'));
    await phone.js(`document.querySelector('[data-account-signout]').click(); true`);
    check('signing out leaves for the sign-in page', await until(phone.js, `location.pathname === '/auth/login'`));
    check('with no plans left in the browser', await phone.js(countIn('aventurine-prism', 'plans')) === 0);
    check('and no key', await phone.js(countIn('aventurine-prism-vault', 'keys')) === 0);
    phoneDev.cookie = await site.signIn('alice@example.com');
    await phone.win.loadURL(phoneUrl);
    check('signing back in asks for the recovery key again', await until(phone.js, visible('#vault-key')));
    await phone.js(`document.querySelector('#vault-key').value = ${JSON.stringify(recoveryKey)}; document.querySelector('.vault-card form').requestSubmit(); true`);
    check('and brings every plan back', await until(phone.js, `${names}.length === 3 && ${names}.includes('Written offline')`));

    // ── Another account on the same browser ────────────────────────────
    await site.subscribe({ email: 'bob@example.com', customerId: 'ctm_01bob', subscriptionId: 'sub_01bob' });
    laptopDev.cookie = await site.signIn('bob@example.com');
    await laptop.win.loadURL(laptopUrl);
    check('another account is asked to set up its own key', await until(laptop.js, visible('.vault-card .recovery-key')));
    await finishSetup(laptop.js);
    check('and opens on a blank plan, not the first account\'s', await until(laptop.js, appReady) && (await laptop.js(names)).join() === 'Untitled plan');
    // Its blank plan is sent about two seconds after it is made.
    const planIds = (email) => site.db.sqlite.prepare("SELECT id FROM vault_items WHERE email = ? AND id LIKE 'plan-%'").all(email).map((r) => r.id);
    for (let t = 0; t < 80 && !planIds('bob@example.com').length; t++) await sleep(100);
    await sleep(1000);
    const bobIds = planIds('bob@example.com');
    const aliceIds = new Set(planIds('alice@example.com'));
    check('nothing of the first account reached the second\'s vault', bobIds.length === 1 && !bobIds.some((id) => aliceIds.has(id)));
    if (bobIds.length !== 1) console.log('  the second account\'s plans:', bobIds);
    const alicePlans = site.db.sqlite.prepare("SELECT COUNT(*) AS n FROM vault_items WHERE email = 'alice@example.com' AND id LIKE 'plan-%' AND data IS NOT NULL").get().n;
    check('and the first account\'s plans are still in its own', alicePlans === 3);

    // ── After the subscription ends: the export page ────────────────────
    site.advance(1000); // Paddle's events apply only if newer than the last
    await site.webhook(subscriptionEvent({
        subscriptionId: 'sub_01alice', customerId: 'ctm_01alice', status: 'canceled', type: 'subscription.canceled', at: site.iso(),
    }));
    site.advance(60 * 60 * 1000); // past the three-links-an-hour limit this account has used up
    const exportDev = { cookie: await site.signIn('alice@example.com'), offline: false };
    check('a lapsed account with saved plans can still sign in', !!exportDev.cookie);
    const exportUrl = await deviceServer(site, exportDev);
    const lapsed = openWindow();
    await lapsed.win.loadURL(`${exportUrl}/auth/inactive`);
    check('the inactive page says how long the plans are kept, and offers to export them',
        await until(lapsed.js, visible('#inactive-export')) && await lapsed.js(`document.getElementById('inactive-note').textContent.includes('kept in your account until')`));
    await lapsed.win.loadURL(`${exportUrl}/export`);
    check('the export page asks for the recovery key, and says until when the plans are kept',
        await until(lapsed.js, visible('#export-key')) && await lapsed.js(`document.getElementById('export-note').textContent.includes('kept until')`));
    await lapsed.js(`document.querySelector('#export-key').value = 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH';
        document.getElementById('export-unlock').requestSubmit(); true`);
    check('a wrong key is refused with a reason', await until(lapsed.js, visible('#export-error')));
    await lapsed.js(`document.querySelector('#export-key').value = ${JSON.stringify(recoveryKey)};
        document.getElementById('export-unlock').requestSubmit(); true`);
    check('the right key lists every plan', await until(lapsed.js, `document.querySelectorAll('.export-item').length === 3`));
    await lapsed.js(`window.showSaveFilePicker = async (o) => ({ createWritable: async () => ({
        write: async (t) => { window.__saved = { name: o.suggestedName, head: Array.from(t.slice(0, 4)), size: t.length }; }, close: async () => {} }) });
        window.print = () => { window.__printed = { sections: document.querySelectorAll('.report .report-plan').length,
            charts: document.querySelectorAll('.report svg.report-chart').length, title: document.title };
            window.dispatchEvent(new Event('afterprint')); };
        document.getElementById('export-all').click(); true`);
    check('Download All saves a zip', await until(lapsed.js, `window.__saved && window.__saved.name.endsWith('.zip')
        && window.__saved.head.join() === '80,75,3,4'`));
    await lapsed.js(`document.getElementById('export-report').click(); true`);
    check('the report has a section and two charts per plan', await until(lapsed.js, `window.__printed && window.__printed.sections === 3 && window.__printed.charts === 6`));
    check('and is gone once printed', await lapsed.js(`!document.querySelector('.report') && !document.title.includes('report')`));
    check('the export page keeps no plans and no key in the browser',
        await lapsed.js(countIn('aventurine-prism', 'plans')) === 0 && await lapsed.js(countIn('aventurine-prism-vault', 'keys')) === 0);
    check('and the vault is unchanged', site.db.sqlite.prepare("SELECT COUNT(*) AS n FROM vault_items WHERE email = 'alice@example.com' AND id LIKE 'plan-%' AND data IS NOT NULL").get().n === 3);

    check('no console errors', errors.length === 0);
    if (errors.length) console.log(errors.join('\n'));
    site.restore();
    console.log(failed ? 'FAIL' : 'PASS');
    app.exit(failed ? 1 : 0);
}).catch((e) => {
    console.error(e);
    app.exit(1);
});
