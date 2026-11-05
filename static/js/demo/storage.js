'use strict';

// ─── storage.js (free sandbox) ──────────────────────────────────────────────
// Where the sandbox keeps its one plan and goal. It has the same two methods
// as web/storage.js (`load` and `write`), so workspace.js cannot tell them
// apart, but it is meant to be thrown away:
//
//   - the data lives in memory and is mirrored to sessionStorage, so a reload
//     keeps the visitor's work and closing the tab ends it;
//   - nothing is written to IndexedDB, so the sandbox never touches the plans
//     of someone who also uses the full app on this site.
//
// If sessionStorage is unavailable (a private window, blocked site data) or
// full, the sandbox carries on from memory alone and says so in the console.
//
// Dual-environment: window.PrismWeb.createSandboxStorage in the page, CommonJS
// for tests, which pass a fake `session`.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PrismWeb = Object.assign(root.PrismWeb || {}, api);
}(typeof self !== 'undefined' ? self : this, function () {

    const STORAGE_KEY = 'aventurine-planner-sandbox';

    /** sessionStorage, or null where the browser refuses it (it can throw on access). */
    function browserSession() {
        try {
            return typeof sessionStorage === 'undefined' ? null : sessionStorage;
        } catch {
            return null;
        }
    }

    /**
     * @param {{ session?: Storage|null, logger?: Console }} [options]
     * @returns {{ load(): Promise<object>, write(change: object): Promise<void>, reset(): void }}
     */
    function createSandboxStorage({ session = browserSession(), logger = console } = {}) {
        // plans: id → plan. meta and goals are null until first written, as in
        // web/storage.js (no goals record at all means "never shared yet").
        let held = { plans: {}, meta: null, goals: null };

        function restore() {
            if (!session) return;
            try {
                const text = session.getItem(STORAGE_KEY);
                if (text) held = { ...held, ...JSON.parse(text) };
            } catch (e) {
                logger.warn('[sandbox] the saved sandbox could not be read, starting fresh:', e);
                held = { plans: {}, meta: null, goals: null };
            }
        }

        function mirror() {
            if (!session) return;
            try {
                session.setItem(STORAGE_KEY, JSON.stringify(held));
            } catch (e) {
                logger.warn('[sandbox] the sandbox could not be kept for a reload:', e);
            }
        }

        restore();

        return {
            async load() {
                return structuredClone({ plans: Object.values(held.plans), meta: held.meta, goals: held.goals });
            },

            /** Apply { put, remove, meta, goals } as web/storage.js does. The
             *  change is applied before this returns, so callers may fire and forget. */
            write({ put = [], remove = [], meta = null, goals = null }) {
                for (const plan of put) held.plans[plan.id] = structuredClone(plan);
                for (const id of remove) delete held.plans[id];
                if (meta) held.meta = structuredClone(meta);
                if (goals) held.goals = structuredClone(goals);
                mirror();
                return Promise.resolve();
            },

            /** Forget everything, including the copy kept for a reload. */
            reset() {
                held = { plans: {}, meta: null, goals: null };
                if (!session) return;
                try {
                    session.removeItem(STORAGE_KEY);
                } catch (e) {
                    logger.warn('[sandbox] the saved sandbox could not be cleared:', e);
                }
            },
        };
    }

    return { createSandboxStorage, SANDBOX_STORAGE_KEY: STORAGE_KEY };
}));
