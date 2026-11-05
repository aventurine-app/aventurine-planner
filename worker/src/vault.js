// ─── vault.js ───────────────────────────────────────────────────────────────
// End-to-end encrypted storage for the user's plans, so they can sign in on
// any device and find them there.
//
// The browser does all the cryptography. It makes a random data key, encrypts
// each plan with it, and stores that key here only after encrypting it under a
// recovery key that it shows the user once and never sends. This server holds
// ciphertext and cannot read it, nor can anyone with a copy of the database:
// without the recovery key the data is unreadable, to us as much as anyone.
//
// What the server can see: the account's email, how many items it has and
// their sizes, the ids the app gives them (random, e.g. p_x7k2m9q4), and when
// each was written. Not a plan's name, contents or numbers.
//
//   GET    /api/vault                  { email, access, keptUntil, vault }: the wrapped key, or vault null
//   PUT    /api/vault                  { wrappedKey, baseKeyVersion }   create (0) or replace the wrapped key
//   DELETE /api/vault                  { vaultId }                      erase the vault and every item
//   GET    /api/vault/items?vault=&since=   items changed after `since`, in pages
//   PUT    /api/vault/items/:id        { vaultId, baseVersion, data }   write (data null deletes)
//
// Writes are conditional. Each names the version it replaces, and a stale one
// is refused with 409 and the current value, so two devices never silently
// overwrite each other; the browser decides what to keep. Each also names the
// vault, because erasing and re-creating a vault makes a new data key, and a
// device still holding the old key must not write with it.
//
// Retention: a vault is kept while its owner has access, and for 60 days after
// they lose it, so someone who resubscribes finds everything as they left it.
// After that the daily job erases it (purgeLapsedVaults). In those 60 days the
// owner may still sign in and read it (the GETs), to export their plans from
// the export page, but not change it; reading does not restart the clock.

import { hasAccess } from './access.js';
import { currentSession } from './auth.js';
import { randomToken } from './crypto.js';
import { HttpError, json, readJsonBody, requireSameOrigin } from './http.js';
import {
    countVaults, createVault, deleteVault, getVault, getVaultItem, idleVaults, replaceVaultKey, touchVault,
    vaultItemsSince, vaultUsage, writeVaultItem,
} from './store.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export const RETENTION_MS = 60 * DAY;
const TOUCH_EVERY_MS = HOUR;

// Generous for what the app stores (at most 15 plans, a few KB to tens of KB
// each), and well inside D1's 2 MB per value.
export const LIMITS = {
    itemBytes: 512 * 1024,       // one item's ciphertext
    vaultBytes: 16 * 1024 * 1024, // all of an account's ciphertext
    items: 5000,                 // rows, deleted ones included
    wrappedKeyBytes: 1024,
    page: 25,                    // items per pull
};

// If one daily run would erase more vaults than this, something is wrong (a
// webhook outage, a bad deploy), so it erases none and says so in the logs.
const PURGE_SANITY = { atLeast: 20, fraction: 0.1 };

const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/;
const VAULT_ID = /^[A-Za-z0-9_-]{22}$/;
// The browser's own format (base64url segments joined by dots). The server
// only checks that it is text of that shape, never what it says.
const SEALED = /^[A-Za-z0-9_.-]+$/;

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isVaultId = (v) => typeof v === 'string' && VAULT_ID.test(v);

function vaultView(row) {
    return { id: row.id, wrappedKey: row.wrapped_key, keyVersion: row.key_version, seq: row.seq };
}

function itemView(row) {
    return row && { id: row.id, version: row.version, seq: row.seq, data: row.data, updatedAt: row.updated_at };
}

/** Is this a sealed value no longer than `max`? */
function isSealed(value, max) {
    return typeof value === 'string' && value.length > 0 && value.length <= max && SEALED.test(value);
}

/**
 * Who is asking: { email, access, subscriptions }, or an HttpError. Without
 * access only reading is allowed (`readOnly`), for the export page.
 */
