'use strict';

// ─── vault-keys.js ──────────────────────────────────────────────────────────
// This device's copy of each vault's data key, so the recovery key is needed
// only once per device. One record per vault, keyed by the vault's id:
//
//   { vaultId, keyVersion, dataKey: CryptoKey, savedAt }
//
// IndexedDB stores the CryptoKey object itself (browsers clone keys natively),
// in a database of its own, apart from the plans ('aventurine-prism'), so the
// plans' schema never has to change for it and the free sandbox, which must
// never open the app's databases, has no reason to load this file.
//
// Browser only; tests use an in-memory stand-in with the same three methods.

(function () {
    const DB_NAME = 'aventurine-prism-vault';
    const DB_VERSION = 1;
    const STORE = 'keys';

    function result(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function open(factory) {
        return new Promise((resolve, reject) => {
            const request = factory.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'vaultId' });
            request.onsuccess = () => {
                const db = request.result;
                db.onversionchange = () => db.close();
                resolve(db);
            };
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('the key database is blocked by another tab'));
        });
    }

    /** The key store. Opens the database on first use. */
    function openVaultKeys(factory = indexedDB) {
        let opened = null;
        const db = () => (opened ??= open(factory));

        /** One request in its own transaction; resolves once the transaction has committed. */
        async function run(mode, fn) {
            const tx = (await db()).transaction(STORE, mode);
            const committed = new Promise((resolve, reject) => {
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('the key transaction was aborted'));
            });
            const [value] = await Promise.all([result(fn(tx.objectStore(STORE))), committed]);
            return value;
        }

        return {
            get: async (vaultId) => (await run('readonly', (s) => s.get(vaultId))) ?? null,
            put: (record) => run('readwrite', (s) => s.put({ ...record, savedAt: Date.now() })),
            remove: (vaultId) => run('readwrite', (s) => s.delete(vaultId)),
        };
    }

    window.PrismWeb = Object.assign(window.PrismWeb || {}, { openVaultKeys });
}());
