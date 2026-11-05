// ─── store.js ───────────────────────────────────────────────────────────────
// Every database statement the worker runs. All values are bound parameters;
// nothing is built from input by string concatenation. `db` is a D1 database
// (or anything with the same prepare/bind/first/all/run shape, which is how the
// tests run it on SQLite).

// ── Billing state, from Paddle webhooks ─────────────────────────────────────
// Paddle does not promise to deliver events in order, so each write carries the
// event's occurred_at and only takes effect if it is newer than what is stored.
// That also makes a repeated delivery a no-op.

/**
 * Store a customer's email. If this changes it, the customer's vault follows,
 * since they will sign in with the new address from now on.
 */
export async function upsertCustomer(db, { id, email, occurredAt }) {
    const before = await db.prepare('SELECT email FROM customers WHERE id = ?').bind(id).first();
    const { meta } = await db.prepare(
        `INSERT INTO customers (id, email, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET email = excluded.email, updated_at = excluded.updated_at
         WHERE excluded.updated_at > customers.updated_at`,
    ).bind(id, email, occurredAt).run();
    if (meta.changes && before && before.email !== email) await moveVault(db, { from: before.email, to: email });
}

export async function upsertSubscription(db, s) {
    await db.prepare(
        `INSERT INTO subscriptions (id, customer_id, status, price_id, period_end, cancel_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET
             customer_id = excluded.customer_id, status = excluded.status, price_id = excluded.price_id,
             period_end = excluded.period_end, cancel_at = excluded.cancel_at, updated_at = excluded.updated_at
         WHERE excluded.updated_at > subscriptions.updated_at`,
    ).bind(s.id, s.customerId, s.status, s.priceId, s.periodEnd, s.cancelAt, s.occurredAt).run();
}

/** The subscriptions of the customer with this email; none for a stranger. */
export async function subscriptionsFor(db, email) {
    const { results } = await db.prepare(
        `SELECT s.status FROM customers c JOIN subscriptions s ON s.customer_id = c.id WHERE c.email = ?`,
    ).bind(email).all();
    return results;
}

/** Is there a Paddle customer with this email? */
export async function hasCustomer(db, email) {
    const row = await db.prepare('SELECT 1 AS found FROM customers WHERE email = ? LIMIT 1').bind(email).first();
    return Boolean(row);
}

// ── Sign-in links ───────────────────────────────────────────────────────────

