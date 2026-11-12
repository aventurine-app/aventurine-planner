// Who gets what: the sign-in pages are public, the app is for subscribers only,
// and anything that goes wrong is a refusal.

import assert from 'node:assert/strict';
import test from 'node:test';

import { hasAccess, summarize } from '../../worker/src/access.js';
import { ConfigError, parseEmailList, readConfig } from '../../worker/src/config.js';
import { createWorker } from '../../worker/src/index.js';
import { createSite, ORIGIN, OWNER, PORTAL_URL, subscriptionEvent } from './harness.mjs';

const DAY = 24 * 60 * 60 * 1000;
const APP_CODE = 'secret app code';

/** A signed-in browser for a customer whose subscription has `status`. */
async function member(site, status = 'active', email = 'alice@example.com') {
    await site.subscribe({ email });
    const cookie = await site.signIn(email);
    // Only access gets a sign-in link, so a lapsed member signed in while paid up.
    if (status !== 'active') {
        site.advance(1000);
        await site.webhook(subscriptionEvent({ subscriptionId: 'sub_01alice', customerId: 'ctm_01alice', status, type: 'subscription.updated', at: site.iso() }));
    }
    return cookie;
}

// ── Signed out ─────────────────────────────────────────────────────────────

test('signed out, the app is a redirect to sign-in and its code is a 401', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const page = await site.call('/');
    assert.equal(page.status, 302);
    assert.equal(page.headers.get('Location'), '/auth/login');

    for (const path of ['/static/js/app/store.js', '/static/js/shell/settings.js', '/index.html', '/anything']) {
        const r = await site.call(path);
        assert.equal(r.status, 401, path);
        assert.ok(!(await r.text()).includes(APP_CODE));
    }
});

test('the sign-in pages and the look they need are public', async (t) => {
    const site = createSite();
    t.after(site.restore);
    for (const [path, body] of [
        ['/auth/login', 'sign in'], ['/auth/confirm', 'confirm'], ['/auth/inactive', 'inactive'],
        ['/static/css/style.css', 'body{}'], ['/static/js/auth/login.js', 'login page script'],
        ['/static/js/shell/theme-init.js', 'theme'],
    ]) {
        const r = await site.call(path);
        assert.equal(r.status, 200, path);
        assert.ok((await r.text()).includes(body), path);
    }
    assert.equal((await site.call('/auth/nope')).status, 404);
    assert.equal((await site.call('/auth/login.html')).status, 401, 'only the clean URL is a page');
});

test('the free sandbox and its scripts are public, and only the sandbox\'s own copy of them', async (t) => {
    const site = createSite();
    t.after(site.restore);
    for (const path of ['/demo', '/demo/']) {
        const page = await site.call(path);
        assert.equal(page.status, 200, path);
        assert.ok((await page.text()).includes('free demo'), path);
    }
    const script = await site.call('/demo/js/demo/boot.js');
    assert.equal(script.status, 200);
    assert.equal(await script.text(), 'sandbox boot script');
    assert.equal((await site.call('/demo/js/app/missing.js')).status, 404);
    // The sandbox opens nothing else: the app and its scripts are still for subscribers.
    assert.equal((await site.call('/static/js/app/store.js')).status, 401);
    assert.equal((await site.call('/demo/index.html')).status, 401, 'only the clean URL is a page');
    assert.equal((await site.call('/demo/other')).status, 401);
});

test('the export page is public (it asks for the vault itself), and only at its clean URL', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const page = await site.call('/export');
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('export page'));
    assert.equal(page.headers.get('Content-Security-Policy').includes("script-src 'self'"), true);
    assert.equal((await site.call('/export/index.html')).status, 401);
});

test('dot-segment tricks cannot reach app code through a public path', async (t) => {
    const site = createSite();
    t.after(site.restore);
    for (const path of ['/static/js/auth/../app/store.js', '/static/js/auth/%2e%2e/app/store.js',
        '/static/css/../js/app/store.js', '/auth/../static/js/app/store.js',
        '/demo/js/../../static/js/app/store.js', '/demo/js/%2e%2e/%2e%2e/static/js/app/store.js']) {
        const r = await site.call(path);
        assert.notEqual(r.status, 200, path);
        assert.ok(!(await r.text()).includes(APP_CODE), path);
    }
});

test('nothing but GET reaches a file', async (t) => {
    const site = createSite();
    t.after(site.restore);
    for (const method of ['POST', 'PUT', 'DELETE']) assert.equal((await site.call('/static/css/style.css', { method })).status, 405);
});

// ── Signed in ──────────────────────────────────────────────────────────────

test('a subscriber gets the app, its code, and must revalidate each time', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const cookie = await member(site);

    const page = await site.call('/', { cookie });
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('the app'));
    assert.equal(page.headers.get('Cache-Control'), 'private, no-cache');

    const code = await site.call('/static/js/app/store.js', { cookie });
    assert.equal(code.status, 200);
    assert.equal(await code.text(), APP_CODE);
    assert.equal((await site.call('/static/js/app/missing.js', { cookie })).status, 404);
});

