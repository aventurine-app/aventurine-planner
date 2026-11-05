'use strict';

// ─── boot.js (free sandbox) ─────────────────────────────────────────────────
// Takes the place of web/boot.js. It installs the same window.citrineApi, but
// the plans live in demo/storage.js and:
//
//   - there is no editing-tab lock: the sandbox keeps nothing on the device
//     that a second tab could overwrite, and it must not hold up (or be held
//     up by) the full app open in another tab;
//   - the workspace holds one plan (PrismDemo.LIMITS.plans);
//   - importing a plan file is refused before the file picker opens, because
//     it would add a second plan. Exporting works, so a visitor can take
//     their plan into the full app.
//
// Until the workspace has loaded, requests wait. PrismSandbox.reset forgets
// the sandbox's data, for the "Reset sandbox" button (demo/sandbox.js).

(function () {
    const { ApiError, createWorkspace, createBackend, createSandboxStorage, fileDialogs } = window.PrismWeb;

    const UNAVAILABLE = { status: 503, body: { ok: false, error: 'storage unavailable' } };

    const storage = createSandboxStorage();
    const files = {
        save: fileDialogs.save,
        open: async () => { throw new ApiError('the sandbox holds one plan', 409); },
    };

    let backend = null;
    const ready = (async () => {
        const workspace = createWorkspace({ storage, maxPlans: window.PrismDemo.LIMITS.plans });
        await workspace.init();
        backend = createBackend({ workspace, files });
        return backend;
    })();
    ready.catch((e) => console.error('[sandbox] the plans could not be opened:', e));

    /** A request that arrives before the workspace has loaded. */
    async function whenReady(method, url, body) {
        try {
            const loaded = await ready;
            return loaded.dispatch(method, url === '/api/ready' ? '/api/status' : url, body);
        } catch {
            return UNAVAILABLE;
        }
    }

    // Once loaded, dispatch is called with no await in front of it, so a save
    // made as the page closes starts in the same tick as the request.
    window.citrineApi = Object.freeze({
        request: (method, url, body) => (backend ? backend.dispatch(method, url, body) : whenReady(method, url, body)),
    });

    window.PrismSandbox = Object.freeze({ reset: () => storage.reset() });
}());
