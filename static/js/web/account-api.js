'use strict';

// ─── account-api.js ─────────────────────────────────────────────────────────
// The worker's account routes (worker/src/index.js), as calls that never
// throw: who is signed in, the billing portal, and signing out. Every part of
// the page that needs them comes here (the top bar, Preferences → Account,
// the export page), so there is one place that knows the routes and one
// answer to "who am I" per page load.
//
//   me()                  { email, access, subscription, complimentary }, 200;
//                         401 signed out; 0 no server (the local dev server).
//                         The answer is kept for the page's life; me({ fresh:
//                         true }) asks again (Preferences, which may follow a
//                         billing change). A failure is never kept.
//   billingPortal()       { url }: Paddle's customer portal link
//   logout()              ends the session; the kept answer is forgotten
//
// Every call resolves { status, body } (json-client.js). Dual-environment:
// window.PrismWeb.AccountApi in the page, CommonJS for tests, which pass a
// fake `fetch` to createAccountApi.

(function (root, factory) {
    const isNode = typeof module === 'object' && module.exports;
    const { createJsonClient } = isNode ? require('./json-client.js') : root.PrismWeb;
    const api = factory(createJsonClient);
    if (isNode) module.exports = api;
    else root.PrismWeb = Object.assign(root.PrismWeb || {}, api, { AccountApi: api.createAccountApi() });
}(typeof self !== 'undefined' ? self : this, function (createJsonClient) {

    function createAccountApi({ fetch } = {}) {
        const call = createJsonClient(fetch ? { fetch } : {});
        let known = null;   // the answer to me() being kept, as a promise

        async function me({ fresh = false } = {}) {
            if (!fresh && known) return known;
            const asked = call('GET', '/api/me');
            known = asked;
            const answer = await asked;
            // Only a definite answer is worth keeping: a server that could not
            // be reached, or failed, is asked again next time.
            if (known === asked && (answer.status === 0 || answer.status >= 500)) known = null;
            return answer;
        }

        function logout() {
            known = null;
            return call('POST', '/api/auth/logout', {});
        }

        return {
            me,
            logout,
            billingPortal: () => call('POST', '/api/billing/portal', {}),
        };
    }

    return { createAccountApi };
}));