test('a file named by its content may be kept for a year; the page, a miss and a plain name still revalidate', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const cookie = await member(site);
    const YEAR = 'max-age=31536000, immutable';

    // The app's code: kept, in the browser only, and still only for a subscriber.
    const code = await site.call('/static/js/app/store.js?v=0123456789', { cookie });
    assert.equal(code.status, 200);
    assert.equal(await code.text(), APP_CODE);
    assert.equal(code.headers.get('Cache-Control'), `private, ${YEAR}`);
    const out = await site.call('/static/js/app/store.js?v=0123456789');
    assert.equal(out.status, 401);
    assert.equal(out.headers.get('Cache-Control'), 'no-store');

    // A public file: kept by any cache.
    assert.equal((await site.call('/static/css/style.css?v=0123456789')).headers.get('Cache-Control'), `public, ${YEAR}`);

    // Not kept: the page itself, a file that is not there, and a version that is not a hash.
    assert.equal((await site.call('/?v=0123456789', { cookie })).headers.get('Cache-Control'), 'private, no-cache');
    const missing = await site.call('/static/js/app/missing.js?v=0123456789', { cookie });
    assert.equal(missing.status, 404);
    assert.ok(!(missing.headers.get('Cache-Control') || '').includes('immutable'));
    assert.equal((await site.call('/static/js/app/store.js?v=latest', { cookie })).headers.get('Cache-Control'), 'private, no-cache');
    assert.equal((await site.call('/static/css/style.css?v=latest')).headers.get('Cache-Control'), null);
});

test('only active, trialing and past_due subscriptions get in', async () => {
    for (const [status, allowed] of [['active', true], ['trialing', true], ['past_due', true], ['paused', false], ['canceled', false], ['mystery', false]]) {
        const site = createSite();
        const cookie = await member(site, status);
        const page = await site.call('/', { cookie });
        const code = await site.call('/static/js/app/store.js', { cookie });
        if (allowed) {
            assert.equal(page.status, 200, status);
            assert.equal(code.status, 200, status);
        } else {
            assert.equal(page.status, 302, status);
            assert.equal(page.headers.get('Location'), '/auth/inactive');
            assert.equal(code.status, 403, status);
            assert.ok(!(await code.text()).includes(APP_CODE));
        }
        site.restore();
    }
});

test('a cancellation takes effect on the very next request', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const cookie = await member(site, 'active');
    assert.equal((await site.call('/', { cookie })).status, 200);

    site.advance(60 * 1000);
    await site.webhook(subscriptionEvent({
        subscriptionId: 'sub_01alice', customerId: 'ctm_01alice', status: 'canceled', type: 'subscription.canceled', at: site.iso(),
    }));
    assert.equal((await site.call('/', { cookie })).status, 302);
});

test('a customer who subscribes after signing in is let in without signing in again', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const cookie = await member(site, 'canceled');
    assert.equal((await site.call('/', { cookie })).status, 302);
    await site.webhook(subscriptionEvent({
        subscriptionId: 'sub_01second', customerId: 'ctm_01alice', status: 'active', at: site.iso(1000),
    }));
    assert.equal((await site.call('/', { cookie })).status, 200);
});

test('the owner on the complimentary list gets in with no subscription', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const cookie = await site.signIn(OWNER);
    assert.equal((await site.call('/', { cookie })).status, 200);
    const me = await (await site.call('/api/me', { cookie })).json();
    assert.equal(me.access, true);
    assert.equal(me.complimentary, true);
});

test('one subscriber\'s cookie is not another\'s access', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await site.subscribe({ email: 'paying@example.com', customerId: 'ctm_01paying', subscriptionId: 'sub_01paying' });
    const paying = await site.signIn('paying@example.com');
    const lapsed = await member(site, 'canceled', 'lapsed@example.com');
    assert.equal((await site.call('/', { cookie: paying })).status, 200);
    assert.equal((await site.call('/', { cookie: lapsed })).status, 302);
});

// ── Who am I, and billing ──────────────────────────────────────────────────

test('/api/me says who is signed in and what they have', async (t) => {
    const site = createSite();
    t.after(site.restore);
    assert.equal((await site.call('/api/me')).status, 401);

    await site.subscribe({ email: 'alice@example.com', periodEnd: site.iso(20 * DAY), cancelAt: site.iso(20 * DAY) });
    const cookie = await site.signIn('alice@example.com');
    const me = await (await site.call('/api/me', { cookie })).json();
    assert.equal(me.email, 'alice@example.com');
    assert.equal(me.access, true);
    assert.deepEqual(me.subscription, { status: 'active', renewsAt: site.clock.now + 20 * DAY, cancelsAt: site.clock.now + 20 * DAY });
    assert.equal(me.complimentary, false);
});

