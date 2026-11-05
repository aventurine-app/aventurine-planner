// The encrypted vault: who may use it, conditional writes between devices,
// pulling changes, erasing, and the 60-day retention after access ends.

import assert from 'node:assert/strict';
import test from 'node:test';

import { LIMITS, RETENTION_MS } from '../../worker/src/vault.js';
import { createSite, customerEvent, OWNER, subscriptionEvent } from './harness.mjs';

const DAY = 24 * 60 * 60 * 1000;

/** Stand-in ciphertext: the server only ever sees opaque text of this shape. */
const sealed = (text) => `v1.${Buffer.from(text).toString('base64url')}`;

async function send(site, cookie, method, path, json) {
    const r = await site.call(path, { method, cookie, json });
    return { status: r.status, body: await r.json() };
}

/** A signed-in subscriber; `n` keeps customers apart. */
async function member(site, email = 'alice@example.com', n = 'alice') {
    await site.subscribe({ email, customerId: `ctm_01${n}`, subscriptionId: `sub_01${n}` });
    return site.signIn(email);
}

/** A subscriber with a vault. Returns { cookie, vault }. */
async function withVault(site, email, n) {
    const cookie = await member(site, email, n);
    const { body } = await send(site, cookie, 'PUT', '/api/vault', { wrappedKey: sealed('key'), baseKeyVersion: 0 });
    return { cookie, vault: body.vault };
}

const put = (site, cookie, vault, id, baseVersion, data) =>
    send(site, cookie, 'PUT', `/api/vault/items/${id}`, { vaultId: vault.id, baseVersion, data });

const pull = (site, cookie, vault, since = 0) =>
    send(site, cookie, 'GET', `/api/vault/items?vault=${vault.id}&since=${since}`);

function cancel(site, n = 'alice') {
    return site.webhook(subscriptionEvent({
        subscriptionId: `sub_01${n}`, customerId: `ctm_01${n}`, status: 'canceled', type: 'subscription.canceled', at: site.iso(),
    }));
}

// ── Who may use it ─────────────────────────────────────────────────────────

test('the vault needs a session; without access it can be read, not changed', async (t) => {
    const site = createSite();
    t.after(site.restore);
    assert.equal((await send(site, null, 'GET', '/api/vault')).status, 401);

    const { cookie, vault } = await withVault(site);
    await put(site, cookie, vault, 'p_1', 0, sealed('plan'));
    site.advance(1000);
    await cancel(site);

    const r = await send(site, cookie, 'GET', '/api/vault');
    assert.equal(r.status, 200);
    assert.equal(r.body.access, false);
    assert.equal(r.body.vault.id, vault.id);
    assert.equal((await pull(site, cookie, vault)).body.items.length, 1, 'the export page can read every item');

    for (const [method, path, json] of [
        ['PUT', '/api/vault/items/p_1', { vaultId: vault.id, baseVersion: 1, data: sealed('edit') }],
        ['PUT', '/api/vault', { wrappedKey: sealed('k2'), baseKeyVersion: 1, vaultId: vault.id }],
        ['DELETE', '/api/vault', { vaultId: vault.id }],
    ]) {
        const refused = await send(site, cookie, method, path, json);
        assert.equal(refused.status, 403, `${method} ${path}`);
        assert.equal(refused.body.error, 'no_subscription');
    }
});

test('without access, the vault says when it will be erased, and reading it does not put that off', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const log = console.log;
    console.log = () => {};
    t.after(() => { console.log = log; });
    const { cookie, vault } = await withVault(site);
    assert.equal((await send(site, cookie, 'GET', '/api/vault')).body.keptUntil, null, 'not while subscribed');

    site.advance(3 * DAY);
    await cancel(site);
    const cancelledAt = site.clock.now;
    site.advance(2 * DAY);
    assert.equal((await send(site, cookie, 'GET', '/api/vault')).body.keptUntil, cancelledAt + RETENTION_MS);

    // Exporting every few weeks does not keep the vault alive.
    for (let i = 0; i < 3; i++) {
        site.advance(20 * DAY);
        await pull(site, cookie, vault);
    }
    await site.cron();
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM vaults').get().n, 0);
});

test('a lapsed customer with saved plans may still sign in; one without may not', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await withVault(site, 'alice@example.com', 'alice');
    await member(site, 'bob@example.com', 'bob');
    site.advance(1000);
    await cancel(site, 'alice');
    await cancel(site, 'bob');
    const before = site.sent.emails.length;
    for (const email of ['alice@example.com', 'bob@example.com']) {
        assert.equal((await site.call('/api/auth/request', { method: 'POST', json: { email } })).status, 202);
    }
    assert.deepEqual(site.sent.emails.slice(before).map((m) => m.to[0]), ['alice@example.com']);
});

