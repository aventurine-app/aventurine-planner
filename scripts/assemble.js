'use strict';

// ─── assemble.js ────────────────────────────────────────────────────────────
// Builds an HTML page: a file from pages/ (the app's pages/index.html, or one of
// the sign-in pages in pages/auth/) with each <!-- @include name --> marker
// replaced by pages/partials/name.html. The result is written to a file by
// build.js or sent by dev-server.js.
//
// The app version is written into the page as <meta name="prism-version">.
//
// Every script, stylesheet and icon a page names is given its content's hash
// as a query (`/static/js/app/main.js?v=3f9a…`, versionAssets). The worker
// lets the browser keep such a file for a year without asking again, because
// a change to the file changes its address; the page itself is always fetched
// fresh. So a repeat visit loads the page and nothing else.
//
// The free sandbox page is not a second page to keep in step: assembleDemoPage
// takes the finished app page and swaps a few scripts (see DEMO_* below), so a
// script added to the app is in the sandbox too. The export page
// (assembleExportPage) runs from the same public copy of the scripts.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.resolve(__dirname, '..');
const PAGES_DIR = path.join(APP_ROOT, 'pages');
const PARTIALS_DIR = path.join(PAGES_DIR, 'partials');
const STATIC_DIR = path.join(APP_ROOT, 'static');

const AUTH_DIR = path.join(PAGES_DIR, 'auth');

const INCLUDE_RE = /<!--\s*@include\s+([\w-]+)\s*-->/g;
const DEMO_JS_BASE = '/demo/js/';

/** The app version, from package.json. */
function readVersion() {
    const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));
    return String(pkg.version);
}

const escapeAttr = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The page with its partials spliced in, before its files are versioned.
 *  A missing partial throws, so a bad build fails loudly. */
function assembleSource(page, version) {
    const source = fs.readFileSync(path.join(PAGES_DIR, page), 'utf8');
    const html = source.replace(
        INCLUDE_RE,
        (_, name) => fs.readFileSync(path.join(PARTIALS_DIR, `${name}.html`), 'utf8'),
    );
    return html.replace('</head>', `    <meta name="prism-version" content="${escapeAttr(version)}">\n</head>`);
}

/** The finished page as a string. */
function assemblePage({ page = 'index.html', version = readVersion() } = {}) {
    return versionAssets(assembleSource(page, version));
}

// ── Versioned files ─────────────────────────────────────────────────────────
// The hash of each file's content, as a short hex string, remembered until the
// file changes (the dev server assembles the page on every request).

const ASSET_RE = /((?:src|href)=")(\/(?:static|demo\/js)\/[^"?]+)(")/g;
const HASH_LENGTH = 10;
const hashes = new Map();   // file path → { mtimeMs, hash }

/** The file on disk that a page's `/static/…` or `/demo/js/…` address names. */
function assetFile(urlPath) {
    return urlPath.startsWith(DEMO_JS_BASE)
        ? path.join(STATIC_DIR, 'js', urlPath.slice(DEMO_JS_BASE.length))
        : path.join(STATIC_DIR, urlPath.slice('/static/'.length));
}

/** The first HASH_LENGTH hex digits of the SHA-256 of `file`'s content, or null if it is missing. */
function assetHash(file) {
    let stat;
    try {
        stat = fs.statSync(file);
    } catch {
        return null;
    }
    const known = hashes.get(file);
    if (known && known.mtimeMs === stat.mtimeMs) return known.hash;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, HASH_LENGTH);
    hashes.set(file, { mtimeMs: stat.mtimeMs, hash });
    return hash;
}

/** `html` with each file it names given its content's hash as `?v=`. A file
 *  that does not exist is left as it is, for the build test to catch. */
function versionAssets(html) {
    return html.replace(ASSET_RE, (match, lead, urlPath, tail) => {
        const hash = assetHash(assetFile(urlPath));
        return hash ? `${lead}${urlPath}?v=${hash}${tail}` : match;
    });
}

/** A page address without its version: '/static/js/app/main.js?v=3f9a…' → '/static/js/app/main.js'. */
const unversioned = (urlPath) => urlPath.replace(/\?v=[0-9a-f]+$/, '');

// ── The free sandbox ────────────────────────────────────────────────────────
// The app's page with a different place to keep plans. Its scripts are served
// from /demo/js/ (a copy of static/js made by build.js), because the worker
// keeps /static/js/ for subscribers. CSS, fonts and icons are shared as they are.

// Scripts the sandbox does not use: the editing-tab lock, the account panel
// and the calls behind it.
const DEMO_DROPPED = new Set([
    'web/session.js', 'web/json-client.js', 'web/account-api.js', 'shell/account.js',
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

    let html = assembleSource('index.html', version).replace(SCRIPT_RE, (tag, indent, file) => {
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

    html = replaceOnce(html, '<title>Aventurine</title>', '<title>Aventurine - Free Demo</title>');
    html = replaceOnce(html, '<link rel="stylesheet" href="/static/css/compare.css">', '<link rel="stylesheet" href="/static/css/compare.css">\n    <link rel="stylesheet" href="/static/css/demo.css">');
    return versionAssets(html);
}

// ── The export page ─────────────────────────────────────────────────────────
// Where someone whose subscription has ended takes their plans away
// (pages/export.html). Like the sandbox it is public and runs the public copy
// of the scripts, so its /static/js/ paths are pointed at /demo/js/; theme-init
// stays, as on every page.

/** The export page, as a string. */
function assembleExportPage({ version = readVersion() } = {}) {
    return versionAssets(assembleSource('export.html', version).replace(SCRIPT_RE, (tag, indent, file) => (
        DEMO_SHARED.has(file) || file.startsWith('auth/') ? tag : `${indent}<script src="${DEMO_JS_BASE}${file}"></script>\n`
    )));
}

/** The names of the sign-in pages (login, confirm, inactive), from pages/auth/. */
function authPageNames() {
    return fs.readdirSync(AUTH_DIR).filter((f) => f.endsWith('.html')).map((f) => f.slice(0, -'.html'.length)).sort();
}

module.exports = {
    assemblePage, assembleDemoPage, assembleExportPage, authPageNames, readVersion, versionAssets, unversioned, assetFile,
    DEMO_JS_BASE, APP_ROOT, STATIC_DIR,
};
