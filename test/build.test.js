'use strict';

// The assembled page and the built folder: nothing the page asks for is missing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { assemblePage, assembleDemoPage, authPageNames, STATIC_DIR } = require('../scripts/assemble');
const { build } = require('../scripts/build');

const page = assemblePage({ version: '9.9.9' });

test('every include marker is replaced and the version is written into the page', () => {
    assert.ok(!/@include/.test(page));
    assert.ok(page.includes('<meta name="prism-version" content="9.9.9">'));
    assert.ok(page.includes('Content-Security-Policy'));
});

test('a version cannot break out of the meta tag', () => {
    const html = assemblePage({ version: '"><script>x</script>' });
    assert.ok(!html.includes('<script>x</script>'));
});

test('every /static file the page names exists', () => {
    const refs = [...page.matchAll(/(?:src|href)="(\/static\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 20);
    for (const ref of refs) {
        assert.ok(fs.existsSync(path.join(STATIC_DIR, ref.slice('/static/'.length))), `${ref} is missing`);
    }
});

test('the browser backend loads after the plan rules it uses and before the app that calls it', () => {
    const scripts = [...page.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
    const at = (name) => scripts.indexOf(`/static/js/${name}`);
    for (const dep of ['sim/plan.js', 'web/api-error.js', 'web/plan-files.js', 'web/backend.js', 'web/file-dialogs.js']) {
        assert.ok(at(dep) >= 0, `${dep} is not loaded`);
    }
    assert.ok(at('sim/plan.js') < at('web/workspace.js'));
    assert.ok(at('web/api-error.js') < at('web/plan-files.js'));
    assert.ok(at('web/plan-files.js') < at('web/backend.js'));
    assert.ok(at('web/boot.js') > at('web/file-dialogs.js'));
    assert.ok(at('web/boot.js') < at('app/main.js'));
});

test('the page runs no inline script, as its CSP requires', () => {
    assert.ok([...page.matchAll(/<script\b[^>]*>/g)].every((m) => /\bsrc="/.test(m[0])));
});

test('a build holds the page and the app files, without the unused icon set', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-web-'));
    try {
        build({ outDir: out });
        assert.ok(fs.existsSync(path.join(out, 'index.html')));
        assert.ok(fs.existsSync(path.join(out, 'static', 'js', 'web', 'boot.js')));
        assert.ok(fs.existsSync(path.join(out, 'static', 'css', 'style.css')));
        assert.ok(!fs.existsSync(path.join(out, 'static', 'icons', 'Phosphor')));
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }
});

test('the sign-in pages are built, and need only files the worker serves to anyone', async () => {
    const { isPublicAsset } = await import('../worker/src/index.js');
    const names = authPageNames();
    assert.deepEqual(names, ['confirm', 'inactive', 'login', 'privacy']);
    for (const name of names) {
        const html = assemblePage({ page: `auth/${name}.html`, version: '9.9.9' });
        assert.ok(!/@include/.test(html), name);
        assert.ok([...html.matchAll(/<script\b[^>]*>/g)].every((m) => /\bsrc="/.test(m[0])), `${name} has an inline script`);
        const refs = [...html.matchAll(/(?:src|href)="(\/static\/[^"]+)"/g)].map((m) => m[1]);
        assert.ok(refs.length > 5, name);
        for (const ref of refs) {
            assert.ok(fs.existsSync(path.join(STATIC_DIR, ref.slice('/static/'.length))), `${name}: ${ref} is missing`);
            assert.ok(isPublicAsset(ref), `${name} loads ${ref}, which the worker would keep behind sign-in`);
        }
    }
});

test('no file the worker serves to anyone holds app code', () => {
    const publicJs = fs.readdirSync(path.join(STATIC_DIR, 'js', 'auth'));
    assert.deepEqual(publicJs.sort(), ['common.js', 'confirm.js', 'dot-wave.js', 'inactive.js', 'login.js', 'privacy.js']);
    for (const f of publicJs) {
        const code = fs.readFileSync(path.join(STATIC_DIR, 'js', 'auth', f), 'utf8');
        assert.ok(!/CitrinePlan|CitrineEngine|Store\.|citrineApi/.test(code), `${f} reaches into the app`);
    }
});

test('a build holds the sign-in pages', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-web-'));
    try {
        build({ outDir: out });
        for (const name of ['login', 'confirm', 'inactive', 'privacy']) assert.ok(fs.existsSync(path.join(out, 'auth', `${name}.html`)), name);
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }
});

// ── The free sandbox ───────────────────────────────────────────────────────

const demoPage = assembleDemoPage({ version: '9.9.9' });
const demoScripts = [...demoPage.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);

test('the sandbox page loads only its own copy of the app, plus the one shared pre-paint script', () => {
    assert.ok(!/@include/.test(demoPage));
    assert.ok([...demoPage.matchAll(/<script\b[^>]*>/g)].every((m) => /\bsrc="/.test(m[0])), 'an inline script');
    const outside = demoScripts.filter((src) => !src.startsWith('/demo/js/'));
    assert.deepEqual(outside, ['/static/js/shell/theme-init.js']);
    assert.ok(demoScripts.length > 30);
});

// The app's own storage, lock, account and encrypted sync: none of it runs in the sandbox.
const NOT_IN_SANDBOX = [
    'web/session.js', 'web/storage.js', 'web/boot.js', 'shell/account.js',
    'web/vault-crypto.js', 'web/vault-api.js', 'web/vault-keys.js', 'web/vault-session.js', 'web/sync.js',
    'shell/vault-gate.js',
];

test('the sandbox swaps the app\'s storage and lock for its own, and keeps the rest in the same order', () => {
    const at = (name) => demoScripts.indexOf(`/demo/js/${name}`);
    for (const gone of NOT_IN_SANDBOX) assert.equal(at(gone), -1, gone);
    for (const kept of ['demo/limits.js', 'demo/storage.js', 'demo/boot.js', 'demo/sandbox.js']) assert.ok(at(kept) >= 0, kept);
    assert.ok(at('sim/plan.js') < at('demo/limits.js'), 'the limits change plan.js, so they follow it');
    assert.ok(at('demo/limits.js') < at('web/workspace.js'));
    assert.ok(at('demo/storage.js') < at('demo/boot.js'));
    assert.ok(at('demo/boot.js') > at('web/file-dialogs.js'));
    assert.ok(at('demo/limits.js') < at('app/store.js'), 'the app reads PrismDemo when it starts');
    assert.ok(at('app/titlebar.js') < at('demo/sandbox.js') && at('demo/sandbox.js') < at('app/main.js'));
    // Everything else the app page loads is still loaded.
    const appScripts = [...page.matchAll(/<script src="\/static\/js\/([^"]+)"/g)].map((m) => m[1]);
    for (const file of appScripts) {
        if (NOT_IN_SANDBOX.includes(file) || file === 'shell/theme-init.js') continue;
        assert.ok(at(file) >= 0, `${file} is missing from the sandbox`);
    }
});

test('every file the sandbox page names exists, and the worker serves it to anyone', async () => {
    const { isPublicAsset } = await import('../worker/src/index.js');
    const refs = [...demoPage.matchAll(/(?:src|href)="(\/(?:static|demo)\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.length > 40);
    for (const ref of refs) {
        const file = ref.startsWith('/demo/js/')
            ? path.join(STATIC_DIR, 'js', ref.slice('/demo/js/'.length))
            : path.join(STATIC_DIR, ref.slice('/static/'.length));
        assert.ok(fs.existsSync(file), `${ref} is missing`);
        assert.ok(isPublicAsset(ref), `${ref} would be kept behind sign-in`);
    }
});

test('a build holds the sandbox page and a copy of the scripts, without the sign-in ones', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-web-'));
    try {
        build({ outDir: out });
        assert.ok(fs.existsSync(path.join(out, 'demo', 'index.html')));
        assert.ok(fs.existsSync(path.join(out, 'demo', 'js', 'demo', 'boot.js')));
        assert.ok(fs.existsSync(path.join(out, 'demo', 'js', 'app', 'store.js')));
        assert.ok(!fs.existsSync(path.join(out, 'demo', 'js', 'auth')));
        // The sandbox page is the one a build wrote, and the app's own page is untouched.
        assert.ok(fs.readFileSync(path.join(out, 'index.html'), 'utf8').includes('/static/js/web/boot.js'));
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }
});

// ── The export page ────────────────────────────────────────────────────────

test('the export page runs from the public copy of the scripts, never the app\'s gated ones', async () => {
    const { assembleExportPage } = require('../scripts/assemble');
    const { isPublicAsset } = await import('../worker/src/index.js');
    const html = assembleExportPage({ version: '9.9.9' });
    assert.ok(!/@include/.test(html));
    assert.ok([...html.matchAll(/<script\b[^>]*>/g)].every((m) => /\bsrc="/.test(m[0])), 'an inline script');
    const refs = [...html.matchAll(/(?:src|href)="(\/(?:static|demo)\/[^"]+)"/g)].map((m) => m[1]);
    assert.ok(refs.some((r) => r === '/demo/js/shell/export-page.js'));
    for (const ref of refs) {
        const file = ref.startsWith('/demo/js/')
            ? path.join(STATIC_DIR, 'js', ref.slice('/demo/js/'.length))
            : path.join(STATIC_DIR, ref.slice('/static/'.length));
        assert.ok(fs.existsSync(file), `${ref} is missing`);
        assert.ok(isPublicAsset(ref), `${ref} would be kept behind sign-in`);
    }
    // It reads the vault but keeps nothing: no app storage, lock or sync engine started.
    for (const gone of ['web/storage.js', 'web/session.js', 'web/boot.js', 'web/vault-session.js']) {
        assert.ok(!html.includes(gone), gone);
    }
});

test('a build holds the export page', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-web-'));
    try {
        build({ outDir: out });
        assert.ok(fs.existsSync(path.join(out, 'export', 'index.html')));
    } finally {
        fs.rmSync(out, { recursive: true, force: true });
    }
});
