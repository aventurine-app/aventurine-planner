'use strict';

// End-to-end check of the web app in a real Chromium. Electron is used only as
// the browser: the dev server serves the app, a window loads it with NO preload
// bridge (so it behaves as it will in a user's browser), and every assertion
// runs from inside the page. Covers storage in IndexedDB, a reload, a save made
// as the page closes, the one-editing-tab rule, export and import, and the
// Storage preferences, and the navigation's workspaces with the goals they
// share. It also opens the free sandbox (/demo) beside the app and checks its
// limits, its reset, and that it leaves the app's own plans alone. Exits 0 on PASS.
//
//   npm run verify

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { createServer } = require('./dev-server');

// A throwaway profile, so IndexedDB starts empty and the run leaves nothing behind.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-web-verify-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let failed = false;

function check(label, ok) {
    console.log(`${ok ? 'ok ' : 'FAIL'}  ${label}`);
    if (!ok) failed = true;
}

function openWindow(url) {
    const win = new BrowserWindow({
        show: false,
        width: 1440,
        height: 900,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    });
    win.webContents.on('console-message', (e) => {
        if (e.level === 'error') errors.push(e.message);
    });
    const js = (code) => win.webContents.executeJavaScript(code, true);
    return win.loadURL(url).then(() => ({ win, js }));
}

async function until(js, expression, ms = 8000) {
    for (let t = 0; t < ms; t += 100) {
        if (await js(expression)) return true;
        await sleep(100);
    }
    return false;
}

const appReady = '!!(window.Store && Store.state.results)';

/** The free sandbox, opened while `appTab` (the real app) holds the editing lock. */
async function sandbox(url, appTab) {
    const stored = () => appTab.js(`new Promise((resolve, reject) => {
        const open = indexedDB.open('aventurine-prism');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const tx = open.result.transaction(['plans', 'meta']);
            const plans = tx.objectStore('plans').getAll();
            const goals = tx.objectStore('meta').get('goals');
            tx.oncomplete = () => resolve(JSON.stringify({ plans: plans.result.length, goals: goals.result.length }));
        };
    })`).then(JSON.parse);
    const before = await stored();

    const box = await openWindow(`${url}demo`);
    const { js } = box;
    check('the sandbox opens while another tab is editing', await until(js, appReady));
    check('it is the sandbox, with its three limits',
        await js('!!window.PrismDemo && CitrinePlan.LIMITS.nodes === 7 && CitrinePlan.LIMITS.goals === 1 && PrismDemo.LIMITS.plans === 1'));
    check('it starts with one blank plan', await js('Store.state.tabs.length === 1 && Store.state.plan.nodes.length === 0'));
    check('the plan is called Demo Plan and the bar says Demo',
        await js(`Store.state.plan.name === 'Demo Plan' && document.querySelector('.titlebar-name').textContent === 'Aventurine Demo'`));
    check('the bar names it and shows what is left',
        await js(`document.querySelector('.titlebar-user-name').textContent === 'Free demo'
            && document.querySelector('[data-cap="modules"]').textContent.includes('0/7')`));

    // Modules: the example makes five, two more fit, the eighth is refused.
    await js('document.querySelector(\'.canvas-empty [data-act="example"]\').click()');
    check('the example fits', await until(js, 'Store.state.plan.nodes.length === 5'));
    await js('Canvas.addAtCenter("bank-account"); Canvas.addAtCenter("expense"); Canvas.addAtCenter("expense"); true');
    check('a plan holds seven modules and refuses the eighth', await js('Store.state.plan.nodes.length === 7'));
    check('the refusal says why and offers the full app',
        await js(`document.querySelector('.toast span').textContent === 'A plan holds at most 7 modules.'
            && document.querySelector('.toast-action').textContent === 'Get the full app'`));
    check('copying a module past the limit is refused too',
        await js('Store.duplicateNode(Store.state.plan.nodes[0].id) === null && Store.state.plan.nodes.length === 7'));
    check('the meter reaches 7/7', await until(js, `document.querySelector('[data-cap="modules"]').dataset.state === 'full'`));

    // Plans: only the one. Import is refused before any file picker opens.
    await js('Store.newPlan()');
    check('a second plan is refused', await until(js, `document.querySelector('.toast span').textContent === 'You can have at most 1 plan.'`) && await js('Store.state.tabs.length === 1'));
    await js('Store.importPlan()');
    check('importing a plan is refused', await until(js, `document.querySelector('.toast span').textContent === 'Not imported: the sandbox holds one plan.'`));

    // Goals: only the one.
    check('one goal is allowed', await js('Store.addGoal({ name: "First" }) !== null && Store.state.goals.length === 1'));
    check('a second is refused', await js('Store.addGoal({ name: "Second" }) === null && Store.state.goals.length === 1'));
    await js(`document.querySelector('.nav-item[data-go="goals"]').click();
        document.querySelector('.goals-board [data-act="add"]').click(); true`);
    check('and the goal editor will not open for it', await js(`!document.querySelector('.goal-editor')`));

    // A reload keeps the work (the tab's own session), and the app's data is untouched.
    await js('Store.flush()');
    await box.win.webContents.reloadIgnoringCache();
    check('a reload keeps the plan and the goal',
        await until(js, appReady + ' && Store.state.plan.nodes.length === 7 && Store.state.goals.length === 1'));
    const after = await stored();
    check('the full app\'s own plans and goals are untouched', after.plans === before.plans && after.goals === before.goals);

    // Reset clears it.
    await js('Settings.open("account")');
    await js('document.querySelector("[data-sandbox-reset]").click()');
    check('Reset asks first', await until(js, `!!document.querySelector('.modal .button-danger')`));
    await js('document.querySelector(".modal .button-danger").click()');
    check('Reset starts the sandbox again',
        await until(js, appReady + ' && Store.state.plan.nodes.length === 0 && Store.state.goals.length === 0', 10000));
    box.win.destroy();
}

