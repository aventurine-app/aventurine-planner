'use strict';

// ─── vault-api.js ───────────────────────────────────────────────────────────
// The browser's side of the worker's /api/vault routes (worker/src/vault.js).
// Everything sent through here is already sealed by vault-crypto.js.
//
// Every call resolves { status, body } and never throws: status 0 means the
// server could not be reached (offline, timed out, or a reply that was not
// JSON, as from the local dev server, which has no vault).
//
// Dual-environment: window.PrismWeb.createVaultApi in the page, CommonJS for
// tests, which pass a fake `fetch`.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PrismWeb = Object.assign(root.PrismWeb || {}, api);
}(typeof self !== 'undefined' ? self : this, function () {

    const TIMEOUT_MS = 15000;
    const UNREACHABLE = Object.freeze({ status: 0, body: { ok: false, error: 'unreachable' } });

    function createVaultApi({ fetch = (...a) => globalThis.fetch(...a), timeoutMs = TIMEOUT_MS } = {}) {

        async function request(method, path, body) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await fetch(path, {
                    method,
                    credentials: 'same-origin',
                    signal: controller.signal,
                    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
                    body: body === undefined ? undefined : JSON.stringify(body),
                });
                const type = response.headers.get('Content-Type') || '';
                if (!type.includes('application/json')) return UNREACHABLE;
                return { status: response.status, body: await response.json() };
            } catch {
                return UNREACHABLE;
            } finally {
                clearTimeout(timer);
            }
        }

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
