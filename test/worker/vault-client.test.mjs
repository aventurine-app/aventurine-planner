// The browser's vault code (static/js/web/vault-*.js) against the real worker:
// setting up, unlocking on another device, replacing a lost recovery key, and
// starting over, including two devices doing so at once.

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

import { createSite, subscriptionEvent } from './harness.mjs';

const require = createRequire(import.meta.url);
const { createVaultApi } = require('../../static/js/web/vault-api.js');
const { createVaultSession, VaultError } = require('../../static/js/web/vault-session.js');
const VaultCrypto = require('../../static/js/web/vault-crypto.js');

/** A device: its own key store, signed in as the account. */
function device(site, cookie) {
    const stored = new Map();
    const keys = {
        get: async (id) => stored.get(id) ?? null,
        put: async (record) => { stored.set(record.vaultId, record); },
        remove: async (id) => { stored.delete(id); },
    };
    const fetch = async (path, init) => site.call(path, { method: init.method, cookie, headers: init.headers, body: init.body });
    return { stored, session: createVaultSession({ api: createVaultApi({ fetch }), keys }) };
}

async function account(t) {
    const site = createSite();
    t.after(site.restore);
    await site.subscribe({ email: 'alice@example.com' });
    const cookie = await site.signIn('alice@example.com');
    return { site, cookie, laptop: device(site, cookie), phone: device(site, cookie) };
}

async function setUp(dev) {
    const pending = await dev.session.prepareSetup();
    return { recoveryKey: pending.recoveryKey, state: await pending.commit() };
}

const sealFor = (state, value, id = 'p_1', version = 1) =>
    VaultCrypto.sealItem(state.dataKey, value, { vaultId: state.vault.id, id, version });
const openFor = (state, sealed, id = 'p_1', version = 1) =>
    VaultCrypto.openItem(state.dataKey, sealed, { vaultId: state.vault.id, id, version });

