'use strict';

// The account calls: one answer to "who am I" per page, asked again only when
// wanted or when the last answer was no answer.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAccountApi } = require('../static/js/web/account-api.js');

/** A fetch that answers each path from `answers` and counts the calls. */
function fakeFetch(answers) {
    const calls = [];
    const fetch = async (path, init) => {
        calls.push({ path, method: init.method, body: init.body });
        const next = answers[path];
        const answer = typeof next === 'function' ? next() : next;
        if (answer === 'down') throw new TypeError('failed to fetch');
        if (answer === 'html') return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } });
        return Response.json(answer.body, { status: answer.status });
    };
    return { fetch, calls };
}

test('me() asks once and keeps the answer; fresh asks again', async () => {
    const { fetch, calls } = fakeFetch({ '/api/me': { status: 200, body: { ok: true, email: 'alice@example.com' } } });
    const account = createAccountApi({ fetch });
    const first = await account.me();
    const second = await account.me();
    assert.equal(first.status, 200);
    assert.equal(second.body.email, 'alice@example.com');
    assert.equal(calls.length, 1, 'one request for two askers');
    await account.me({ fresh: true });
    assert.equal(calls.length, 2);
});

test('two askers at once share one request', async () => {
    const { fetch, calls } = fakeFetch({ '/api/me': { status: 200, body: { ok: true, email: 'a@b.co' } } });
    const account = createAccountApi({ fetch });
    const [a, b] = await Promise.all([account.me(), account.me()]);
    assert.equal(a.body.email, b.body.email);
    assert.equal(calls.length, 1);
});

test('a signed-out answer is kept, but no answer is asked again', async () => {
    let up = false;
    const { fetch, calls } = fakeFetch({ '/api/me': () => (up ? { status: 401, body: { ok: false, error: 'signed_out' } } : 'down') });
    const account = createAccountApi({ fetch });
    assert.equal((await account.me()).status, 0);
    assert.equal((await account.me()).status, 0, 'asked again');
    assert.equal(calls.length, 2);
    up = true;
    assert.equal((await account.me()).status, 401);
    assert.equal((await account.me()).status, 401);
    assert.equal(calls.length, 3, 'a definite answer is kept');
});

test('the local dev server, which answers with a page, counts as no server', async () => {
    const { fetch } = fakeFetch({ '/api/me': 'html' });
    assert.equal((await createAccountApi({ fetch }).me()).status, 0);
});

test('signing out forgets the kept answer and posts JSON with the session', async () => {
    const { fetch, calls } = fakeFetch({
        '/api/me': { status: 200, body: { ok: true, email: 'a@b.co' } },
        '/api/auth/logout': { status: 200, body: { ok: true } },
    });
    const account = createAccountApi({ fetch });
    await account.me();
    assert.equal((await account.logout()).status, 200);
    assert.deepEqual(calls.at(-1), { path: '/api/auth/logout', method: 'POST', body: '{}' });
    await account.me();
    assert.equal(calls.filter((c) => c.path === '/api/me').length, 2, 'asked afresh after signing out');
});

test('the billing portal is a POST that answers with the link', async () => {
    const { fetch, calls } = fakeFetch({ '/api/billing/portal': { status: 200, body: { ok: true, url: 'https://portal.example' } } });
    const r = await createAccountApi({ fetch }).billingPortal();
    assert.equal(r.body.url, 'https://portal.example');
    assert.equal(calls[0].method, 'POST');
});
