// ─── ESLint flat config ──────────────────────────────────────────────────────
// Dev-only static analysis; nothing here affects what ships (the app has no
// bundler). Run with `npm run lint`. One config covers both worlds:
//
//   static/js/**   Classic browser <script>s sharing one global scope. Every
//                  cross-file name is listed in `appGlobals` below, so the list
//                  documents the real cross-file API and anything unlisted
//                  stays an error.
//   scripts/**, test/**
//                  CommonJS under Node (build, dev server, tests).
//   worker/**      ES modules on Cloudflare Workers (sign-in, Paddle, access control).
//   test/worker/** ES modules under Node (the worker's tests).

import js from '@eslint/js';
import globals from 'globals';

// Each is defined in exactly one file, attached with `window.X = X`.
const appGlobals = {
    // core/
    escapeHtml: 'readonly',     // escape.js
    Prefs: 'readonly',          // prefs.js
    Fmt: 'readonly',            // format.js
    iconSvg: 'readonly',        // icons.js (data from the generated icon-data.js)
    api: 'readonly',            // api.js
    // sim/ (also require()d by the backend and the tests)
    CitrineCatalog: 'readonly',
    CitrinePlan: 'readonly',
    CitrineEngine: 'readonly',
    CitrineGoals: 'readonly',
    CitrineSummary: 'readonly', // summary.js (a run's figures, for Analyze and the exports)
    // shell/
    UI: 'readonly',             // ui.js
    Components: 'readonly',     // components.js (Ant Design's display components, as HTML)
    Settings: 'readonly',       // settings.js
    Account: 'readonly',        // account.js
    VaultGate: 'readonly',      // vault-gate.js (encrypted sync's screens)
    Report: 'readonly',         // report.js (the PDF report, printed)
    authPost: 'readonly',       // auth/common.js (the public sign-in pages)
    // app/
    Describe: 'readonly',
    CitrineExample: 'readonly',
    Store: 'readonly',
    Runs: 'readonly',           // app/runs.js
    ExportMenu: 'readonly',     // app/export-menu.js
    Nav: 'readonly',            // app/nav.js
    Canvas: 'readonly',
    Inspector: 'readonly',
    Chart: 'readonly',
    Sankey: 'readonly',
    Outlook: 'readonly',
    OtherTab: 'readonly',
    // web/ (the browser backend; each file adds its parts to this one object)
    PrismWeb: 'readonly',
    // the data bridge installed by static/js/web/boot.js (demo/boot.js in the sandbox)
    citrineApi: 'readonly',
    // the free sandbox (static/js/demo/): its limits, and its reset
    PrismDemo: 'readonly',
    PrismSandbox: 'readonly',
};

export default [
    {
        ignores: [
            'dist/**',
            '**/node_modules/**',
            '.scratch/**',
            '.scratch-shot/**',
            'static/js/core/icon-data.js',
        ],
    },

    js.configs.recommended,

    {
        rules: {
            'no-var': 'error',
            'prefer-const': ['error', { destructuring: 'all' }],
            eqeqeq: ['error', 'always', { null: 'ignore' }],
            'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
            'no-empty': ['error', { allowEmptyCatch: true }],
        },
    },

    {
        files: ['static/js/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'script',
            globals: { ...globals.browser, ...appGlobals },
        },
    },

    // The simulation core and the browser backend's logic are dual-environment:
    // classic scripts that also module.exports themselves for Node.
    {
        files: ['static/js/sim/*.js', 'static/js/web/*.js', 'static/js/demo/storage.js'],
        languageOptions: { globals: { module: 'readonly', require: 'readonly' } },
    },

    {
        files: ['worker/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            // Workers run on web-standard APIs (fetch, crypto, Response), not Node's.
            globals: { ...globals.serviceworker, console: 'readonly' },
        },
    },

    {
        files: ['test/worker/**/*.mjs', 'scripts/**/*.mjs'],
        languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: globals.node },
    },

    {
        files: ['scripts/**/*.js', 'test/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: globals.node,
        },
    },

    {
        files: ['eslint.config.mjs'],
        languageOptions: { sourceType: 'module', globals: globals.node },
    },
];
