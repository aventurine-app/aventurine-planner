'use strict';

// ─── build.js ───────────────────────────────────────────────────────────────
// Writes the deployable app to dist/:
//
//   index.html   the app's page (assemble.js)
//   auth/        the sign-in pages: login.html, confirm.html, inactive.html
//   static/      the app's CSS, JS, fonts and icons, as they are
//   demo/        the free sandbox: index.html, and js/, a copy of static/js
//                (without the sign-in scripts) that the worker serves to anyone
//   export/      index.html: the export page for lapsed subscribers, which
//                runs from demo/js/ too
//
// There is no bundling or minifying: the app is plain scripts served as
// written. Run it with `npm run build`.

const fs = require('fs');
const path = require('path');
const { assemblePage, assembleDemoPage, assembleExportPage, authPageNames, readVersion, APP_ROOT, STATIC_DIR } = require('./assemble');

const DIST_DIR = path.join(APP_ROOT, 'dist');

// Not referenced by the app (icons are inlined from core/icon-data.js).
const SKIPPED = new Set([path.join('icons', 'Phosphor')]);

function build({ outDir = DIST_DIR } = {}) {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'index.html'), assemblePage());
    fs.mkdirSync(path.join(outDir, 'auth'));
    for (const name of authPageNames()) {
        fs.writeFileSync(path.join(outDir, 'auth', `${name}.html`), assemblePage({ page: `auth/${name}.html` }));
    }
    fs.cpSync(STATIC_DIR, path.join(outDir, 'static'), {
        recursive: true,
        filter: (src) => !SKIPPED.has(path.relative(STATIC_DIR, src)),
    });
    buildDemo(outDir);
    fs.mkdirSync(path.join(outDir, 'export'));
    fs.writeFileSync(path.join(outDir, 'export', 'index.html'), assembleExportPage());
}

/** The free sandbox: its page, and the scripts it loads from /demo/js/. */
function buildDemo(outDir) {
    const demoDir = path.join(outDir, 'demo');
    fs.mkdirSync(demoDir);
    fs.writeFileSync(path.join(demoDir, 'index.html'), assembleDemoPage());
    // The sign-in scripts are not part of the sandbox.
    const authJs = path.join(STATIC_DIR, 'js', 'auth');
    fs.cpSync(path.join(STATIC_DIR, 'js'), path.join(demoDir, 'js'), {
        recursive: true,
        filter: (src) => src !== authJs,
    });
}

function sizeOf(dir) {
    let files = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
        if (!entry.isFile()) continue;
        files += 1;
        bytes += fs.statSync(path.join(entry.parentPath, entry.name)).size;
    }
    return { files, bytes };
}

if (require.main === module) {
    build();
    const { files, bytes } = sizeOf(DIST_DIR);
    console.log(`Built Aventurine Planner ${readVersion()} to ${DIST_DIR}: ${files} files, ${(bytes / 1024).toFixed(0)} KB`);
}

module.exports = { build, DIST_DIR };