export async function createLoginToken(db, { tokenHash, email, now, ttlMs }) {
    await db.prepare(
        'INSERT INTO login_tokens (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).bind(tokenHash, email, now, now + ttlMs).run();
}

/** How many links were sent to this email since `since`. */
export async function countLoginTokens(db, { email, since }) {
    const row = await db.prepare(
        'SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?',
    ).bind(email, since).first();
    return row.n;
}

/**
 * Spend a link. One statement, so two clicks racing cannot both succeed.
 * Returns the email it was sent to, or null if it is unknown, used or expired.
 */
export async function consumeLoginToken(db, { tokenHash, now }) {
    const row = await db.prepare(
        `UPDATE login_tokens SET used_at = ?
         WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?
         RETURNING email`,
    ).bind(now, tokenHash, now).first();
    return row ? row.email : null;
}

// ── Sessions ────────────────────────────────────────────────────────────────

export async function createSession(db, { tokenHash, email, now, ttlMs }) {
    await db.prepare(
        'INSERT INTO sessions (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).bind(tokenHash, email, now, now + ttlMs).run();
}

/**
 * The live session for a cookie, with that email's subscriptions. One query, so
 * checking access on every request costs a single round trip. Returns null if
 * there is no such session or it has expired.
 */
export async function findSession(db, { tokenHash, now }) {
    const { results } = await db.prepare(
        `SELECT se.email, se.expires_at, su.status, su.period_end, su.cancel_at, su.updated_at
         FROM sessions se
         LEFT JOIN customers c ON c.email = se.email
         LEFT JOIN subscriptions su ON su.customer_id = c.id
         WHERE se.token_hash = ? AND se.expires_at > ?`,
    ).bind(tokenHash, now).all();
    if (!results.length) return null;
    return {
        email: results[0].email,
        expiresAt: results[0].expires_at,
        subscriptions: results.filter((r) => r.status != null),
    };
}

export async function deleteSession(db, tokenHash) {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
}

// ── Vault (vault.js) ────────────────────────────────────────────────────────
// Everything stored here is ciphertext the server cannot read, apart from the
// bookkeeping columns.

/** Is there a vault for this email? (A lapsed subscriber may still sign in to export it.) */
export async function hasVault(db, email) {
    return (await db.prepare('SELECT 1 FROM vaults WHERE email = ?').bind(email).first()) != null;
}

export async function getVault(db, email) {
    return db.prepare(
        'SELECT id, wrapped_key, key_version, seq, last_seen_at FROM vaults WHERE email = ?',
    ).bind(email).first();
}

/** Create the vault. False if there already is one. */
export async function createVault(db, { email, id, wrappedKey, now }) {
    const { meta } = await db.prepare(
        `INSERT INTO vaults (email, id, wrapped_key, key_version, seq, created_at, last_seen_at)
         VALUES (?, ?, ?, 1, 0, ?, ?) ON CONFLICT (email) DO NOTHING`,
    ).bind(email, id, wrappedKey, now, now).run();
    return meta.changes === 1;
}

/** Replace the wrapped key (a new recovery key). False unless `baseKeyVersion` is current. */
export async function replaceVaultKey(db, { email, vaultId, wrappedKey, baseKeyVersion }) {
    const { meta } = await db.prepare(
        `UPDATE vaults SET wrapped_key = ?, key_version = key_version + 1
         WHERE email = ? AND id = ? AND key_version = ?`,
    ).bind(wrappedKey, email, vaultId, baseKeyVersion).run();
    return meta.changes === 1;
}

/** Note that the vault was used, at most once per `everyMs`, so reads rarely write. */
export async function touchVault(db, { email, now, everyMs }) {
    await db.prepare('UPDATE vaults SET last_seen_at = ? WHERE email = ? AND last_seen_at < ?')
        .bind(now, email, now - everyMs).run();
}

/** Delete the vault and everything in it. False unless it is the vault `vaultId`. */
export async function deleteVault(db, { email, vaultId }) {
    const [vault] = await db.batch([
        db.prepare('DELETE FROM vaults WHERE email = ? AND id = ?').bind(email, vaultId),
        db.prepare('DELETE FROM vault_items WHERE email = ? AND NOT EXISTS (SELECT 1 FROM vaults WHERE email = ?)')
            .bind(email, email),
    ]);
    return vault.meta.changes === 1;
}

/** Move a vault to a new email, unless one is already there. */
async function moveVault(db, { from, to }) {
    const free = 'NOT EXISTS (SELECT 1 FROM vaults WHERE email = ?)';
    await db.batch([
        db.prepare(`UPDATE vault_items SET email = ? WHERE email = ? AND ${free}`).bind(to, from, to),
        db.prepare(`UPDATE vaults SET email = ? WHERE email = ? AND ${free}`).bind(to, from, to),
    ]);
}

/** Rows (deleted ones included), live bytes, and the live bytes of item `id`. */
export async function vaultUsage(db, { email, id }) {
    return db.prepare(
        `SELECT COUNT(*) AS items, COALESCE(SUM(LENGTH(data)), 0) AS bytes,
                COALESCE(SUM(CASE WHEN id = ? THEN LENGTH(data) END), 0) AS mine
         FROM vault_items WHERE email = ?`,
    ).bind(id, email).first();
}

export async function getVaultItem(db, { email, id }) {
    return db.prepare('SELECT id, version, seq, data, updated_at FROM vault_items WHERE email = ? AND id = ?')
        .bind(email, id).first();
}

/**
 * Write an item (data null deletes it), only if its version is still
 * `baseVersion` (0: it must not exist yet) and the vault is still `vaultId`.
 * One transaction: the vault's change counter moves on and the item takes the
 * new value, so "changed since N" never misses a write. Returns true if written.
 */
export async function writeVaultItem(db, { email, vaultId, id, baseVersion, data, now }) {
    const vault = 'SELECT seq FROM vaults WHERE email = ? AND id = ?';
    const write = baseVersion === 0
        ? db.prepare(
            `INSERT INTO vault_items (email, id, version, seq, data, updated_at)
             SELECT ?, ?, 1, seq, ?, ? FROM vaults WHERE email = ? AND id = ?
             ON CONFLICT (email, id) DO NOTHING`,
        ).bind(email, id, data, now, email, vaultId)
        : db.prepare(
            `UPDATE vault_items SET version = version + 1, seq = (${vault}), data = ?, updated_at = ?
             WHERE email = ? AND id = ? AND version = ? AND EXISTS (${vault})`,
        ).bind(email, vaultId, data, now, email, id, baseVersion, email, vaultId);
    const [, written] = await db.batch([
        db.prepare('UPDATE vaults SET seq = seq + 1 WHERE email = ? AND id = ?').bind(email, vaultId),
        write,
    ]);
    return written.meta.changes === 1;
}

/** Items written after change `since`, oldest change first. */
export async function vaultItemsSince(db, { email, since, limit }) {
    const { results } = await db.prepare(
        `SELECT id, version, seq, data, updated_at FROM vault_items
         WHERE email = ? AND seq > ? ORDER BY seq LIMIT ?`,
    ).bind(email, since, limit).all();
    return results;
}

export async function countVaults(db) {
    return (await db.prepare('SELECT COUNT(*) AS n FROM vaults').first()).n;
}

/**
 * Vaults not used since `before`, each with its owner's subscriptions, for
 * the retention check. A vault with no Paddle customer has no subscriptions.
 */
export async function idleVaults(db, before) {
    const { results } = await db.prepare(
        `SELECT v.email, v.id, v.last_seen_at, s.status, s.updated_at
         FROM vaults v
         LEFT JOIN customers c ON c.email = v.email
         LEFT JOIN subscriptions s ON s.customer_id = c.id
         WHERE v.last_seen_at < ?`,
    ).bind(before).all();
    const byEmail = new Map();
    for (const r of results) {
        if (!byEmail.has(r.email)) byEmail.set(r.email, { email: r.email, id: r.id, lastSeenAt: r.last_seen_at, subscriptions: [] });
        if (r.status != null) byEmail.get(r.email).subscriptions.push({ status: r.status, updated_at: r.updated_at });
    }
    return [...byEmail.values()];
}

/** Drop expired links and sessions. Run on a schedule so the tables stay small. */
export async function pruneExpired(db, now) {
    await db.batch([
        db.prepare('DELETE FROM login_tokens WHERE expires_at < ?').bind(now),
        db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    ]);
}