test('changes to the vault must come from our own origin', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const cookie = await member(site);
    const r = await site.call('/api/vault', {
        method: 'PUT', cookie, json: { wrappedKey: sealed('k'), baseKeyVersion: 0 }, origin: 'https://evil.example',
    });
    assert.equal(r.status, 403);
    assert.equal((await send(site, cookie, 'GET', '/api/vault')).body.vault, null);
});

test('only the listed methods reach the vault', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const cookie = await member(site);
    for (const [method, path] of [['POST', '/api/vault'], ['DELETE', '/api/vault/items'], ['GET', '/api/vault/items/p_1']]) {
        assert.equal((await site.call(path, { method, cookie })).status, 405, `${method} ${path}`);
    }
    assert.equal((await site.call('/api/vault/other', { cookie })).status, 404);
});

test('one account never sees another\'s vault', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const alice = await withVault(site, 'alice@example.com', 'alice');
    await put(site, alice.cookie, alice.vault, 'p_1', 0, sealed('alice plan'));
    const bob = await member(site, 'bob@example.com', 'bob');

    assert.equal((await send(site, bob, 'GET', '/api/vault')).body.vault, null);
    const r = await pull(site, bob, alice.vault);
    assert.equal(r.status, 404, 'alice\'s vault id means nothing to bob');
    assert.equal((await put(site, bob, alice.vault, 'p_1', 1, sealed('overwrite'))).status, 404);
    assert.equal((await pull(site, alice.cookie, alice.vault)).body.items[0].data, sealed('alice plan'));
});

// ── The key ────────────────────────────────────────────────────────────────

test('the wrapped key is created once and replaced only from the current version', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const cookie = await member(site);
    assert.deepEqual((await send(site, cookie, 'GET', '/api/vault')).body,
        { ok: true, email: 'alice@example.com', access: true, keptUntil: null, vault: null });

    const created = await send(site, cookie, 'PUT', '/api/vault', { wrappedKey: sealed('k1'), baseKeyVersion: 0 });
    assert.equal(created.status, 200);
    const vault = created.body.vault;
    assert.match(vault.id, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(vault.keyVersion, 1);

    // A second device setting up at the same time loses, and is handed the winner.
    const second = await send(site, cookie, 'PUT', '/api/vault', { wrappedKey: sealed('k-other'), baseKeyVersion: 0 });
    assert.equal(second.status, 409);
    assert.equal(second.body.vault.wrappedKey, sealed('k1'));

    const rotated = await send(site, cookie, 'PUT', '/api/vault', { wrappedKey: sealed('k2'), baseKeyVersion: 1, vaultId: vault.id });
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.vault.keyVersion, 2);
    assert.equal(rotated.body.vault.id, vault.id, 'a new recovery key keeps the vault and its data key');

    const stale = await send(site, cookie, 'PUT', '/api/vault', { wrappedKey: sealed('k3'), baseKeyVersion: 1, vaultId: vault.id });
    assert.equal(stale.status, 409);
    assert.equal((await send(site, cookie, 'GET', '/api/vault')).body.vault.wrappedKey, sealed('k2'));
});

test('a malformed key request is refused', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const cookie = await member(site);
    for (const body of [
        {}, { wrappedKey: sealed('k') }, { wrappedKey: 'not sealed!', baseKeyVersion: 0 },
        { wrappedKey: sealed('k'), baseKeyVersion: -1 }, { wrappedKey: sealed('k'), baseKeyVersion: 1 },
        { wrappedKey: 'a'.repeat(LIMITS.wrappedKeyBytes + 1), baseKeyVersion: 0 },
    ]) {
        assert.ok([400, 413].includes((await send(site, cookie, 'PUT', '/api/vault', body)).status), JSON.stringify(body).slice(0, 60));
    }
});

// ── Items ──────────────────────────────────────────────────────────────────

test('items are written only over the version the writer saw', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const { cookie, vault } = await withVault(site);

    const made = await put(site, cookie, vault, 'p_abc', 0, sealed('v1'));
    assert.equal(made.status, 200);
    assert.equal(made.body.item.version, 1);

    // The same plan "created" again by a device that has not pulled yet.
    const dup = await put(site, cookie, vault, 'p_abc', 0, sealed('other'));
    assert.equal(dup.status, 409);
    assert.equal(dup.body.current.data, sealed('v1'));

    assert.equal((await put(site, cookie, vault, 'p_abc', 1, sealed('v2'))).body.item.version, 2);
    const stale = await put(site, cookie, vault, 'p_abc', 1, sealed('stale edit'));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.current.version, 2);
    assert.equal(stale.body.current.data, sealed('v2'));
});