async function owner(deps, request, { readOnly }) {
    const session = await currentSession(deps, request);
    if (!session) throw new HttpError(401, 'signed_out');
    const access = hasAccess({ ...session, complimentary: deps.config.complimentary });
    if (!access && !readOnly) throw new HttpError(403, 'no_subscription');
    return { email: session.email, access, subscriptions: session.subscriptions };
}

/** When the daily job may erase a vault whose owner has no access: 60 days after its last use or subscription change. */
function keptUntil(vault, subscriptions) {
    return Math.max(vault.last_seen_at, ...subscriptions.map((s) => s.updated_at)) + RETENTION_MS;
}

/** The vault, or an HttpError: 404 if there is none, 409 if it is not `vaultId`. */
async function requireVault(db, email, vaultId) {
    const vault = await getVault(db, email);
    if (!vault) throw new HttpError(404, 'no_vault');
    if (vault.id !== vaultId) throw new HttpError(409, 'vault_changed');
    return vault;
}

// ── The key ─────────────────────────────────────────────────────────────────

/**
 * The wrapped key, and whose vault it is: a browser keeps one account's plans
 * at a time. Without access, also when the vault may be erased (`keptUntil`).
 */
async function readKey(deps, { email, access, subscriptions }) {
    const vault = await getVault(deps.db, email);
    return json({
        ok: true, email, access,
        keptUntil: vault && !access ? keptUntil(vault, subscriptions) : null,
        vault: vault && vaultView(vault),
    });
}

async function putKey(deps, email, body) {
    const { wrappedKey, baseKeyVersion, vaultId } = body;
    if (!isSealed(wrappedKey, LIMITS.wrappedKeyBytes) || !isCount(baseKeyVersion)) throw new HttpError(400, 'bad_request');
    if (baseKeyVersion > 0 && !isVaultId(vaultId)) throw new HttpError(400, 'bad_request');

    const done = baseKeyVersion === 0
        ? await createVault(deps.db, { email, id: randomToken(16), wrappedKey, now: deps.now() })
        : await replaceVaultKey(deps.db, { email, vaultId, wrappedKey, baseKeyVersion });
    const vault = await getVault(deps.db, email);
    if (!done) return json({ ok: false, error: 'conflict', vault: vault && vaultView(vault) }, 409);
    return json({ ok: true, vault: vaultView(vault) });
}

async function eraseVault(deps, email, body) {
    if (!isVaultId(body.vaultId)) throw new HttpError(400, 'bad_request');
    if (!(await deleteVault(deps.db, { email, vaultId: body.vaultId }))) throw new HttpError(409, 'vault_changed');
    return json({ ok: true });
}

// ── Items ───────────────────────────────────────────────────────────────────

async function pull(deps, email, url) {
    const since = Number(url.searchParams.get('since') ?? 0);
    const vaultId = url.searchParams.get('vault');
    if (!isCount(since) || !isVaultId(vaultId)) throw new HttpError(400, 'bad_request');
    const vault = await requireVault(deps.db, email, vaultId);
    const rows = await vaultItemsSince(deps.db, { email, since, limit: LIMITS.page });
    const more = rows.length === LIMITS.page;
    // Caught up: the cursor is the vault's own counter, so a write that was
    // refused (which still uses up a number) is not fetched again and again.
    const cursor = more ? rows.at(-1).seq : Math.max(vault.seq, since);
    return json({ ok: true, items: rows.map(itemView), cursor, more });
}

