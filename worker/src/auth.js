// ─── auth.js ────────────────────────────────────────────────────────────────
// Signing in without a password. The person types their email; if it has access
// to Aventurine Planner (the same rule as access.js) we email a one-time link; opening it
// starts a session.
//
// Choices that matter:
//   • The answer to "send me a link" is the same whether or not the email is a
//     customer, so the form cannot be used to find out who subscribes. It also
//     only emails addresses with a subscription that grants access, so it cannot
//     be used to spam strangers, and nobody is sent a link they cannot use: not
//     someone who left checkout before paying, nor a lapsed subscriber.
//   • The reply takes the same work for everyone: the same two reads, and
//     nothing written before it is sent. Making the link (a database write)
//     and sending it happen after the reply, so a customer's request is not
//     measurably slower than a stranger's.
//   • The link carries its token after a #, which a browser never sends to a
//     server and which mail scanners that only fetch the URL never see. The page
//     it opens asks for one click before using the token, so a scanner that
//     runs scripts still cannot spend it.
//   • The emailed link is built from APP_ORIGIN, never from the Host header of
//     the request, so a forged Host cannot make us email a link to another site.
//   • Only a SHA-256 of each token is stored. A stolen copy of the database
//     cannot sign anyone in.
//   • The session cookie is a random 256-bit value, HttpOnly, SameSite=Lax and
//     (over https) Secure with the __Host- prefix.

import { hasAccess } from './access.js';
import { randomToken, sha256Hex } from './crypto.js';
import { normalizeEmail } from './email-address.js';
import { HttpError, readCookie } from './http.js';
import {
    consumeLoginToken, countLoginTokens, createLoginToken, createSession, deleteSession, findSession, hasVault, subscriptionsFor,
} from './store.js';

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export const LINK_TTL_MS = 15 * MINUTE;
export const SESSION_TTL_MS = 30 * DAY;
const MAX_LINKS_PER_WINDOW = 3;

// 32 random bytes as unpadded URL-safe base64 is 43 characters.
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Handle "send me a link". `deps` is { db, config, now, defer, rateLimit, sendEmail }.
 * Resolves with nothing the caller may use to tell customers from strangers.
 */
export async function requestLogin(deps, rawEmail, ip) {
    const email = normalizeEmail(rawEmail);
    if (!email) throw new HttpError(400, 'invalid_email');
    if (!(await deps.rateLimit(`login:${ip}`))) throw new HttpError(429, 'rate_limited');

    // Both reads run for everyone (no short circuit), so the reply costs the same.
    const [subscriptions, kept] = await Promise.all([subscriptionsFor(deps.db, email), hasVault(deps.db, email)]);
    // Someone whose access has ended may still sign in while their encrypted
    // plans are kept (vault.js), to take them away; the app stays closed to them.
    if (!hasAccess({ email, subscriptions, complimentary: deps.config.complimentary }) && !kept) return;

    // After the reply: the token's write and the email are the slow parts.
    deps.defer(sendLink(deps, email).catch((e) => console.error('[auth] sign-in link failed:', e.message)));
}

/** Make a link for `email` and send it, unless the address has had its share lately. */
async function sendLink(deps, email) {
    const now = deps.now();
    // A fourth request inside the window gets no email and no error, so an
    // attacker cannot fill someone's inbox and cannot see that they were stopped.
    if (await countLoginTokens(deps.db, { email, since: now - LINK_TTL_MS }) >= MAX_LINKS_PER_WINDOW) return;

    const token = randomToken();
    await createLoginToken(deps.db, { tokenHash: await sha256Hex(token), email, now, ttlMs: LINK_TTL_MS });
    const link = `${deps.config.appOrigin}/auth/confirm#t=${token}`;
    await deps.sendEmail({ to: email, link, minutes: LINK_TTL_MS / MINUTE });
}

/** Spend a link and start a session. Returns { sessionToken } or null if the link is no good. */
export async function verifyLogin(deps, token, ip) {
    if (!(await deps.rateLimit(`verify:${ip}`))) throw new HttpError(429, 'rate_limited');
    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return null;
    const now = deps.now();
    const email = await consumeLoginToken(deps.db, { tokenHash: await sha256Hex(token), now });
    if (!email) return null;
    const sessionToken = randomToken();
    await createSession(deps.db, { tokenHash: await sha256Hex(sessionToken), email, now, ttlMs: SESSION_TTL_MS });
    return { sessionToken };
}

/**
 * Who is this request? Returns { email, tokenHash, subscriptions } for a live
 * session, or null for none (no cookie, malformed, unknown or expired).
 */
export async function currentSession(deps, request) {
    const value = readCookie(request, deps.config.cookieName);
    if (!value || !TOKEN_SHAPE.test(value)) return null;
    const tokenHash = await sha256Hex(value);
    const session = await findSession(deps.db, { tokenHash, now: deps.now() });
    return session ? { ...session, tokenHash } : null;
}

export async function endSession(deps, request) {
    const session = await currentSession(deps, request);
    if (session) await deleteSession(deps.db, session.tokenHash);
}
