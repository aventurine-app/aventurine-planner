// ─── http.js ────────────────────────────────────────────────────────────────
// Request and response helpers shared by every route: JSON replies, cookies,
// the same-origin check for anything that changes state, a bounded JSON body
// reader, and the security headers every response carries.

export class HttpError extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
        this.code = code;
    }
}

// The same policy the app's own pages carry in a <meta> tag, sent as a header
// too (a header also covers frame-ancestors, which a meta tag cannot).
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; "
    + "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; "
    + "frame-ancestors 'none'";

/** Add the headers every response should have. `secure` adds HSTS (https only). */
export function withSecurityHeaders(response, { secure, cache }) {
    const out = new Response(response.body, response);
    out.headers.set('Content-Security-Policy', CSP);
    out.headers.set('X-Content-Type-Options', 'nosniff');
    out.headers.set('Referrer-Policy', 'no-referrer');
    out.headers.set('X-Frame-Options', 'DENY');
    out.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    out.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    if (secure) out.headers.set('Strict-Transport-Security', 'max-age=31536000');
    // `private, no-cache`: a browser may keep a copy but must ask the worker
    // before using it, so a lapsed subscription is noticed on the next load.
    if (cache === 'private') out.headers.set('Cache-Control', 'private, no-cache');
    else if (cache === 'none') out.headers.set('Cache-Control', 'no-store');
    return out;
}

export function json(body, status = 200, headers = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
    });
}

export const redirect = (location, status = 302) => new Response(null, { status, headers: { Location: location } });

export function readCookie(request, name) {
    for (const part of (request.headers.get('Cookie') || '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
    }
    return null;
}

/** A Set-Cookie value for the session. HttpOnly, SameSite=Lax, and Secure over https. */
export function sessionCookie({ name, value, maxAgeSeconds, secure }) {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`;
}

/**
 * Refuse a state-changing request that did not come from our own page. Browsers
 * always send Origin on a cross-site POST, so a missing or different Origin is
 * rejected. (SameSite=Lax on the cookie is the first line; this is the second.)
 */
export function requireSameOrigin(request, appOrigin) {
    if (request.headers.get('Origin') !== appOrigin) throw new HttpError(403, 'forbidden');
}

/** Read a small JSON object body. */
export async function readJsonBody(request, maxBytes = 4096) {
    const type = request.headers.get('Content-Type') || '';
    if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type');
    // Refuse an oversized body before reading it, when it says how big it is.
    if (Number(request.headers.get('Content-Length') || 0) > maxBytes) throw new HttpError(413, 'too_large');
    const text = await request.text();
    if (text.length > maxBytes) throw new HttpError(413, 'too_large');
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        throw new HttpError(400, 'bad_json');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'bad_json');
    return body;
}
