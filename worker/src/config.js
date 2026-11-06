// ─── config.js ──────────────────────────────────────────────────────────────
// Reads and checks the worker's settings once per request. A bad setting is an
// error here, not a surprise later: the worker refuses to run on a half-set-up
// environment rather than guess (for example, an emailed sign-in link that
// points at the wrong host).
//
//   APP_ORIGIN              where the app is served, e.g. https://app.aventurine-app.com
//   EMAIL_FROM              the From address of sign-in emails
//   PADDLE_PORTAL_URL       Paddle's customer portal link (https://customer-portal.paddle.com/cpl_...)
//   PADDLE_API_URL          Paddle's API (https://api.paddle.com, or the sandbox's)
//   PRIVACY_EMAIL           where the checklist for a deletion goes (privacy.js)
//   COMPLIMENTARY_EMAILS    (secret, optional) emails with free access, comma or space separated
//   PADDLE_WEBHOOK_SECRET, RESEND_API_KEY, PADDLE_API_KEY   (secrets)
//
// The Paddle links and PRIVACY_EMAIL are the exception to refusing to run:
// without them only billing and deletions fail, and a deletion waits in the
// queue until they are fixed. So a missing or bad value is null, not an error.

import { normalizeEmail } from './email-address.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

export class ConfigError extends Error {}

function parseOrigin(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new ConfigError('APP_ORIGIN is not a URL');
    }
    const local = LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
        throw new ConfigError('APP_ORIGIN must be https (http is for localhost only)');
    }
    return { origin: url.origin, secure: url.protocol === 'https:' };
}

/** The value if it is an https URL, else null. */
function parseHttpsUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' ? url.href : null;
    } catch {
        return null;
    }
}

/** The emails in a comma- or space-separated list, lower-cased. */
export function parseEmailList(value) {
    return new Set(String(value || '').split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean));
}

export function readConfig(env) {
    const { origin, secure } = parseOrigin(env.APP_ORIGIN);
    return {
        appOrigin: origin,
        secure,
        emailFrom: env.EMAIL_FROM || '',
        portalUrl: parseHttpsUrl(env.PADDLE_PORTAL_URL),
        paddleApiUrl: parseHttpsUrl(env.PADDLE_API_URL)?.replace(/\/$/, '') ?? null,
        privacyEmail: normalizeEmail(env.PRIVACY_EMAIL),
        complimentary: parseEmailList(env.COMPLIMENTARY_EMAILS),
        // Local development has no Paddle: the cookie name and flags follow the scheme.
        cookieName: secure ? '__Host-prism_session' : 'prism_session',
    };
}
