# Aventurine Planner

A private financial outlook simulator that runs in your browser, from the makers
of Aventurine.

Build a plan on a canvas: drop in modules for income, accounts, spending, debts
and the things that change money on the way through (a budget group, a
tax), link them together, pick a time horizon, and see where the money ends up
month by month.

The navigation on the left holds four workspaces:

- **Plans** lists every plan; opening one shows the builder, with the modules
  across the top and a net worth scrubber under the canvas.
- **Goals** sets the goals every plan is measured against. Each is a rule
  ("Net worth is at least 25 × yearly expenses by age 65"), written in a goal
  editor, and the page shows how far toward each one a plan gets by its
  deadline, and when every plan meets it.
- **Analyze** charts one plan: its headline figures, net worth (flagging each
  goal it reaches), cash flow, a Sankey and tables, in each month's money or
  adjusted for inflation.
- **Compare** puts two plans side by side (net worth over the run, and what
  each spends, earns, owes and pays in tax), then ranks every plan.

Your plans are yours alone. The browser keeps a working copy, and they sync to
your account end-to-end encrypted, under a recovery key only you hold, so the
server never sees them readable. Aventurine Planner does not connect to your
bank. Any plan exports as a PDF report, a spreadsheet (CSV) or a plan file.

## Run it

```bash
npm install
npm start          # http://127.0.0.1:5174, no build step; reload to see edits
```

## Check it

```bash
npm test           # simulator, plan rules, browser backend, build (node --test)
npm run lint
npm run build      # writes the deployable app to dist/
npm run worker:smoke   # the sign-in, billing and access worker, in Cloudflare's local runtime
npm run verify     # drives a real Chromium through the whole app
npm run verify:sync    # two devices and the export page, in Chromium, against the real worker
```

`npm run verify` uses Electron only as a Chromium to drive; it is not part of
the app. It checks storage in IndexedDB, a reload, a save made as the page
closes, the one-editing-tab rule, export and import, and the Storage
preferences.

## How it fits together

The app is plain HTML, CSS and JavaScript served as written, with no bundler.
Its design system is Ant Design's (tokens, components, light and dark themes),
rebuilt in the app's own stylesheets.
Everything it reads or saves goes through `window.citrineApi.request(method,
url, body)`, which `static/js/web/` answers from IndexedDB. Encrypted sync
copies the plans, sealed in the browser, to the account in the background; the
server never sees them readable.

| File (`static/js/web/`) | Job |
|---|---|
| `api-error.js` | The error type a handler throws; becomes `{ status, body }` |
| `plan-files.js` | The exported plan files (one plan, or every plan and the goals): format, parsing, file names (pure) |
| `exports.js` | The other files to take plans away in: a plan's CSV, the goals CSV, and Download All's zip (pure) |
| `session.js` | One editing tab at a time, using a Web Lock |
| `storage.js` | IndexedDB: one record per plan, plus the tab order, written atomically |
| `workspace.js` | The plans in memory, mirrored to storage; validation and limits |
| `backend.js` | The URL map: routes requests to the workspace |
| `file-dialogs.js` | Save and open a plan file with the browser's dialogs |
| `boot.js` | Wires the above together and installs `window.citrineApi` |
| `vault-crypto.js` | Encrypted sync: recovery keys, the data key and wrapping it, sealing each plan (WebCrypto, AES-GCM) |
| `vault-api.js` | The worker's `/api/vault` routes, as calls that never throw |
| `vault-keys.js` | This device's copy of each vault's data key, in its own IndexedDB database |
| `vault-session.js` | Set up, unlock, replace the recovery key, start over; the states the screens show |
| `sync.js` | Sync with the vault: marks local changes unsent, pulls then pushes, settles conflicts; `readVault` for the export page |

`api-error`, `plan-files`, `session`, `workspace`, `backend`, `vault-crypto`,
`vault-api` and `vault-session` also `require()` under Node, which is how they
are tested without a browser (`test/worker/vault-client.test.mjs` runs the
vault code against the real worker). `storage`, `vault-keys`, `file-dialogs` and
`boot` need browser APIs and are covered by `npm run verify`.

The screens for encrypted sync (save the recovery key, enter it on a new
device, start over, and Preferences → Account → New Recovery Key) are
`shell/vault-gate.js`. They run before the plans load. With no server to ask
(offline, or `npm start`, which has no vault) the app opens on this browser
alone, and sync catches up once it can (`sync.js`, wired in by `boot.js`).

### Exports