async function push(deps, email, id, body) {
    const { vaultId, baseVersion, data } = body;
    if (!ITEM_ID.test(id) || !isVaultId(vaultId) || !isCount(baseVersion)) throw new HttpError(400, 'bad_request');
    if (data !== null && !isSealed(data, LIMITS.itemBytes)) throw new HttpError(400, 'bad_request');
    if (data === null && baseVersion === 0) throw new HttpError(400, 'bad_request');
    await requireVault(deps.db, email, vaultId);

    if (data !== null) {
        const usage = await vaultUsage(deps.db, { email, id });
        const isNew = baseVersion === 0;
        if ((isNew && usage.items >= LIMITS.items) || usage.bytes - usage.mine + data.length > LIMITS.vaultBytes) {
            throw new HttpError(507, 'vault_full');
        }
    }

    const written = await writeVaultItem(deps.db, { email, vaultId, id, baseVersion, data, now: deps.now() });
    const current = itemView(await getVaultItem(deps.db, { email, id }));
    if (!written) {
        // Lost a race with another device, or the vault was erased meanwhile.
        await requireVault(deps.db, email, vaultId);
        return json({ ok: false, error: 'conflict', current }, 409);
    }
    return json({ ok: true, item: { id, version: current.version, seq: current.seq, updatedAt: current.updatedAt } });
}

// ── Routing ─────────────────────────────────────────────────────────────────

/** Is this one of the vault's routes? */
export const isVaultPath = (path) => path === '/api/vault' || path.startsWith('/api/vault/');

/** Handle a request under /api/vault. `deps` is the worker's { db, config, now, … }. */
export async function handleVault(request, deps, path) {
    const method = request.method;
    const url = new URL(request.url);
    const itemMatch = /^\/api\/vault\/items\/([^/]+)$/.exec(path);
    const route = path === '/api/vault' ? 'vault' : path === '/api/vault/items' ? 'items' : itemMatch ? 'item' : null;
    if (!route) return json({ ok: false, error: 'not_found' }, 404);

    const allowed = { vault: ['GET', 'PUT', 'DELETE'], items: ['GET'], item: ['PUT'] }[route];
    if (!allowed.includes(method)) return json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: allowed.join(', ') });
    if (method !== 'GET') requireSameOrigin(request, deps.config.appOrigin);

    const who = await owner(deps, request, { readOnly: method === 'GET' });
    const { email } = who;
    // The retention clock: last used, with access. Exporting after access ends does not restart it.
    if (who.access) await touchVault(deps.db, { email, now: deps.now(), everyMs: TOUCH_EVERY_MS });

    if (route === 'vault') {
        if (method === 'GET') return readKey(deps, who);
        const body = await readJsonBody(request, LIMITS.wrappedKeyBytes + 512);
        return method === 'PUT' ? putKey(deps, email, body) : eraseVault(deps, email, body);
    }
    if (route === 'items') return pull(deps, email, url);
    return push(deps, email, itemMatch[1], await readJsonBody(request, LIMITS.itemBytes + 1024));
}

// ── Retention ───────────────────────────────────────────────────────────────

/**
 * Erase the vaults of people who lost access more than RETENTION_MS ago. A
 * vault is erased only when its owner has no access now, it has not been used
 * in that time, and no change to their subscriptions happened in that time
 * either (a cancellation is the last change). Returns how many were erased.
 */
export async function purgeLapsedVaults(db, { now, complimentary, logger = console }) {
    const cutoff = now - RETENTION_MS;
    const lapsed = (await idleVaults(db, cutoff)).filter((v) => {
        if (hasAccess({ email: v.email, subscriptions: v.subscriptions, complimentary })) return false;
        return Math.max(v.lastSeenAt, ...v.subscriptions.map((s) => s.updated_at)) < cutoff;
    });
    if (!lapsed.length) return 0;

    const total = await countVaults(db);
    if (lapsed.length > Math.max(PURGE_SANITY.atLeast, total * PURGE_SANITY.fraction)) {
        logger.error(`[vault] refusing to erase ${lapsed.length} of ${total} vaults in one run; check the subscriptions data`);
        return 0;
    }
    let erased = 0;
    for (const v of lapsed) {
        if (await deleteVault(db, { email: v.email, vaultId: v.id })) erased++;
    }
    logger.log(`[vault] erased ${erased} vault(s) past the ${RETENTION_MS / DAY}-day retention period`);
    return erased;
}