test('deleting leaves a marker, so other devices learn of it', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const { cookie, vault } = await withVault(site);
    await put(site, cookie, vault, 'p_1', 0, sealed('plan'));
    const { cursor } = (await pull(site, cookie, vault)).body;

    assert.equal((await put(site, cookie, vault, 'p_1', 1, null)).status, 200);
    const later = (await pull(site, cookie, vault, cursor)).body;
    assert.equal(later.items.length, 1);
    assert.equal(later.items[0].data, null);
    assert.equal(later.items[0].version, 2);

    assert.equal((await put(site, cookie, vault, 'p_never', 0, null)).status, 400, 'nothing to delete');
});

test('a pull returns what changed since the cursor, in pages', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const { cookie, vault } = await withVault(site);
    const total = LIMITS.page + 5;
    for (let i = 0; i < total; i++) await put(site, cookie, vault, `p_${i}`, 0, sealed(`plan ${i}`));

    const first = (await pull(site, cookie, vault)).body;
    assert.equal(first.items.length, LIMITS.page);
    assert.equal(first.more, true);
    const second = (await pull(site, cookie, vault, first.cursor)).body;
    assert.equal(second.items.length, 5);
    assert.equal(second.more, false);
    assert.deepEqual(new Set([...first.items, ...second.items].map((i) => i.id)).size, total);

    const quiet = (await pull(site, cookie, vault, second.cursor)).body;
    assert.deepEqual(quiet.items, []);
    assert.equal(quiet.cursor, second.cursor);

    await put(site, cookie, vault, 'p_3', 1, sealed('edited'));
    const changed = (await pull(site, cookie, vault, second.cursor)).body;
    assert.deepEqual(changed.items.map((i) => [i.id, i.data]), [['p_3', sealed('edited')]]);
});

test('a refused write does not make the next pull fetch anything again', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const { cookie, vault } = await withVault(site);
    await put(site, cookie, vault, 'p_1', 0, sealed('v1'));
    const { cursor } = (await pull(site, cookie, vault)).body;
    assert.equal((await put(site, cookie, vault, 'p_1', 7, sealed('stale'))).status, 409);
    const after = (await pull(site, cookie, vault, cursor)).body;
    assert.deepEqual(after.items, []);
});

test('malformed item writes are refused', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const { cookie, vault } = await withVault(site);
    const cases = [
        ['p_1', { vaultId: vault.id, baseVersion: 0, data: 'has spaces' }],
        ['p_1', { vaultId: vault.id, baseVersion: 0, data: '' }],
        ['p_1', { vaultId: vault.id, baseVersion: 0 }],
        ['p_1', { vaultId: vault.id, baseVersion: 1.5, data: sealed('x') }],
        ['p_1', { vaultId: 'nope', baseVersion: 0, data: sealed('x') }],
        ['p.1', { vaultId: vault.id, baseVersion: 0, data: sealed('x') }],
        ['x'.repeat(65), { vaultId: vault.id, baseVersion: 0, data: sealed('x') }],
    ];
    for (const [id, body] of cases) {
        assert.equal((await send(site, cookie, 'PUT', `/api/vault/items/${id}`, body)).status, 400, `${id} ${JSON.stringify(body)}`);
    }
    const huge = await put(site, cookie, vault, 'p_1', 0, 'a'.repeat(LIMITS.itemBytes + 1));
    assert.ok([400, 413].includes(huge.status));
    assert.equal((await pull(site, cookie, vault, 0)).body.items.length, 0);
});

test('a full vault refuses more, but still takes edits that fit', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const saved = { ...LIMITS };
    t.after(() => Object.assign(LIMITS, saved));
    LIMITS.vaultBytes = 100;
    LIMITS.items = 3;
    const { cookie, vault } = await withVault(site);

    assert.equal((await put(site, cookie, vault, 'p_1', 0, 'a'.repeat(60))).status, 200);
    assert.equal((await put(site, cookie, vault, 'p_2', 0, 'b'.repeat(60))).status, 507, 'over the byte limit');
    assert.equal((await put(site, cookie, vault, 'p_1', 1, 'c'.repeat(90))).status, 200, 'replacing an item counts only the new size');
    await put(site, cookie, vault, 'p_2', 0, 'd');
    await put(site, cookie, vault, 'p_3', 0, 'e');
    assert.equal((await put(site, cookie, vault, 'p_4', 0, 'f')).status, 507, 'over the item limit');
});

// ── Erasing, and devices with an old key ───────────────────────────────────

