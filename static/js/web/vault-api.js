'use strict';

// ─── vault-api.js ───────────────────────────────────────────────────────────
// The browser's side of the worker's /api/vault routes (worker/src/vault.js).
// Everything sent through here is already sealed by vault-crypto.js.
//
// Every call resolves { status, body } and never throws (json-client.js):
// status 0 means the server could not be reached (offline, timed out, or a
// reply that was not JSON, as from the local dev server, which has no vault).
//
// Dual-environment: window.PrismWeb.createVaultApi in the page, CommonJS for
// tests, which pass a fake `fetch`.

(function (root, factory) {
    const isNode = typeof module === 'object' && module.exports;
    const { createJsonClient } = isNode ? require('./json-client.js') : root.PrismWeb;
    const api = factory(createJsonClient);
    if (isNode) module.exports = api;
    else root.PrismWeb = Object.assign(root.PrismWeb || {}, api);
}(typeof self !== 'undefined' ? self : this, function (createJsonClient) {

    function createVaultApi({ fetch, timeoutMs } = {}) {
        const request = createJsonClient({ ...(fetch ? { fetch } : {}), ...(timeoutMs ? { timeoutMs } : {}) });

        return {
            /** { email, vault: { id, wrappedKey, keyVersion, seq } | null } */
            getVault: () => request('GET', '/api/vault'),
            /** { items: [{ id, version, seq, data, updatedAt }], cursor, more } */
            pull: (vaultId, since) =>
                request('GET', `/api/vault/items?vault=${encodeURIComponent(vaultId)}&since=${since}`),
            /** 200 { item: { version } }, or 409 { error: 'conflict', current } / { error: 'vault_changed' } */
            push: (id, { vaultId, baseVersion, data }) =>
                request('PUT', `/api/vault/items/${encodeURIComponent(id)}`, { vaultId, baseVersion, data }),
            createVault: (wrappedKey) => request('PUT', '/api/vault', { wrappedKey, baseKeyVersion: 0 }),
            replaceKey: ({ vaultId, wrappedKey, baseKeyVersion }) =>
                request('PUT', '/api/vault', { vaultId, wrappedKey, baseKeyVersion }),
            eraseVault: (vaultId) => request('DELETE', '/api/vault', { vaultId }),
        };
    }

    return { createVaultApi };
}));
