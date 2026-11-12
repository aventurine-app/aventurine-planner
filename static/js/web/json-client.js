'use strict';

// ─── json-client.js ─────────────────────────────────────────────────────────
// One way to call this site's own /api routes from the app: a JSON request on
// the same origin, with the session cookie, that never throws.
//
//   const call = createJsonClient();
//   const { status, body } = await call('GET', '/api/me');
//
// Every call resolves { status, body }. Status 0 means the server could not
// be reached: offline, timed out, or an answer that was not JSON (as from the
// local dev server, which has no /api). Behind vault-api.js (the encrypted
// plans) and account-api.js (who is signed in, billing, sign-out).
//
// Dual-environment: window.PrismWeb.createJsonClient in the page, CommonJS
// for tests, which pass a fake `fetch`.

(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PrismWeb = Object.assign(root.PrismWeb || {}, api);
}(typeof self !== 'undefined' ? self : this, function () {

    const TIMEOUT_MS = 15000;
    const UNREACHABLE = Object.freeze({ status: 0, body: { ok: false, error: 'unreachable' } });

    function createJsonClient({ fetch = (...a) => globalThis.fetch(...a), timeoutMs = TIMEOUT_MS } = {}) {
        /** `body` undefined sends no body; anything else is sent as JSON. */
        return async function call(method, path, body) {
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
        };
    }

    return { createJsonClient };
}));
