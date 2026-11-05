'use strict';

// ─── storage.js ─────────────────────────────────────────────────────────────
// IndexedDB behind workspace.js. Three object stores:
//
//   plans   one record per plan, keyed by plan id
//   meta    'tabs': { order, active }, the plans' order in the navigation
//           'goals': [goal], the goals every plan is measured against
//   sync    encrypted sync's bookkeeping (web/sync.js), keyed by id:
//             an item ('plan-<id>', 'goals', 'tabs'): { id, version, dirty, base }
//               version  the vault's version of it this device last had
//               dirty    a token while it has changes not yet sent, else null
//               base     the goals as last synced (for merging), goals only
//             ':binding': { email, vaultId, cursor }, whose vault this is
//
// `write` puts, deletes and updates the order and goals in ONE transaction, so
// a crash can never leave a plan without its place in the order, or the reverse.
// It marks the items it changed unsent (`dirty`, with `token`) in that same
// transaction, so a change can never be stored without being queued for sync.
// Browser only; tests use an in-memory stand-in with the same methods
// (test/memory-storage.js).

(function () {
    const DB_NAME = 'aventurine-prism';
    const DB_VERSION = 2;
    const TABS_KEY = 'tabs';
    const GOALS_KEY = 'goals';
    const BINDING_KEY = ':binding';

    /** Resolve with a request's result, reject with its error. */
    function result(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /** Resolve when a transaction commits, reject if it fails. */
    function committed(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('the write was aborted'));
        });
    }

    function openDatabase(factory) {
        return new Promise((resolve, reject) => {
            const request = factory.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = (e) => {
                const db = request.result;
                if (e.oldVersion < 1) {
                    db.createObjectStore('plans', { keyPath: 'id' });
                    db.createObjectStore('meta');
                }
                if (e.oldVersion < 2) db.createObjectStore('sync', { keyPath: 'id' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('the plans database is blocked by another tab'));
        });
    }

    /** Read-modify-write one sync record inside `store`'s transaction. */
    function amend(store, id, change) {
        const read = store.get(id);
        read.onsuccess = () => store.put(change(read.result || { id, version: 0, dirty: null }));
    }

    /** Open (creating or upgrading if needed) the plans database. */
    async function openIndexedDb(factory = indexedDB) {
        const db = await openDatabase(factory);
        // A newer build in another tab wants to upgrade: step aside.
        db.onversionchange = () => db.close();

        async function load() {
            const tx = db.transaction(['plans', 'meta'], 'readonly');
            const [plans, meta, goals] = await Promise.all([
                result(tx.objectStore('plans').getAll()),
                result(tx.objectStore('meta').get(TABS_KEY)),
                result(tx.objectStore('meta').get(GOALS_KEY)),
            ]);
            // No goals record at all (not even an empty one) means they were never shared yet.
            return { plans, meta: meta || null, goals: goals === undefined ? null : goals };
        }

        /** Apply { put: [plan], remove: [id], meta, goals, dirty: [itemId], token }
         *  atomically. The transaction is created before this returns, so
         *  callers may fire and forget. */
        function write({ put = [], remove = [], meta = null, goals = null, dirty = [], token = null }) {
            const tx = db.transaction(['plans', 'meta', 'sync'], 'readwrite');
            const plans = tx.objectStore('plans');
            for (const plan of put) plans.put(plan);
            for (const id of remove) plans.delete(id);
            if (meta) tx.objectStore('meta').put(meta, TABS_KEY);
            if (goals) tx.objectStore('meta').put(goals, GOALS_KEY);
            const sync = tx.objectStore('sync');
            for (const id of dirty) amend(sync, id, (rec) => ({ ...rec, dirty: token }));
            return committed(tx);
        }

        /** { binding, items }: whose vault this is, and every item's record. */
        async function loadSync() {
            const records = await result(db.transaction('sync', 'readonly').objectStore('sync').getAll());
            return {
                binding: records.find((r) => r.id === BINDING_KEY) || null,
                items: records.filter((r) => r.id !== BINDING_KEY),
            };
        }

        /**
         * Record what a sync did, in one transaction. Each of `items` is
         * { id, version, base?, clearIf? }: the version is set, `base` replaced
         * when given, and the item marked sent only if its dirty token is still
         * `clearIf` (a change made meanwhile stays queued). `binding` replaces
         * the binding; `reset` first forgets every item (a new vault).
         */
        function updateSync({ items = [], binding = null, reset = false }) {
            const tx = db.transaction('sync', 'readwrite');
            const sync = tx.objectStore('sync');
            if (reset) sync.clear();
            for (const { id, version, base, clearIf } of items) {
                amend(sync, id, (rec) => ({
                    ...rec,
                    version,
                    base: base === undefined ? rec.base : base,
                    dirty: clearIf !== undefined && rec.dirty === clearIf ? null : rec.dirty,
                }));
            }
            if (binding) sync.put({ ...binding, id: BINDING_KEY });
            return committed(tx);
        }

        /** Forget everything: the plans, the order, the goals and the sync records. */
        function wipe() {
            const tx = db.transaction(['plans', 'meta', 'sync'], 'readwrite');
            for (const name of ['plans', 'meta', 'sync']) tx.objectStore(name).clear();
            return committed(tx);
        }

        return { load, write, loadSync, updateSync, wipe };
    }

    window.PrismWeb = Object.assign(window.PrismWeb || {}, { openIndexedDb });
}());
