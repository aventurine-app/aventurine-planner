// ─── index.js ───────────────────────────────────────────────────────────────
// The front door of Aventurine Planner. One Worker serves the whole site at the
// app's origin and decides, per request, who may have what:
//
//   /api/paddle/webhook     Paddle only (signature checked)       paddle.js
//   /api/auth/*, /api/me    sign-in, sign-out, "who am I"         auth.js
//   /api/billing/portal     a link to Paddle's billing page       config.js
//   /api/vault, /api/vault/* the user's encrypted plans          vault.js
//   /api/privacy/*          see or delete an address's data       privacy.js
//   /auth/*, css, fonts…    public: the sign-in pages and the look
//   /demo, /demo/js/*       public: the free sandbox (one plan, seven modules,
//                           one goal) and the scripts it runs
//   /export                 public page: a lapsed subscriber opens their
//                           encrypted plans and downloads them (the vault
//                           lets them read, not write, for 60 days)
//   everything else         the app itself: only for a session whose email
//                           has an active subscription            access.js
//
// The app's HTML and JavaScript are the product, so they are only ever sent to
// someone with access, apart from the sandbox, which is the same code without
// the room or the storage to be used for real. The user's plans reach this
// server only encrypted in their browser, under a key this server never sees
// (vault.js); the sandbox's plan never leaves the browser at all.
//
// Fail closed: any error on a gated route is a refusal, never a free pass.

import { hasAccess, summarize } from './access.js';
import { currentSession, endSession, requestLogin, SESSION_TTL_MS, verifyLogin } from './auth.js';
import { ConfigError, readConfig } from './config.js';
import { deletionWarningMessage, sendEmail, sendLoginEmail } from './email.js';
import {
    HttpError, json, readJsonBody, redirect, requireSameOrigin, sessionCookie, withSecurityHeaders,
} from './http.js';
import { handleWebhook, paddleApi } from './paddle.js';
import { handlePrivacy, isPrivacyPath, processErasureQueue } from './privacy.js';
import { hasCustomer, pruneExpired } from './store.js';
import { handleVault, isVaultPath, purgeLapsedVaults, warnLapsedVaults } from './vault.js';

// Where the deletion warning sends someone to subscribe again.
const PRICING_URL = 'https://aventurine-app.com/#pricing';

// Served to anyone: the sign-in pages and what they need to look right. Not
// the app's scripts.
const PUBLIC_PREFIXES = ['/static/css/', '/static/fonts/', '/static/icons/', '/static/js/auth/', '/demo/js/'];
const PUBLIC_FILES = new Set(['/static/js/shell/theme-init.js']);
const AUTH_PAGES = new Set(['login', 'confirm', 'inactive', 'privacy']);
const DEMO_PAGES = new Set(['/demo', '/demo/']);

export const isPublicAsset = (path) => PUBLIC_FILES.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p));

function clientIp(request) {
    return request.headers.get('CF-Connecting-IP') || 'unknown';
}

/** Sends `message` to `to`. Local development with no email provider prints it instead. */
function mailer(env, config) {
    return async ({ to, message }) => {
        if (!config.secure && !env.RESEND_API_KEY) {
            console.log(`[dev] email to ${to}: ${message.subject}\n${message.text}`);
            return;
        }
        await sendEmail({ apiKey: env.RESEND_API_KEY, from: config.emailFrom, to, message });
    };
}

const paddleFor = (env, config) => paddleApi({ apiKey: env.PADDLE_API_KEY, baseUrl: config.paddleApiUrl });

