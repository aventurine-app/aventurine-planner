'use strict';

// ─── vault-session.js ───────────────────────────────────────────────────────
// Where this device stands with the account's encrypted vault, and the four
// things that change it. No UI here (that is shell/vault-gate.js), so every
// path can be tested against the real worker.
//
//   check()            → one of these states:
//       unavailable    no server to ask (offline, local dev, signed out): carry on locally
//       setup          the account has no vault yet
//       locked         it has one, and this device does not hold its key
//       ready          this device holds the key: { vault, dataKey, email }
//
//   prepareSetup()             a new recovery key, shown BEFORE anything is
//                              stored; commit() creates the vault
//   unlock(typedKey)           open the vault on this device
//   prepareNewKey(ready)       replace a lost recovery key from a device that
//                              still holds the data key; commit() stores it
//   startOver(vault)           erase the vault (its plans cannot be opened
//                              without the key), so setup can begin again
//
// The recovery key is shown and confirmed before the vault is created or the
// key replaced, so there is never a vault whose key nobody saw. When another
// device or tab changed the vault first, the server refuses (409) and these
// return a fresh check() instead of overwriting it.
//
// Dual-environment: window.PrismWeb.createVaultSession in the page, CommonJS
// for tests. `api` is vault-api.js; `keys` is vault-keys.js or a stand-in.

(function (root, factory) {
    const isNode = typeof module === 'object' && module.exports;
    const VaultCrypto = isNode ? require('./vault-crypto.js') : root.PrismWeb.VaultCrypto;
    const api = factory(VaultCrypto);
    if (isNode) module.exports = api;
    else root.PrismWeb = Object.assign(root.PrismWeb || {}, api);
}(typeof self !== 'undefined' ? self : this, function (VaultCrypto) {

    /** A failure talking to the server. `code`: 'offline' | 'server' | 'conflict'. */
    class VaultError extends Error {
        constructor(code, message) {
            super(message);
            this.name = 'VaultError';
            this.code = code;
        }
    }

    const failure = (r) => new VaultError(r.status === 0 ? 'offline' : 'server', `the vault request failed (${r.status})`);
    const succeeded = (r) => r.status === 200 && r.body && r.body.ok === true;

    function createVaultSession({ api, keys, crypto = VaultCrypto }) {
        // The account the server last answered for. Sync ties this browser's
        // plans to it, so another account signing in here never receives them.
        let email = null;

        const ready = (vault, dataKey) => ({ state: 'ready', vault, dataKey, email });

        async function check() {
            const r = await api.getVault();
            if (!succeeded(r)) {
                const reason = { 0: 'unreachable', 401: 'signed-out', 403: 'no-access' }[r.status] || 'server';
                return { state: 'unavailable', reason };
            }
            // Without access the server still lets the account read its vault
            // (the export page), but the app does not open it.
            if (r.body.access === false) return { state: 'unavailable', reason: 'no-access' };
            email = r.body.email;
            const vault = r.body.vault;
            if (!vault) return { state: 'setup' };
            const saved = await keys.get(vault.id);
            if (!saved) return { state: 'locked', vault };
            // A new recovery key made elsewhere wraps the same data key: keep it, note the version.
            if (saved.keyVersion !== vault.keyVersion) await keys.put({ ...saved, keyVersion: vault.keyVersion });
            return ready(vault, saved.dataKey);
        }

        async function prepareSetup() {
            const recovery = crypto.createRecoveryKey();
            const dataKey = await crypto.createDataKey();
            const wrappedKey = await crypto.wrapDataKey(dataKey, recovery.bytes);
            return {
                recoveryKey: recovery.text,
                async commit() {
                    const r = await api.createVault(wrappedKey);
                    if (r.status === 409) return check();
                    if (!succeeded(r)) throw failure(r);
                    const vault = r.body.vault;
                    await keys.put({ vaultId: vault.id, keyVersion: vault.keyVersion, dataKey });
                    return ready(vault, dataKey);
                },
            };
        }

        /**
         * Open the vault with a typed recovery key. A typo fails before any
         * request (VaultCryptoError 'format'); a different key fails with
         * 'wrong-key'. The vault is fetched fresh, so a key replaced on
         * another device a moment ago still works.
         */
        async function unlock(typedKey) {
            const bytes = crypto.parseRecoveryKey(typedKey);
            const current = await check();
            if (current.state === 'unavailable') throw new VaultError('offline', 'the vault could not be reached');
            if (current.state !== 'locked') return current;
            const dataKey = await crypto.unwrapDataKey(current.vault.wrappedKey, bytes);
            await keys.put({ vaultId: current.vault.id, keyVersion: current.vault.keyVersion, dataKey });
            return ready(current.vault, dataKey);
        }

        async function prepareNewKey({ vault, dataKey }) {
            const recovery = crypto.createRecoveryKey();
            const wrappedKey = await crypto.wrapDataKey(dataKey, recovery.bytes);
            return {
                recoveryKey: recovery.text,
                async commit() {
                    const r = await api.replaceKey({ vaultId: vault.id, wrappedKey, baseKeyVersion: vault.keyVersion });
                    if (r.status === 409 || r.status === 404) {
                        throw new VaultError('conflict', 'the recovery key was changed on another device');
                    }
                    if (!succeeded(r)) throw failure(r);
                    const next = r.body.vault;
                    await keys.put({ vaultId: next.id, keyVersion: next.keyVersion, dataKey });
                    return ready(next, dataKey);
                },
            };
        }

        async function startOver(vault) {
            const r = await api.eraseVault(vault.id);
            if (r.status === 409) return check();
            if (!succeeded(r)) throw failure(r);
            await keys.remove(vault.id);
            return { state: 'setup' };
        }

        return { check, prepareSetup, unlock, prepareNewKey, startOver };
    }

    return { createVaultSession, VaultError };
}));
