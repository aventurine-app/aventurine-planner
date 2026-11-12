// Signing in: the emailed link, the session it starts, and the limits around both.

import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorker } from '../../worker/src/index.js';
import { createSite, customerEvent, ORIGIN, OWNER, subscriptionEvent } from './harness.mjs';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const COOKIE = '__Host-prism_session';

const requestLink = (site, email) => site.call('/api/auth/request', { method: 'POST', json: { email } });
const tokenIn = (mail) => /#t=([A-Za-z0-9_-]{43})/.exec(mail.text)[1];

async function customer(site, email = 'alice@example.com') {
    await site.subscribe({ email });
    return email;
}

test('a customer is emailed a one-time link on our own origin, with the token after the #', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const email = await customer(site);

    const response = await requestLink(site, email);
    assert.equal(response.status, 202);
    assert.equal(site.sent.emails.length, 1);
    const mail = site.sent.emails[0];
    assert.deepEqual(mail.to, [email]);
    assert.match(mail.text, new RegExp(`${ORIGIN}/auth/confirm#t=[A-Za-z0-9_-]{43}`));
    assert.ok(mail.html.includes(`${ORIGIN}/auth/confirm#t=`));
    assert.equal(mail.headers.Authorization, 'Bearer re_test_key');
});

test('the database keeps only a hash of the token', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await requestLink(site, await customer(site));
    const token = tokenIn(site.sent.emails[0]);
    const rows = site.db.sqlite.prepare('SELECT * FROM login_tokens').all();
    assert.equal(rows.length, 1);
    assert.ok(!JSON.stringify(rows).includes(token));
    assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
});

test('the answer is the same for a customer and a stranger, and a stranger is sent nothing', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const known = await requestLink(site, await customer(site));
    const stranger = await requestLink(site, 'nobody@example.com');
    assert.equal(known.status, stranger.status);
    assert.deepEqual(await known.json(), await stranger.json());
    assert.equal(site.sent.emails.length, 1, 'only the customer was emailed');
    assert.deepEqual(site.sent.emails[0].to, ['alice@example.com']);
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM login_tokens').get().n, 1);
});