test('the billing portal is Paddle\'s portal link, which asks Paddle nothing', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const cookie = await member(site);
    const r = await site.call('/api/billing/portal', { method: 'POST', cookie, json: {} });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, url: PORTAL_URL });
});

test('the billing portal needs a session, our own origin, and a Paddle customer', async (t) => {
    const site = createSite();
    t.after(site.restore);
    assert.equal((await site.call('/api/billing/portal', { method: 'POST', json: {} })).status, 401);

    const cookie = await member(site);
    assert.equal((await site.call('/api/billing/portal', { method: 'POST', cookie, json: {}, origin: 'https://evil.example' })).status, 403);

    const owner = await site.signIn(OWNER);
    assert.equal((await site.call('/api/billing/portal', { method: 'POST', cookie: owner, json: {} })).status, 404);
});

test('with no usable portal link, only billing fails, with a plain 502', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const cookie = await member(site);
    const original = console.error;
    console.error = () => {};
    try {
        for (const value of [undefined, '', 'not a url', 'http://customer-portal.paddle.com/cpl_x']) {
            site.env.PADDLE_PORTAL_URL = value;
            const r = await site.call('/api/billing/portal', { method: 'POST', cookie, json: {} });
            assert.equal(r.status, 502);
            assert.deepEqual(await r.json(), { ok: false, error: 'billing_unavailable' });
            assert.equal((await site.call('/', { cookie })).status, 200, 'the app still opens');
        }
    } finally {
        console.error = original;
    }
});

// ── Everything else ───────────────────────────────────────────────────────

test('every response carries the security headers', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const cookie = await member(site);
    for (const r of [await site.call('/'), await site.call('/auth/login'), await site.call('/api/me'), await site.call('/', { cookie }), await site.call('/api/nothing')]) {
        assert.match(r.headers.get('Content-Security-Policy'), /default-src 'self'.*frame-ancestors 'none'/);
        assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
        assert.equal(r.headers.get('X-Frame-Options'), 'DENY');
        assert.equal(r.headers.get('Referrer-Policy'), 'no-referrer');
        assert.equal(r.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
        assert.match(r.headers.get('Strict-Transport-Security'), /max-age=31536000/);
    }
    assert.equal((await site.call('/api/me')).headers.get('Cache-Control'), 'no-store');
});

test('another hostname is sent to the real one', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const worker = createWorker({ now: () => site.clock.now });
    const response = await worker.fetch(
        new Request('https://aventurine-planner.someone.workers.dev/static/js/app/store.js?x=1'), site.env, { waitUntil() {} },
    );
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('Location'), `${ORIGIN}/static/js/app/store.js?x=1`);
});

test('if the database fails, the app stays locked and no detail leaks', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const cookie = await member(site);
    site.env.DB = { prepare() { throw new Error('D1_ERROR: secret internals'); } };
    const original = console.error;
    console.error = () => {};
    try {
        const r = await site.call('/', { cookie });
        assert.equal(r.status, 500);
        const text = await r.text();
        assert.ok(!text.includes('secret internals'));
        assert.ok(!text.includes('the app'));
    } finally {
        console.error = original;
    }
});

test('a misconfigured origin stops the worker instead of guessing', () => {
    assert.throws(() => readConfig({ APP_ORIGIN: 'http://app.example.com' }), ConfigError);
    assert.throws(() => readConfig({ APP_ORIGIN: 'not a url' }), ConfigError);
    const local = readConfig({ APP_ORIGIN: 'http://127.0.0.1:8787' });
    assert.equal(local.secure, false);
    assert.equal(local.cookieName, 'prism_session');
    assert.equal(readConfig({ APP_ORIGIN: ORIGIN }).cookieName, '__Host-prism_session');
});

test('the complimentary list is read loosely', () => {
    assert.deepEqual([...parseEmailList(' A@x.co, b@x.co  C@X.CO\n')].sort(), ['a@x.co', 'b@x.co', 'c@x.co']);
    assert.equal(parseEmailList(undefined).size, 0);
});

test('the access rule', () => {
    const none = new Set();
    const sub = (status, updated_at = 1) => ({ status, updated_at, period_end: null, cancel_at: null });
    assert.equal(hasAccess({ email: 'a@x.co', subscriptions: [], complimentary: none }), false);
    assert.equal(hasAccess({ email: 'a@x.co', subscriptions: [sub('canceled'), sub('active')], complimentary: none }), true);
    assert.equal(hasAccess({ email: 'a@x.co', subscriptions: [], complimentary: new Set(['a@x.co']) }), true);
    assert.equal(summarize([]), null);
    assert.equal(summarize([sub('canceled', 9), sub('active', 1)]).status, 'active', 'one with access wins');
    assert.equal(summarize([sub('canceled', 1), sub('paused', 9)]).status, 'paused', 'else the newest');
});
