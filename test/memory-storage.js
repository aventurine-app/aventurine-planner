'use strict';

// An in-memory stand-in for static/js/web/storage.js (same methods), so the
// workspace, backend and sync are tested without a browser. It records every
// write at the moment write() is CALLED, which lets a test check that a save
// starts in the same tick as the request.

const BINDING_KEY = ':binding';

function createMemoryStorage({ plans = [], meta = null, goals = null } = {}) {
    const records = new Map(plans.map((p) => [p.id, structuredClone(p)]));
    let tabs = meta && structuredClone(meta);
    let shared = goals && structuredClone(goals);
    const sync = new Map();

    const amend = (id, change) => sync.set(id, change(sync.get(id) || { id, version: 0, dirty: null }));

    const storage = {
        writes: [],
        /** Set to an Error to make the next write reject with it. */
        failNext: null,

        async load() {
            return {
                plans: [...records.values()].map((p) => structuredClone(p)),
                meta: tabs && structuredClone(tabs),
                goals: shared && structuredClone(shared),
            };
        },

        write(change) {
            storage.writes.push(change);
            if (storage.failNext) {
                const error = storage.failNext;
                storage.failNext = null;
                return Promise.reject(error);
            }
            for (const p of change.put || []) records.set(p.id, structuredClone(p));
            for (const id of change.remove || []) records.delete(id);
            if (change.meta) tabs = structuredClone(change.meta);
            if (change.goals) shared = structuredClone(change.goals);
            for (const id of change.dirty || []) amend(id, (rec) => ({ ...rec, dirty: change.token }));
            return Promise.resolve();
        },

        async loadSync() {
            const all = [...sync.values()].map((r) => structuredClone(r));
            return { binding: all.find((r) => r.id === BINDING_KEY) || null, items: all.filter((r) => r.id !== BINDING_KEY) };
        },

        async updateSync({ items = [], binding = null, reset = false }) {
            if (reset) sync.clear();
            for (const { id, version, base, clearIf } of items) {
                amend(id, (rec) => ({
                    ...rec,
                    version,
                    base: base === undefined ? rec.base : structuredClone(base),
                    dirty: clearIf !== undefined && rec.dirty === clearIf ? null : rec.dirty,
                }));
            }
            if (binding) sync.set(BINDING_KEY, { ...structuredClone(binding), id: BINDING_KEY });
        },

        async wipe() {
            records.clear();
            tabs = null;
            shared = null;
            sync.clear();
        },

        /** What is stored right now. */
        snapshot: () => ({ plans: [...records.values()], meta: tabs, goals: shared, sync: new Map(sync) }),
    };
    return storage;
}

module.exports = { createMemoryStorage };
