// Shared setup for the worker tests: the real worker running on an in-memory
// SQLite database (through a small D1-shaped wrapper), a fake asset store, a
// clock the test controls, and a capture of what the worker sends out (the
// sign-in email, calls to Paddle).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { createWorker } from '../../worker/src/index.js';

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'worker', 'migrations');

export const ORIGIN = 'https://app.example.test';
export const WEBHOOK_SECRET = 'pdl_ntfset_test_secret';
export const PORTAL_URL = 'https://sandbox-customer-portal.paddle.com/cpl_01test';
export const OWNER = 'owner@example.test';

/** A D1-shaped wrapper (prepare/bind/first/all/run, batch) over node:sqlite. */
export function createTestDb() {
    const sqlite = new DatabaseSync(':memory:');
    for (const file of fs.readdirSync(MIGRATIONS).sort()) {
        sqlite.exec(fs.readFileSync(path.join(MIGRATIONS, file), 'utf8'));
    }
    const statement = (sql, params) => {
        const stmt = sqlite.prepare(sql);
        return {
            bind: (...p) => statement(sql, p),
            first: async () => stmt.get(...params) ?? null,
            all: async () => ({ results: stmt.all(...params) }),
            run: async () => ({ meta: { changes: stmt.run(...params).changes } }),
        };
    };
    return {
        sqlite,
        prepare: (sql) => statement(sql, []),
        async batch(statements) {
            sqlite.exec('BEGIN');
            try {
                const results = [];
                for (const s of statements) results.push(await s.run());
                sqlite.exec('COMMIT');
                return results;
            } catch (e) {
                sqlite.exec('ROLLBACK');
                throw e;
            }
        },
    };
}