test('setting up stores nothing until the recovery key has been shown and confirmed', async (t) => {
    const { site, laptop } = await account(t);
    assert.deepEqual(await laptop.session.check(), { state: 'setup' });

    const pending = await laptop.session.prepareSetup();
    assert.match(pending.recoveryKey, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    assert.deepEqual(await laptop.session.check(), { state: 'setup' }, 'nothing on the server yet');
    assert.equal(laptop.stored.size, 0);

    const ready = await pending.commit();
    assert.equal(ready.state, 'ready');
    assert.equal((await laptop.session.check()).state, 'ready');
    const row = site.db.sqlite.prepare('SELECT wrapped_key FROM vaults').get();
    assert.ok(!row.wrapped_key.includes(pending.recoveryKey.replace(/-/g, '')), 'the recovery key never reaches the server');
});

test('another device opens the vault with the recovery key, and only with it', async (t) => {
    const { laptop, phone } = await account(t);
    const { recoveryKey, state } = await setUp(laptop);
    const sealed = await sealFor(state, { name: 'House fund' });

    assert.equal((await phone.session.check()).state, 'locked');
    await assert.rejects(phone.session.unlock('ABCD-EFGH'), (e) => e.code === 'format');
    await assert.rejects(phone.session.unlock(VaultCrypto.createRecoveryKey().text), (e) => e.code === 'wrong-key');

    const opened = await phone.session.unlock(recoveryKey.toLowerCase().replace(/-/g, ' '));
    assert.equal(opened.state, 'ready');
    assert.deepEqual(await openFor(opened, sealed), { name: 'House fund' }, 'the same data key');
    assert.equal((await phone.session.check()).state, 'ready', 'remembered on this device');
});

test('two devices setting up at once: the first wins, the second is asked for its key', async (t) => {
    const { laptop, phone } = await account(t);
    const first = await laptop.session.prepareSetup();
    const second = await phone.session.prepareSetup();
    assert.equal((await first.commit()).state, 'ready');
    const lost = await second.commit();
    assert.equal(lost.state, 'locked');
    assert.equal(phone.stored.size, 0, 'the losing key is never kept');
    assert.equal((await phone.session.unlock(first.recoveryKey)).state, 'ready');
});

test('a device that still has the key can replace a lost recovery key', async (t) => {
    const { site, cookie, laptop, phone } = await account(t);
    const { recoveryKey: oldKey, state } = await setUp(laptop);
    const sealed = await sealFor(state, 'still readable');
    await phone.session.unlock(oldKey);

    const pending = await laptop.session.prepareNewKey(state);
    assert.notEqual(pending.recoveryKey, oldKey);
    const next = await pending.commit();
    assert.equal(next.vault.keyVersion, 2);
    assert.equal(next.vault.id, state.vault.id);

    // Devices that already hold the key carry on; a new one needs the new key.
    assert.equal((await phone.session.check()).state, 'ready');
    const tablet = device(site, cookie);
    await assert.rejects(tablet.session.unlock(oldKey), (e) => e.code === 'wrong-key');
    const opened = await tablet.session.unlock(pending.recoveryKey);
    assert.equal(await openFor(opened, sealed), 'still readable');
});

test('replacing the recovery key on two devices at once refuses the second', async (t) => {
    const { laptop, phone } = await account(t);
    const { recoveryKey, state } = await setUp(laptop);
    const phoneState = await phone.session.unlock(recoveryKey);
    const a = await laptop.session.prepareNewKey(state);
    const b = await phone.session.prepareNewKey(phoneState);
    await a.commit();
    await assert.rejects(b.commit(), (e) => e instanceof VaultError && e.code === 'conflict');
});

test('starting over erases the vault, and the old key opens nothing after', async (t) => {
    const { laptop, phone } = await account(t);
    const { recoveryKey } = await setUp(laptop);
    const locked = await phone.session.check();

    assert.deepEqual(await phone.session.startOver(locked.vault), { state: 'setup' });
    assert.equal((await laptop.session.check()).state, 'setup', 'every device sees it is gone');
    const fresh = await setUp(phone);
    assert.notEqual(fresh.recoveryKey, recoveryKey);
    assert.equal((await laptop.session.check()).state, 'locked', 'the laptop\'s old key is for the old vault');
    await assert.rejects(laptop.session.unlock(recoveryKey), (e) => e.code === 'wrong-key');
});

test('starting over from a stale screen does not erase a vault set up since', async (t) => {
    const { laptop, phone } = await account(t);
    await setUp(laptop);
    const stale = await phone.session.check();
    await laptop.session.startOver(stale.vault);
    const { recoveryKey } = await setUp(laptop);
    const after = await phone.session.startOver(stale.vault);
    assert.equal(after.state, 'locked');
    assert.equal((await phone.session.unlock(recoveryKey)).state, 'ready');
});

test('with no server to ask, the device carries on locally', async (t) => {
    const { site, cookie } = await account(t);
    const offline = createVaultSession({
        api: createVaultApi({ fetch: async () => { throw new TypeError('Failed to fetch'); } }),
        keys: { get: async () => null, put: async () => {}, remove: async () => {} },
    });
    assert.deepEqual(await offline.check(), { state: 'unavailable', reason: 'unreachable' });
    await assert.rejects(offline.unlock(VaultCrypto.createRecoveryKey().text), (e) => e.code === 'offline');

    const devServer = createVaultSession({
        api: createVaultApi({ fetch: async () => new Response('<!doctype html>', { status: 404, headers: { 'Content-Type': 'text/html' } }) }),
        keys: { get: async () => null },
    });
    assert.equal((await devServer.check()).reason, 'unreachable');

    const lapsed = device(site, cookie);
    site.advance(1000);
    await site.webhook(subscriptionEvent({ subscriptionId: 'sub_01alice', customerId: 'ctm_01alice', status: 'canceled', type: 'subscription.canceled', at: site.iso() }));
    assert.deepEqual(await lapsed.session.check(), { state: 'unavailable', reason: 'no-access' });
});