test('erasing needs the vault\'s id, and an erased vault\'s devices are stopped', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const { cookie, vault } = await withVault(site);
    await put(site, cookie, vault, 'p_1', 0, sealed('plan'));

    assert.equal((await send(site, cookie, 'DELETE', '/api/vault', { vaultId: 'A'.repeat(22) })).status, 409);
    assert.equal((await send(site, cookie, 'DELETE', '/api/vault', { vaultId: vault.id })).status, 200);
    assert.equal((await send(site, cookie, 'GET', '/api/vault')).body.vault, null);
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM vault_items').get().n, 0);

    // Starting over makes a new vault; a device still on the old one must not write into it.
    const fresh = (await send(site, cookie, 'PUT', '/api/vault', { wrappedKey: sealed('new key'), baseKeyVersion: 0 })).body.vault;
    assert.notEqual(fresh.id, vault.id);
    const old = await put(site, cookie, vault, 'p_1', 1, sealed('under the old key'));
    assert.equal(old.status, 409);
    assert.equal(old.body.error, 'vault_changed');
    assert.equal((await pull(site, cookie, vault)).body.error, 'vault_changed');
    assert.deepEqual((await pull(site, cookie, fresh)).body.items, []);
});

test('a customer\'s vault follows them to a new email', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const { cookie, vault } = await withVault(site, 'old@example.com', 'alice');
    await put(site, cookie, vault, 'p_1', 0, sealed('plan'));

    site.advance(1000);
    await site.webhook(customerEvent({ customerId: 'ctm_01alice', email: 'new@example.com', type: 'customer.updated', at: site.iso() }));
    const moved = await site.signIn('new@example.com');
    assert.equal((await send(site, moved, 'GET', '/api/vault')).body.vault.id, vault.id);
    assert.equal((await pull(site, moved, vault)).body.items[0].data, sealed('plan'));
});

// ── Retention ──────────────────────────────────────────────────────────────

test('a lapsed vault is kept for 60 days, then erased', async (t) => {
    const site = createSite();
    t.after(site.restore);
    assert.equal(RETENTION_MS, 60 * DAY);
    const { cookie, vault } = await withVault(site);
    await put(site, cookie, vault, 'p_1', 0, sealed('plan'));
    const log = console.log;
    console.log = () => {};
    t.after(() => { console.log = log; });

    site.advance(5 * DAY);
    await cancel(site);
    site.advance(59 * DAY);
    await site.cron();
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM vaults').get().n, 1, 'kept within 60 days of cancelling');

    site.advance(2 * DAY);
    await site.cron();
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM vaults').get().n, 0);
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM vault_items').get().n, 0);
});

test('resubscribing within 60 days finds everything as it was', async (t) => {
    const site = createSite();
    t.after(site.restore);
    const { vault } = await withVault(site);
    site.advance(DAY);
    await cancel(site);
    site.advance(40 * DAY);
    await site.webhook(subscriptionEvent({ subscriptionId: 'sub_01again', customerId: 'ctm_01alice', at: site.iso() }));
    site.advance(100 * DAY);
    await site.cron();
    const cookie = await site.signIn('alice@example.com');
    assert.equal((await send(site, cookie, 'GET', '/api/vault')).body.vault.id, vault.id);
});

test('subscribers and the complimentary list keep their vaults however long they are away', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await withVault(site, 'alice@example.com', 'alice');
    const owner = await site.signIn(OWNER);
    await send(site, owner, 'PUT', '/api/vault', { wrappedKey: sealed('k'), baseKeyVersion: 0 });
    site.advance(400 * DAY);
    await site.cron();
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM vaults').get().n, 2);
});

test('a run that would erase an implausible number of vaults erases none', async (t) => {
    const site = createSite();
    t.after(site.restore);
    for (let i = 0; i < 21; i++) await withVault(site, `user${i}@example.com`, `user${i}`);
    site.advance(DAY);
    for (let i = 0; i < 21; i++) await cancel(site, `user${i}`);
    site.advance(61 * DAY);

    const errors = [];
    const error = console.error;
    console.error = (m) => errors.push(m);
    t.after(() => { console.error = error; });
    await site.cron();
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM vaults').get().n, 21);
    assert.match(errors.join('\n'), /refusing to erase 21 of 21/);
});

test('with an unreadable config, the daily job erases nothing', async (t) => {
    const site = createSite();
    t.after(site.restore);
    await withVault(site);
    site.advance(DAY);
    await cancel(site);
    site.advance(61 * DAY);
    site.env.APP_ORIGIN = 'not a url';
    const error = console.error;
    console.error = () => {};
    t.after(() => { console.error = error; });
    await site.cron();
    assert.equal(site.db.sqlite.prepare('SELECT COUNT(*) AS n FROM vaults').get().n, 1);
});