/** Sign a webhook body the way Paddle does. */
export function signWebhook(body, { secret = WEBHOOK_SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
    const h1 = crypto.createHmac('sha256', secret).update(`${ts}:${body}`).digest('hex');
    return `ts=${ts};h1=${h1}`;
}

let counter = 0;
const id = (prefix) => `${prefix}_${String(++counter).padStart(8, '0')}abcdef`;

export function customerEvent({ customerId, email, type = 'customer.created', at }) {
    return { event_id: id('evt'), event_type: type, occurred_at: at, data: { id: customerId, email, status: 'active' } };
}

export function subscriptionEvent({
    subscriptionId, customerId, status = 'active', type = 'subscription.created', at, periodEnd, cancelAt,
}) {
    return {
        event_id: id('evt'),
        event_type: type,
        occurred_at: at,
        data: {
            id: subscriptionId,
            customer_id: customerId,
            status,
            items: [{ price: { id: 'pri_monthly' } }],
            current_billing_period: periodEnd ? { starts_at: at, ends_at: periodEnd } : null,
            scheduled_change: cancelAt ? { action: 'cancel', effective_at: cancelAt } : null,
        },
    };
}

/** The worker, wired to fakes. `clock.now` is the current time in ms. */
export function createSite({ complimentary = OWNER, files, rateLimit, origin = ORIGIN, resendKey = 're_test_key' } = {}) {
    const db = createTestDb();
    const clock = { now: Date.UTC(2026, 9, 21, 12, 0, 0) };
    const worker = createWorker({ now: () => clock.now });

    const assets = files ?? {
        '/index.html': '<!doctype html><title>the app</title>',
        '/static/js/app/store.js': 'secret app code',
        '/static/css/style.css': 'body{}',
        '/static/js/shell/theme-init.js': 'theme',
        '/static/js/auth/login.js': 'login page script',
        '/auth/login.html': '<!doctype html><title>sign in</title>',
        '/auth/confirm.html': '<!doctype html><title>confirm</title>',
        '/auth/inactive.html': '<!doctype html><title>inactive</title>',
        '/demo/index.html': '<!doctype html><title>free demo</title>',
        '/demo/js/demo/boot.js': 'sandbox boot script',
        '/export/index.html': '<!doctype html><title>export page</title>',
    };
    const limited = new Set();
    const env = {
        DB: db,
        ASSETS: {
            fetch: async (request) => {
                const body = assets[new URL(request.url).pathname];
                return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, { status: 200 });
            },
        },
        APP_ORIGIN: origin,
        EMAIL_FROM: 'Aventurine Planner <signin@example.test>',
        PADDLE_PORTAL_URL: PORTAL_URL,
        PADDLE_WEBHOOK_SECRET: WEBHOOK_SECRET,
        RESEND_API_KEY: resendKey,
        COMPLIMENTARY_EMAILS: complimentary,
        RATE_LIMIT: rateLimit ?? { limit: async ({ key }) => ({ success: !limited.has(key) }) },
    };

    const pending = [];
    const ctx = { waitUntil: (p) => { pending.push(p); } };
    const sent = { emails: [] };
    const behavior = { resendStatus: 200 };

    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
        const target = String(url);
        const body = init.body ? JSON.parse(init.body) : null;
        if (target.startsWith('https://api.resend.com/')) {
            sent.emails.push({ headers: init.headers, ...body });
            return new Response('{}', { status: behavior.resendStatus });
        }
        throw new Error(`unexpected outbound request to ${target}`);
    };

    /** Make a request to the worker and wait for anything it deferred. */
    async function call(pathname, { method = 'GET', headers = {}, body, cookie, origin: requestOrigin = origin, json } = {}) {
        const h = new Headers(headers);
        if (cookie) h.set('Cookie', cookie);
        let payload = body;
        if (json !== undefined) {
            payload = JSON.stringify(json);
            h.set('Content-Type', 'application/json');
        }
        if (method !== 'GET' && !h.has('Origin') && requestOrigin) h.set('Origin', requestOrigin);
        const response = await worker.fetch(new Request(`${origin}${pathname}`, { method, headers: h, body: payload, redirect: 'manual' }), env, ctx);
        await Promise.all(pending.splice(0));
        return response;
    }

    const site = {
        env, db, clock, sent, behavior, call, files: assets, limit: (key) => limited.add(key),
        restore: () => { globalThis.fetch = realFetch; },
        advance: (ms) => { clock.now += ms; },
        iso: (offsetMs = 0) => new Date(clock.now + offsetMs).toISOString(),

        /** Run the daily scheduled job and wait for it. */
        async cron() {
            const work = [];
            worker.scheduled({}, env, { waitUntil: (p) => { work.push(p); } });
            await Promise.all(work);
        },

        /** Deliver a signed webhook, as Paddle would. */
        async webhook(event, { secret, ts } = {}) {
            const body = JSON.stringify(event);
            return call('/api/paddle/webhook', {
                method: 'POST',
                body,
                origin: null,
                headers: { 'Content-Type': 'application/json', 'Paddle-Signature': signWebhook(body, { secret, ts: ts ?? Math.floor(clock.now / 1000) }) },
            });
        },

        /** A paying customer, as Paddle's events would create one. */
        async subscribe({ email, customerId = 'ctm_01alice', subscriptionId = 'sub_01alice', status = 'active', periodEnd, cancelAt }) {
            const at = site.iso();
            await site.webhook(customerEvent({ customerId, email, at }));
            await site.webhook(subscriptionEvent({ subscriptionId, customerId, status, at, periodEnd, cancelAt }));
        },

        /** Go through the sign-in flow for `email` and return the session cookie. */
        async signIn(email) {
            await call('/api/auth/request', { method: 'POST', json: { email } });
            const mail = sent.emails.at(-1);
            const token = /#t=([A-Za-z0-9_-]{43})/.exec(mail.text)[1];
            const response = await call('/api/auth/verify', { method: 'POST', json: { token } });
            return response.headers.get('Set-Cookie').split(';')[0];
        },
    };
    return site;
}