test('the reply does not wait for the link to be made or sent', async (t) => {
    // A customer's request must cost the same as a stranger's, so the token
    // write and the email are deferred past the reply (ctx.waitUntil).
    const site = createSite();
    t.after(site.restore);
    const email = await customer(site);
    const deferred = [];
    const ctx = { waitUntil: (p) => { deferred.push(p); } };
    const worker = createWorker({ now: () => site.clock.now });
    const response = await worker.fetch(new Request(`${ORIGIN}/api/auth/request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: JSON.stringify({ email }),
    }), site.env, ctx);
    assert.equal(response.status, 202);
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM login_tokens').get().n, 0, 'nothing written before the reply');
    assert.equal(site.sent.emails.length, 0);
    await Promise.all(deferred);
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM login_tokens').get().n, 1);
    assert.equal(site.sent.emails.length, 1);
});

test('a link goes only to a subscription that grants access', async (t) => {
    const site = createSite();
    t.after(site.restore);
    for (const status of ['active', 'trialing', 'past_due', 'paused', 'canceled']) {
        await site.subscribe({ email: `${status}@example.com`, customerId: `ctm_01${status.replace('_', '')}`, subscriptionId: `sub_01${status.replace('_', '')}`, status });
    }
    // Paddle creates the customer as soon as an email is typed into checkout.
    await site.webhook(customerEvent({ customerId: 'ctm_01leftcheckout', email: 'left@example.com', at: site.iso() }));

    const answers = [];
    for (const email of ['active', 'trialing', 'past_due', 'paused', 'canceled', 'left'].map((s) => `${s}@example.com`)) {
        const r = await requestLink(site, email);
        answers.push([r.status, await r.json()]);
    }
    assert.deepEqual(site.sent.emails.map((m) => m.to[0]), ['active@example.com', 'trialing@example.com', 'past_due@example.com']);
    assert.ok(answers.every((a) => JSON.stringify(a) === JSON.stringify(answers[0])), 'every caller gets the same answer');
});

test('a lapsed customer who subscribes again can sign in again', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com', status: 'canceled' });
    await requestLink(site, 'alice@example.com');
    assert.equal(site.sent.emails.length, 0);
    await site.webhook(subscriptionEvent({ subscriptionId: 'sub_01second', customerId: 'ctm_01alice', status: 'active', at: site.iso(1000) }));
    await requestLink(site, 'alice@example.com');
    assert.equal(site.sent.emails.length, 1);
});

test('an address with different capitals or spaces still finds the customer', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await customer(site);
    await requestLink(site, '  ALICE@Example.com ');
    assert.equal(site.sent.emails.length, 1);
});

test('something that cannot be an email address is a 400', async (t) => {
    const site = createSite();
    t.after(site.restore);
    for (const email of ['', 'nope', 'a@b', 5, null, ['a@b.co'], 'x'.repeat(300) + '@b.co']) {
        assert.equal((await requestLink(site, email)).status, 400, String(email).slice(0, 20));
    }
    assert.equal(site.sent.emails.length, 0);
});

test('an owner on the complimentary list can sign in without being a customer', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await requestLink(site, OWNER);
    assert.equal(site.sent.emails.length, 1);
});

test('a link works once, and starts a hardened session cookie', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await requestLink(site, await customer(site));
    const token = tokenIn(site.sent.emails[0]);

    const first = await site.call('/api/auth/verify', { method: 'POST', json: { token } });
    assert.equal(first.status, 200);
    const cookie = first.headers.get('Set-Cookie');
    assert.match(cookie, new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43};`));
    for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${30 * DAY / 1000}`]) assert.ok(cookie.includes(flag), flag);
    assert.ok(!/Domain=/i.test(cookie), 'a __Host- cookie has no Domain');

    const second = await site.call('/api/auth/verify', { method: 'POST', json: { token } });
    assert.equal(second.status, 400);
    assert.equal(second.headers.get('Set-Cookie'), null);
});

test('only a hash of the session cookie is stored', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const cookie = await site.signIn(await customer(site));
    const value = cookie.split('=')[1];
    const rows = JSON.stringify(site.db.sqlite.prepare('SELECT * FROM sessions').all());
    assert.ok(!rows.includes(value));
});

test('a link expires after fifteen minutes', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await requestLink(site, await customer(site));
    const token = tokenIn(site.sent.emails[0]);
    site.advance(15 * MINUTE + 1);
    assert.equal((await site.call('/api/auth/verify', { method: 'POST', json: { token } })).status, 400);
});

test('guesses and malformed tokens are refused alike', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await requestLink(site, await customer(site));
    for (const token of ['x'.repeat(43), 'short', '', null, 5, {}, "' OR 1=1 --".padEnd(43, 'a')]) {
        const r = await site.call('/api/auth/verify', { method: 'POST', json: { token } });
        assert.equal(r.status, 400, String(token));
        assert.deepEqual(await r.json(), { ok: false, error: 'invalid_or_expired' });
    }
});

test('two clicks racing for one link produce one session', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await requestLink(site, await customer(site));
    const token = tokenIn(site.sent.emails[0]);
    const results = await Promise.all([1, 2, 3].map(() => site.call('/api/auth/verify', { method: 'POST', json: { token } })));
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1);
});

test('a fourth link in fifteen minutes is not sent, and the caller cannot tell', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const email = await customer(site);
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await requestLink(site, email)).status);
    assert.deepEqual(statuses, [202, 202, 202, 202, 202]);
    assert.equal(site.sent.emails.length, 3);

    site.advance(16 * MINUTE);
    await requestLink(site, email);
    assert.equal(site.sent.emails.length, 4, 'the window has passed');
});

test('requests from one address are throttled', async (t) => {
    const site = createSite();
    t.after(site.restore);
    site.limit('login:unknown');
    const r = await requestLink(site, 'alice@example.com');
    assert.equal(r.status, 429);
    assert.equal(site.sent.emails.length, 0);
});

test('a failure to send the email does not change the answer', async (t) => {
    const site = createSite();
    t.after(site.restore);
    site.behavior.resendStatus = 500;
    const original = console.error;
    console.error = () => {};
    try {
        assert.equal((await requestLink(site, await customer(site))).status, 202);
    } finally {
        console.error = original;
    }
});

test('signing out ends the session at once', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const cookie = await site.signIn(await customer(site));
    assert.equal((await site.call('/api/me', { cookie })).status, 200);

    const out = await site.call('/api/auth/logout', { method: 'POST', cookie, json: {} });
    assert.equal(out.status, 200);
    assert.match(out.headers.get('Set-Cookie'), /Max-Age=0/);
    assert.equal((await site.call('/api/me', { cookie })).status, 401, 'the old cookie no longer works');
});

test('a session lasts thirty days', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const cookie = await site.signIn(await customer(site));
    site.advance(30 * DAY - MINUTE);
    assert.equal((await site.call('/api/me', { cookie })).status, 200);
    site.advance(2 * MINUTE);
    assert.equal((await site.call('/api/me', { cookie })).status, 401);
});

test('a forged or malformed cookie is no session', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await customer(site);
    for (const cookie of [`${COOKIE}=${'a'.repeat(43)}`, `${COOKIE}=short`, `${COOKIE}=`, 'other=1', `${COOKIE}=%00`]) {
        assert.equal((await site.call('/api/me', { cookie })).status, 401, cookie);
    }
});

test('state-changing requests must come from our own page', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const email = await customer(site);
    for (const origin of ['https://evil.example', 'http://app.example.test', null]) {
        const r = await site.call('/api/auth/request', { method: 'POST', json: { email }, origin });
        assert.equal(r.status, 403, String(origin));
    }
    assert.equal(site.sent.emails.length, 0);
});

test('a request body must be JSON and small', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const form = await site.call('/api/auth/request', { method: 'POST', body: 'email=a@b.co', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415);
    const broken = await site.call('/api/auth/request', { method: 'POST', body: '{nope', headers: { 'Content-Type': 'application/json' } });
    assert.equal(broken.status, 400);
    const array = await site.call('/api/auth/request', { method: 'POST', body: '[]', headers: { 'Content-Type': 'application/json' } });
    assert.equal(array.status, 400);
    const huge = await site.call('/api/auth/request', { method: 'POST', json: { email: 'a'.repeat(10000) } });
    assert.equal(huge.status, 413);
});

test('expired links and sessions are removed by the daily clean-up', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await site.signIn(await customer(site));
    await requestLink(site, 'alice@example.com');
    const pending = [];
    site.advance(31 * DAY);
    await createWorker({ now: () => site.clock.now }).scheduled({}, site.env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 0);
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM login_tokens').get().n, 0);
});

test('in local development with no email provider the link is printed, never sent', async (t) => {
    const site = createSite({ origin: 'http://127.0.0.1:8787', resendKey: null });
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com' });
    const lines = [];
    const original = console.log;
    console.log = (line) => lines.push(String(line));
    try {
        await requestLink(site, 'alice@example.com');
    } finally {
        console.log = original;
    }
    assert.equal(site.sent.emails.length, 0);
    assert.match(lines.join('\n'), /\[dev\] sign-in link for alice@example\.com: http:\/\/127\.0\.0\.1:8787\/auth\/confirm#t=/);
});

test('in production the link is never printed, even with no provider key', async (t) => {
    const site = createSite({ resendKey: null });
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com' });
    const lines = [];
    const log = console.log;
    const error = console.error;
    console.log = (line) => lines.push(String(line));
    console.error = () => {};
    try {
        await requestLink(site, 'alice@example.com');
    } finally {
        console.log = log;
        console.error = error;
    }
    assert.ok(!lines.join('\n').includes('/auth/confirm'));
});
