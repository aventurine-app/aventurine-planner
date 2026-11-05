'use strict';

// ─── boot.js ────────────────────────────────────────────────────────────────
// Installs window.citrineApi.request(method, url, body), which core/api.js
// calls for everything the app reads or saves. Order of events:
//
//   1. claim the editing-tab lock (session.js)
//   2. once held, open IndexedDB, and wait for encrypted sync to be settled
//      (main.js passes on what shell/vault-gate.js found: PrismWeb.beginSync)
//   3. if another account's plans are here, clear them; load the plans
//      (storage.js, workspace.js), every write marked for sync (sync.js)
//   4. sync once before answering, so a new device opens on its plans
//      rather than a blank one; then keep syncing in the background
//   5. answer requests through the router (backend.js)
//
// Until the plans are loaded, requests wait. Two answers are given early:
//   GET /api/status   says "busy" if another tab is editing, so the app can
//                     show its waiting screen instead of hanging
//   GET /api/ready    waits until this tab has the plans, for that screen
//
// Also PrismWeb.signOutSync(), for Preferences → Account → Sign Out.

(function () {
    const {
        claimEditor, openIndexedDb, openVaultKeys, createWorkspace, createBackend, fileDialogs,
        createSync, trackChanges, claimStorage, createVaultApi, MAX_PLANS,
    } = window.PrismWeb;

    const BUSY_STATUS = { storage: 'browser', busy: true };
    const UNAVAILABLE = { status: 503, body: { ok: false, error: 'storage unavailable' } };
    // The first sync may hold the app back this long; past it, the app opens
    // on what this browser has and the sync carries on.
    const FIRST_SYNC_MS = 8000;
    const PUSH_DELAY_MS = 2000;   // after an edit is stored
    const POLL_MS = 60000;        // while the tab is in view

    let backend = null;
    let raw = null;               // the IndexedDB storage, unwrapped
    let sync = null;
    let syncVaultId = null;
    let decide;
    const decided = new Promise((resolve) => { decide = resolve; });
    const claimed = claimEditor(navigator.locks);

    /**
     * What to sync with, from the gate's state: the vault and key it opened,
     * or (offline) the vault this browser last synced with, if this device
     * still holds its key. Null: no sync this session.
     */
    async function syncContext(gate) {
        if (!gate) return null;
        if (gate.state === 'ready') {
            if (await claimStorage(raw, gate.email)) console.warn('[sync] another account\'s plans were cleared from this browser');
            return { email: gate.email, vault: gate.vault, dataKey: gate.dataKey };
        }
        if (gate.state !== 'unavailable' || gate.reason !== 'unreachable') return null;
        const { binding } = await raw.loadSync();
        const saved = binding && await openVaultKeys().get(binding.vaultId);
        return saved ? { email: binding.email, vault: { id: binding.vaultId }, dataKey: saved.dataKey } : null;
    }

    let pushTimer = null;
    function syncSoon() {
        clearTimeout(pushTimer);
        pushTimer = setTimeout(() => sync.syncNow(), PUSH_DELAY_MS);
    }

    function startSync(workspace, context) {
        syncVaultId = context.vault.id;
        sync = createSync({
            storage: raw, workspace, api: createVaultApi(), maxPlans: MAX_PLANS,
            hooks: {
                flushPage: () => (window.Store ? Store.flush() : Promise.resolve(true)),
                // The page gets copies, as from any backend call.
                onRemote: (change) => { if (window.Store) Store.applyRemote(structuredClone(change)); },
                onStatus: (status, detail) => { if (window.Store) Store.setSync(status, detail); },
            },
        });
        window.addEventListener('online', () => sync.syncNow());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') sync.syncNow();
        });
        setInterval(() => { if (document.visibilityState === 'visible') sync.syncNow(); }, POLL_MS);
        // A failure here must not keep the plans from opening: they are in this browser.
        const first = sync.start(context).catch((e) => console.error('[sync] could not start:', e));
        return Promise.race([first, new Promise((resolve) => { setTimeout(resolve, FIRST_SYNC_MS); })]);
    }

    async function open() {
        const claim = await claimed;
        await claim.acquired;
        raw = await openIndexedDb();
        const context = await syncContext(await decided);
        const storage = trackChanges(raw, { onWrite: () => { if (sync) syncSoon(); } });
        const workspace = createWorkspace({ storage });
        await workspace.init();
        if (context) await startSync(workspace, context);
        backend = createBackend({ workspace, files: fileDialogs });
        return backend;
    }

    const ready = open();
    ready.catch((e) => console.error('[boot] the plans could not be opened:', e));

    /** Requests that arrive before the plans are loaded. */
    async function whenReady(method, url, body) {
        const claim = await claimed;
        if (method === 'GET' && url === '/api/status' && !claim.owned) {
            return { status: 200, body: BUSY_STATUS };
        }
        try {
            const loaded = await ready;
            return loaded.dispatch(method, url === '/api/ready' ? '/api/status' : url, body);
        } catch {
            return UNAVAILABLE;
        }
    }

    /**
     * Before signing out: send what is unsent, then clear this browser's plans
     * and its key, since they are safe in the vault. Resolves { unsent: true }
     * (and clears nothing) if something could not be sent, unless `force`.
     * Without sync this session, the plans stay: they are only here.
     */
    async function signOutSync({ force = false } = {}) {
        if (!sync) return { cleared: false };
        await sync.syncNow();
        if (!force && await sync.hasUnsent()) return { unsent: true };
        sync.stop();
        clearTimeout(pushTimer);
        await raw.wipe();
        await openVaultKeys().remove(syncVaultId);
        return { cleared: true };
    }

    window.citrineApi = Object.freeze({
        request: (method, url, body) => (backend ? backend.dispatch(method, url, body) : whenReady(method, url, body)),
    });
    window.PrismWeb = Object.assign(window.PrismWeb, {
        /** Called once by main.js with VaultGate.ensure()'s state (null: no sync). */
        beginSync: (gate) => decide(gate),
        signOutSync,
    });
}());