async function main(url) {
    const first = await openWindow(url);
    const { js } = first;
    check('the app boots', await until(js, appReady));

    check('the data bridge is installed', await js('!!window.citrineApi'));
    check('a first visit opens one blank plan', await js('Store.state.tabs.length === 1 && Store.state.plan.nodes.length === 0'));

    // Build something, save it, and look inside IndexedDB itself.
    await js('document.querySelector(\'.canvas-empty [data-act="example"]\').click()');
    check('the example loads', await until(js, 'Store.state.plan.nodes.length === 5'));
    check('Ctrl+S style flush saves', await js('Store.flush()'));
    const stored = JSON.parse(await js(`new Promise((resolve, reject) => {
        const open = indexedDB.open('aventurine-prism');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const tx = open.result.transaction(['plans', 'meta']);
            const plans = tx.objectStore('plans').getAll();
            const tabs = tx.objectStore('meta').get('tabs');
            tx.oncomplete = () => resolve(JSON.stringify({
                nodes: plans.result.map((p) => p.nodes.length), tabs: tabs.result }));
        };
    })`));
    check('IndexedDB holds the plan with its five modules', stored.nodes.length === 1 && stored.nodes[0] === 5);
    check('and the tab order', stored.tabs && stored.tabs.order.length === 1 && stored.tabs.active === stored.tabs.order[0]);

    // A reload brings it all back.
    await first.win.webContents.reloadIgnoringCache();
    check('after a reload the plan is back', await until(js, appReady + ' && Store.state.plan.nodes.length === 5'));

    // An edit made just before the page closes must still be saved.
    await js('Store.renamePlan(Store.state.activeId, "Edited at the last moment")');
    await first.win.webContents.reloadIgnoringCache();
    await until(js, appReady);
    check('an edit made just before a reload was saved',
        await js('Store.state.plan.name === "Edited at the last moment"'));

    // Export goes through the browser's save dialog; hand it a fake one.
    await js(`window.showSaveFilePicker = async (o) => ({ createWritable: async () => ({
        write: async (t) => { window.__saved = { name: o.suggestedName, text: t }; }, close: async () => {} }) });
        true;`);
    await js('Store.exportPlan(Store.state.activeId)');
    const exported = JSON.parse(await js('JSON.stringify(window.__saved || null)'));
    check('export saves a named plan file', exported && exported.name === 'Edited at the last moment.json');
    const file = exported && JSON.parse(exported.text);
    check('that file is the plan, in the readable format', file && file.format === 'citrine-plan' && file.plan.nodes.length === 5);

    // Import reads a file the user picked; hand it that text. It is offered by
    // Add plan, under the list of plans (its only place), so go through that menu.
    await js(`PrismWeb.fileDialogs.open = async () => ${JSON.stringify(exported && exported.text)}; true`);
    await js(`document.querySelector('.nav-add').click();
        [...document.querySelectorAll('.menu-pop .menu-item')].find((b) => b.textContent.trim() === 'Import plan…').click(); true`);
    check('import, from Add plan, adds the plan',
        await until(js, 'Store.state.tabs.length === 2 && Store.state.plan.nodes.length === 5'));
    check('with its own id', await js('new Set(Store.state.tabs).size === 2'));
    await js('Store.flush()');

    // The navigation: each workspace opens on its own, and goals are kept once,
    // for every plan, beside the plans in IndexedDB.
    const showsOnly = (cls) => `[...document.querySelectorAll('.workbench > section')]
        .every((s) => (getComputedStyle(s).display !== 'none') === s.classList.contains('${cls}'))`;
    for (const [go, cls] of [['goals', 'goals-board'], ['analyze', 'outlook'], ['compare', 'compare']]) {
        await js(`document.querySelector('.nav-item[data-go="${go}"]').click()`);
        check(`the navigation opens ${go}`, await until(js, showsOnly(cls)));
    }
    check('Compare lists every plan', await until(js, `document.querySelectorAll('.compare-table tbody tr').length === 2`));
    // Write a goal in the goal editor: net worth at least 25 times yearly expenses by age 65.
    await js(`document.querySelector('.nav-item[data-go="goals"]').click();
        document.querySelector('.goals-board [data-act="add"]').click(); true`);
    check('Add goal opens the goal editor', await until(js, `!!document.querySelector('.goal-editor')`));
    await js(`(() => {
        const f = document.querySelector('.goal-editor');
        f.querySelector('#goal-name').value = 'Retire';
        f.querySelector('[data-unit="times"]').click();
        f.querySelector('[data-due="age"]').click();
        f.querySelector('button[type="submit"]').click();
        return true;
    })()`);
    check('saving closes the editor and lists the goal',
        await until(js, `!document.querySelector('.goal-editor') && document.querySelectorAll('.goals-list .goal-row').length === 1`));
    await js('Store.flush()');
    const goals = JSON.parse(await js(`new Promise((resolve, reject) => {
        const open = indexedDB.open('aventurine-prism');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const req = open.result.transaction('meta').objectStore('meta').get('goals');
            req.onsuccess = () => resolve(JSON.stringify(req.result || []));
        };
    })`));
    check('a goal is stored once, for every plan, as its rule',
        goals.length === 1 && goals[0].name === 'Retire' && goals[0].metric === 'net-worth'
            && goals[0].unit === 'times' && goals[0].value === 25 && goals[0].due === 'age' && goals[0].age === 65);
    // Export: the plan menu's dialog, Download All and the report (printing is faked).
    await js(`window.showSaveFilePicker = async (o) => ({ createWritable: async () => ({
        write: async (t) => { window.__saved = typeof t === 'string' ? { name: o.suggestedName, text: t }
            : { name: o.suggestedName, head: Array.from(t.slice(0, 4)) }; }, close: async () => {} }) });
        window.print = () => { window.__printed = { sections: document.querySelectorAll('.report .report-plan').length,
            charts: document.querySelectorAll('.report svg.report-chart').length, goals: document.querySelectorAll('.report h3').length,
            shownWhenPrinting: getComputedStyle(document.querySelector('.report')).display, title: document.title };
            window.dispatchEvent(new Event('afterprint')); };
        ExportMenu.plan(Store.state.activeId); true`);
    check('Export… offers a report, a spreadsheet and the plan file',
        await until(js, `document.querySelectorAll('.export-choice').length === 3`));
    await js(`document.querySelector('.export-choice[data-format="csv"]').click(); true`);
    check('the spreadsheet saves month by month', await until(js, `window.__saved && window.__saved.name.endsWith('.csv')
        && window.__saved.text.startsWith('\\uFEFFMonth,') && !document.querySelector('.export-choice')`));
    await js(`Settings.open('storage'); document.querySelector('[data-export-all]').click(); true`);
    check('Download All saves a zip', await until(js, `window.__saved && window.__saved.name.endsWith('.zip') && window.__saved.head.join() === '80,75,3,4'`));
    await js(`document.querySelector('[data-export-report]').click(); true`);
    check('the report covers every plan with its charts', await until(js, `window.__printed && window.__printed.sections === 2 && window.__printed.charts === 4`));
    check('it is hidden on screen, and taken away after printing', await js(`window.__printed.shownWhenPrinting === 'none' && !document.querySelector('.report')`));
    await js('UI.closeModal(document.getElementById("prefs")); true');

    await js(`document.querySelector('.nav-plan').click()`);
    check('pressing a plan opens it in the builder', await until(js, showsOnly('builder') + ` && Store.state.workspace === 'plans'`));

    // Preferences → Storage speaks of the browser, not a file.
    await js('Settings.open("storage")');
    check('the Storage tab says whether the browser will keep the plans',
        await until(js, `document.querySelector('[data-persist-desc]').textContent !== 'Checking…'`));
    await js('Settings.open("about"); true');
    check('About shows the build version',
        await until(js, `document.querySelector('[data-app-version]').textContent === ${JSON.stringify(require('./assemble').readVersion())}`));
    await js('UI.closeModal && UI.closeModal(document.getElementById("prefs"))');

    // A second tab must wait for the first.
    const second = await openWindow(url);
    check('a second tab is told another tab is editing',
        await until(second.js, `!document.getElementById('lockscreen').hidden
            && document.querySelector('.lock-title').textContent.includes('another tab')`));
    check('and does not load the plans meanwhile', await second.js('!document.getElementById("app") || document.getElementById("app").hidden'));

    await sandbox(url, first);

    first.win.destroy();
    check('once the first tab closes, the second opens the plans',
        await until(second.js, appReady + ' && Store.state.tabs.length === 2', 10000));
    check('its waiting screen is gone', await second.js('document.getElementById("lockscreen").hidden'));
    check('it sees what the first tab saved',
        await second.js('Store.state.tabs.some((id) => Store.getPlan(id).name === "Edited at the last moment")'));

    second.win.destroy();
    const relevant = errors.filter((m) => !/Autofill|favicon/i.test(m));
    check('no console errors', relevant.length === 0);
    if (relevant.length) console.log(relevant.join('\n'));
}

app.whenReady().then(async () => {
    const server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        await main(`http://127.0.0.1:${server.address().port}/`);
    } catch (e) {
        console.error('FAIL ', e);
        failed = true;
    }
    server.close();
    fs.rmSync(profile, { recursive: true, force: true });
    console.log(failed ? '\nFAILED' : '\nPASS');
    app.exit(failed ? 1 : 0);
});