export function createWorker({ now = Date.now } = {}) {
    function dependencies(request, env, ctx, config) {
        return {
            db: env.DB,
            config,
            now,
            mail: mailer(env, config),
            paddle: paddleFor(env, config),
            defer: (promise) => ctx.waitUntil(promise),
            // The rate-limit binding is optional so local development works without it.
            rateLimit: async (key) => (env.RATE_LIMIT ? (await env.RATE_LIMIT.limit({ key })).success : true),
            sendEmail: async ({ to, link, minutes }) => {
                // Local development (an http://localhost origin) with no email
                // provider set up: print the link instead. Never reachable in
                // production, where the origin is https.
                if (!config.secure && !env.RESEND_API_KEY) {
                    console.log(`[dev] sign-in link for ${to}: ${link}`);
                    return;
                }
                await sendLoginEmail({ apiKey: env.RESEND_API_KEY, from: config.emailFrom, to, link, minutes });
            },
        };
    }

    // ── API ────────────────────────────────────────────────────────────────

    async function api(request, env, ctx, config, path) {
        const deps = dependencies(request, env, ctx, config);
        const ip = clientIp(request);
        const post = request.method === 'POST';

        if (path === '/api/paddle/webhook') {
            return handleWebhook({ request, db: env.DB, secret: env.PADDLE_WEBHOOK_SECRET, nowMs: now(), paddle: deps.paddle });
        }

        if (path === '/api/auth/request' && post) {
            requireSameOrigin(request, config.appOrigin);
            const body = await readJsonBody(request);
            await requestLogin(deps, body.email, ip);
            return json({ ok: true }, 202);
        }

        if (path === '/api/auth/verify' && post) {
            requireSameOrigin(request, config.appOrigin);
            const body = await readJsonBody(request);
            const result = await verifyLogin(deps, body.token, ip);
            if (!result) return json({ ok: false, error: 'invalid_or_expired' }, 400);
            return json({ ok: true }, 200, {
                'Set-Cookie': sessionCookie({
                    name: config.cookieName, value: result.sessionToken,
                    maxAgeSeconds: SESSION_TTL_MS / 1000, secure: config.secure,
                }),
            });
        }

        if (path === '/api/auth/logout' && post) {
            requireSameOrigin(request, config.appOrigin);
            await endSession(deps, request);
            return json({ ok: true }, 200, {
                'Set-Cookie': sessionCookie({ name: config.cookieName, value: '', maxAgeSeconds: 0, secure: config.secure }),
            });
        }

        if (path === '/api/me' && request.method === 'GET') {
            const session = await currentSession(deps, request);
            if (!session) return json({ ok: false, error: 'signed_out' }, 401);
            return json({
                ok: true,
                email: session.email,
                access: hasAccess({ ...session, complimentary: config.complimentary }),
                subscription: summarize(session.subscriptions),
                complimentary: config.complimentary.has(session.email),
            });
        }

        if (path === '/api/billing/portal' && post) {
            requireSameOrigin(request, config.appOrigin);
            const session = await currentSession(deps, request);
            if (!session) return json({ ok: false, error: 'signed_out' }, 401);
            if (!(await hasCustomer(env.DB, session.email))) return json({ ok: false, error: 'no_billing' }, 404);
            // Paddle's portal signs the customer in itself, by a code sent to
            // their email, so the link is the same for everyone.
            if (!config.portalUrl) {
                console.error('[billing] PADDLE_PORTAL_URL is not set to an https link');
                return json({ ok: false, error: 'billing_unavailable' }, 502);
            }
            return json({ ok: true, url: config.portalUrl });
        }

        if (isVaultPath(path)) return handleVault(request, deps, path);
        if (isPrivacyPath(path)) return handlePrivacy(request, deps, path, ip);

        return json({ ok: false, error: 'not_found' }, 404);
    }

    // ── Pages and files ────────────────────────────────────────────────────

    /** Fetch a file from the built app (the `dist/` folder bound as ASSETS). */
    const asset = (request, env, path) => env.ASSETS.fetch(new Request(new URL(path, request.url), request));

    async function pages(request, env, ctx, config, path) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return { response: json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'GET, HEAD' }), cache: 'none' };
        }

        const authPage = /^\/auth\/([a-z]+)$/.exec(path);
        if (authPage) {
            return AUTH_PAGES.has(authPage[1])
                ? { response: await asset(request, env, `/auth/${authPage[1]}.html`) }
                : { response: json({ ok: false, error: 'not_found' }, 404) };
        }
        if (DEMO_PAGES.has(path)) return { response: await asset(request, env, '/demo/index.html') };
        if (path === '/export') return { response: await asset(request, env, '/export/index.html'), cache: 'none' };
        if (isPublicAsset(path)) return { response: await asset(request, env, path) };

        // Everything else is the app.
        const deps = dependencies(request, env, ctx, config);
        const session = await currentSession(deps, request);
        const wantsPage = path === '/';
        if (!session) {
            return { response: wantsPage ? redirect('/auth/login') : json({ ok: false, error: 'signed_out' }, 401), cache: 'none' };
        }
        if (!hasAccess({ ...session, complimentary: config.complimentary })) {
            return {
                response: wantsPage ? redirect('/auth/inactive') : json({ ok: false, error: 'no_subscription' }, 403),
                cache: 'none',
            };
        }
        return { response: await asset(request, env, wantsPage ? '/index.html' : path), cache: 'private' };
    }

    // ── Entry points ───────────────────────────────────────────────────────

    async function route(request, env, ctx) {
        const config = readConfig(env);
        const url = new URL(request.url);
        // One origin only: the cookie, the Origin check and the emailed links all assume it.
        if (url.origin !== config.appOrigin) return { response: redirect(config.appOrigin + url.pathname + url.search, 308), config };

        if (url.pathname.startsWith('/api/')) {
            return { response: await api(request, env, ctx, config, url.pathname), cache: 'none', config };
        }
        return { ...(await pages(request, env, ctx, config, url.pathname)), config };
    }

    async function fetchHandler(request, env, ctx) {
        let secure = true;
        try {
            const { response, cache, config } = await route(request, env, ctx);
            secure = config.secure;
            return withSecurityHeaders(response, { secure, cache });
        } catch (e) {
            let response;
            if (e instanceof HttpError) {
                response = json({ ok: false, error: e.code }, e.status);
            } else {
                // Never show the caller what went wrong; keep it for the logs.
                console.error('[worker] request failed:', e instanceof ConfigError ? `config: ${e.message}` : e);
                response = json({ ok: false, error: 'server_error' }, 500);
            }
            return withSecurityHeaders(response, { secure, cache: 'none' });
        }
    }

    /** Daily: drop expired records, finish queued deletions, and erase vaults past retention. */
    async function scheduled(env) {
        await pruneExpired(env.DB, now());
        // The complimentary list decides who keeps their vault, so a config
        // that cannot be read means no erasing today, never erasing blind.
        let config;
        try {
            config = readConfig(env);
        } catch (e) {
            console.error('[vault] retention skipped: config:', e.message);
            return;
        }
        const mail = mailer(env, config);
        await processErasureQueue({ db: env.DB, config, now, mail, paddle: paddleFor(env, config) });
        const send = ({ to, deleteOn }) => mail({
            to,
            message: deletionWarningMessage({ deleteOn, loginUrl: `${config.appOrigin}/auth/login`, pricingUrl: PRICING_URL }),
        });
        await warnLapsedVaults(env.DB, { now: now(), complimentary: config.complimentary, send });
        await purgeLapsedVaults(env.DB, { now: now(), complimentary: config.complimentary });
    }

    return {
        fetch: fetchHandler,
        scheduled: (_event, env, ctx) => ctx.waitUntil(scheduled(env)),
    };
}

export default createWorker();