A plan's menu has **Export…**: a PDF report, a spreadsheet (CSV) of every
month, or the plan file (JSON). Preferences → Storage → Export has **Download
All** (a zip: every plan as one JSON file that imports again, the goals as a
CSV and a CSV per plan) and a report of every plan.

- The report (`shell/report.js`, `css/report.css`) is a page laid out for
  print, with SVG charts, and the browser's print dialog saves it as a PDF.
  That keeps any script in a plan's name and the real fonts, and needs no PDF
  library (the CSP allows no outside script).
- The figures it and the CSV show come from `sim/summary.js`, which Analyze
  uses too, so they agree.
- `/export` (`pages/export.html`, `shell/export-page.js`) is for someone whose
  subscription has ended: the worker still lets them sign in and read (not
  change) their vault for the 60 days it is kept, and this page opens it with
  their recovery key and offers the same downloads. It saves nothing in the
  browser and runs from the public copy of the scripts (`/demo/js/`).

### Decisions worth knowing

- **Writes start in the same tick as the request.** A save made while the page
  is closing cannot be awaited, but a started IndexedDB transaction still
  commits. Nothing in `backend.js` or `workspace.js` may `await` before it
  starts a write or opens a file picker (a picker needs the click that asked).
- **One editing tab.** Each tab loads every plan and writes back what it
  changes, so two tabs would overwrite each other. A second tab waits, then
  loads the plans only after the first closes, so it sees the final saves.
- **No encryption at rest on the device.** Anyone who can read the browser
  profile can read the plans, as with any web app's local data. What leaves the
  device is encrypted; signing out clears the plans and the key from the browser.
- **Sync never loses an edit.** Each change is marked unsent in the transaction
  that stores it, and each send names the version it replaces. A plan changed
  on two devices keeps both (the second as "<name> (this device)"; at the plan
  limit the later edit wins); goals merge goal by goal; an edit beats a
  deletion. A browser that held another account's plans clears them before it
  loads. `test/worker/sync.test.mjs` runs two devices against the real worker;
  `npm run verify:sync` does the same in Chromium.
- **Unreadable stored plans are left alone.** A plan that fails validation
  (saved by a newer build) is counted but never rewritten or deleted.
- **Bodies are copied** (`structuredClone`) at the backend boundary, so the page
  and the workspace never share an object.
- **Legacy names.** The plan file format is `citrine-plan` and the data bridge is
  `citrineApi`, from before the product was named Prism. Plan files exported
  from the earlier desktop app still import.

## The free sandbox

`/demo` is the real app with a different place to keep plans, for anyone to try
without signing in: one plan, seven modules, one goal. Nothing is saved on the
device: the plan lives in memory, mirrored to the tab's `sessionStorage` so a
reload keeps it, and Preferences → Free Demo can reset it. Export works, so a
visitor can take their plan into the full app; import does not.

It is derived, not forked. `assembleDemoPage` (`scripts/assemble.js`) takes the
app's page and swaps a few scripts for those in `static/js/demo/`; the build
copies `static/js` to `dist/demo/js`, because the worker keeps `/static/js/` for
subscribers. `npm start` serves it at http://127.0.0.1:5174/demo.

| File | What it does |
|---|---|
| `demo/limits.js` | The caps, by lowering `CitrinePlan.LIMITS` (modules, goals) and setting `window.PrismDemo`; the app reads that for its "Get the full app" button |
| `demo/storage.js` | The sandbox's storage: memory plus `sessionStorage`, never IndexedDB |
| `demo/boot.js` | Replaces `web/boot.js`: no editing-tab lock, `maxPlans: 1`, import refused |
| `demo/sandbox.js` | The limits meter and button in the top bar, Preferences → Free Demo, reset |

The caps are enforced twice: the editor refuses at the limit (`Store.limitReached`),
and the backend refuses to save a plan or goal list over it.

## Accounts and billing

Access is a paid subscription, handled by one Cloudflare Worker (`worker/`):
sign in by emailed link, Paddle webhooks say who has paid, and the app's page
and scripts are only sent to an active subscriber. Plans reach the server only
as ciphertext (`/api/vault`), and the browser holds the only key. The one
public exception to the subscription is the free sandbox at `/demo` (above). See [`worker/README.md`](worker/README.md) for how it works, how to run
it locally (`npm run worker:dev`, `npm run worker:smoke`) and how to set up
Cloudflare, Resend and Paddle.

## Not built yet

The website's pricing buttons (Paddle.js checkout) that lead people here.

## License

GPL-3.0-or-later. Icons: [Phosphor](https://phosphoricons.com) (MIT). Fonts:
Manrope and IBM Plex Mono (SIL Open Font License).
