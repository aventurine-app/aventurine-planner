'use strict';

// ─── assemble.js ────────────────────────────────────────────────────────────
// Builds an HTML page: a file from pages/ (the app's pages/index.html, or one of
// the sign-in pages in pages/auth/) with each <!-- @include name --> marker
// replaced by pages/partials/name.html. The result is written to a file by
// build.js or sent by dev-server.js.
//
// The app version is written into the page as <meta name="prism-version"> so
// Preferences → About can show it.
//
// The free sandbox page is not a second page to keep in step: assembleDemoPage
// takes the finished app page and swaps a few scripts (see DEMO_* below), so a
// script added to the app is in the sandbox too. The export page
// (assembleExportPage) runs from the same public copy of the scripts.

const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const PAGES_DIR = path.join(APP_ROOT, 'pages');
const PARTIALS_DIR = path.join(PAGES_DIR, 'partials');
const STATIC_DIR = path.join(APP_ROOT, 'static');

const AUTH_DIR = path.join(PAGES_DIR, 'auth');

const INCLUDE_RE = /<!--\s*@include\s+([\w-]+)\s*-->/g;

/** The app version, from package.json. */
function readVersion() {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
    return String(pkg.version);
}

const escapeAttr = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The finished page as a string. A missing partial throws, so a bad build fails loudly. */
function assemblePage({ page = 'index.html', version = readVersion() } = {}) {
    const source = fs.readFileSync(path.join(PAGES_DIR, page), 'utf8');
    const html = source.replace(
        INCLUDE_RE,
        (_, name) => fs.readFileSync(path.join(PARTIALS_DIR, `${name}.html`), 'utf8'),
    );
    return html.replace('</head>', `    <meta name="prism-version" content="${escapeAttr(version)}">\n</head>`);
}

// ── The free sandbox ────────────────────────────────────────────────────────
// The app's page with a different place to keep plans. Its scripts are served
// from /demo/js/ (a copy of static/js made by build.js), because the worker
// keeps /static/js/ for subscribers. CSS, fonts and icons are shared as they are.

const DEMO_JS_BASE = '/demo/js/';

// Scripts the sandbox does not use: the editing-tab lock and the account panel.
const DEMO_DROPPED = new Set([
    'web/session.js', 'shell/account.js',
    // Encrypted sync: the sandbox keeps its one plan in memory and has no account.
    'web/vault-crypto.js', 'web/vault-api.js', 'web/vault-keys.js', 'web/vault-session.js', 'web/sync.js',
    'shell/vault-gate.js',
]);
// Scripts the sandbox replaces with its own, in the same place in the order.
const DEMO_REPLACED = { 'web/storage.js': 'demo/storage.js', 'web/boot.js': 'demo/boot.js' };
// Scripts the sandbox adds: { file: the script it follows ('after') or precedes ('before') }.
const DEMO_ADDED = [
    { file: 'demo/limits.js', after: 'sim/plan.js' },
    { file: 'demo/sandbox.js', before: 'app/main.js' },
];
// Files the page keeps loading from /static/, because the sign-in pages need them too.
const DEMO_SHARED = new Set(['shell/theme-init.js']);

const SCRIPT_RE = /^([ \t]*)<script src="\/static\/js\/([^"]+)"><\/script>\r?\n/gm;

/** Replace `from` with `to` in `html`, or throw: a marker that has moved must fail the build. */
function replaceOnce(html, from, to) {
    if (!html.includes(from)) throw new Error(`the sandbox page could not find ${from}`);
    return html.replace(from, () => to);
}

/** The free sandbox's page, as a string. */
function assembleDemoPage({ version = readVersion() } = {}) {
    const added = new Set();
    const scriptTag = (indent, file) => `${indent}<script src="${DEMO_JS_BASE}${file}"></script>\n`;

    let html = assemblePage({ version }).replace(SCRIPT_RE, (tag, indent, file) => {
        if (DEMO_SHARED.has(file)) return tag;
        if (DEMO_DROPPED.has(file)) return '';
        let out = scriptTag(indent, DEMO_REPLACED[file] || file);
        for (const add of DEMO_ADDED) {
            if (add.before === file) out = scriptTag(indent, add.file) + out;
            if (add.after === file) out += scriptTag(indent, add.file);
            if (add.before === file || add.after === file) added.add(add.file);
        }
        return out;
    });

    // Every swap must have found its place, or the sandbox would silently run the real backend.
    for (const add of DEMO_ADDED) if (!added.has(add.file)) throw new Error(`the sandbox page could not place ${add.file}`);
    for (const file of Object.values(DEMO_REPLACED)) if (!html.includes(`${DEMO_JS_BASE}${file}`)) throw new Error(`the sandbox page could not place ${file}`);

    html = replaceOnce(html, '<title>Aventurine Planner</title>', '<title>Aventurine Planner | Free Demo</title>');
    html = replaceOnce(html, '<link rel="stylesheet" href="/static/css/compare.css">', '<link rel="stylesheet" href="/static/css/compare.css">\n    <link rel="stylesheet" href="/static/css/demo.css">');
    return html;
}

// ── The export page ─────────────────────────────────────────────────────────
// Where someone whose subscription has ended takes their plans away
// (pages/export.html). Like the sandbox it is public and runs the public copy
// of the scripts, so its /static/js/ paths are pointed at /demo/js/; theme-init
// stays, as on every page.

/** The export page, as a string. */
function assembleExportPage({ version = readVersion() } = {}) {
    return assemblePage({ page: 'export.html', version }).replace(SCRIPT_RE, (tag, indent, file) => (
        DEMO_SHARED.has(file) || file.startsWith('auth/') ? tag : `${indent}<script src="${DEMO_JS_BASE}${file}"></script>\n`
    ));
}

/** The names of the sign-in pages (login, confirm, inactive), from pages/auth/. */
function authPageNames() {
    return fs.readdirSync(AUTH_DIR).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -'.html'.length)).sort();
}

module.exports = { assemblePage, assembleDemoPage, assembleExportPage, authPageNames, readVersion, DEMO_JS_BASE, APP_ROOT, STATIC_DIR };
