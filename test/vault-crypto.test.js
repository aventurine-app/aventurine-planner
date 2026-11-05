'use strict';

// The cryptography behind encrypted sync: recovery keys a person can type,
// a data key only the recovery key unwraps, and items bound to their place.

const assert = require('node:assert/strict');
const test = require('node:test');

const V = require('../static/js/web/vault-crypto.js');

// What the worker accepts as sealed text (worker/src/vault.js, SEALED).
const SEALED = /^[A-Za-z0-9_.-]+$/;
const context = { vaultId: 'AAAAAAAAAAAAAAAAAAAAAA', id: 'p_abc123', version: 1 };

async function rejectsWith(promise, code) {
    await assert.rejects(promise, (e) => e instanceof V.VaultCryptoError && e.code === code);
}

// ── Recovery keys ──────────────────────────────────────────────────────────

test('a recovery key is 32 unambiguous characters in groups of four', () => {
    const { bytes, text } = V.createRecoveryKey();
    assert.equal(bytes.length, 20);
    assert.match(text, /^([0-9A-HJKMNP-TV-Z]{4}-){7}[0-9A-HJKMNP-TV-Z]{4}$/);
    assert.deepEqual(V.parseRecoveryKey(text), bytes);
    assert.notEqual(V.createRecoveryKey().text, text);
});

test('a recovery key is read as people type it', () => {
    const { bytes, text } = V.createRecoveryKey();
    const plain = text.replace(/-/g, '');
    for (const typed of [plain, plain.toLowerCase(), text.replace(/-/g, ' '), ` ${text}\n`]) {
        assert.deepEqual(V.parseRecoveryKey(typed), bytes, typed);
    }
    // The look-alikes: O for 0, I or L for 1.
    const zeros = V.formatRecoveryKey('0'.repeat(16) + '1'.repeat(16));
    assert.deepEqual(V.parseRecoveryKey(zeros.replace(/0/g, 'O').replace(/1/g, 'l')), V.parseRecoveryKey(zeros));
});

test('a mistyped recovery key is a format error, not a wrong key', () => {
    const plain = V.createRecoveryKey().text.replace(/-/g, '');
    for (const typed of ['', plain.slice(1), `${plain}A`, `U${plain.slice(1)}`, `!${plain.slice(1)}`, null]) {
        assert.throws(() => V.parseRecoveryKey(typed), (e) => e.code === 'format', String(typed));
    }
});

// ── The data key ───────────────────────────────────────────────────────────

test('only the recovery key unwraps the data key', async () => {
    const recovery = V.createRecoveryKey();
    const dataKey = await V.createDataKey();
    const wrapped = await V.wrapDataKey(dataKey, recovery.bytes);
    assert.match(wrapped, SEALED);
    assert.ok(wrapped.startsWith('k1.') && wrapped.length < 1024);

    const unwrapped = await V.unwrapDataKey(wrapped, V.parseRecoveryKey(recovery.text));
    const sealed = await V.sealItem(dataKey, { hello: 'world' }, context);
    assert.deepEqual(await V.openItem(unwrapped, sealed, context), { hello: 'world' }, 'the same key');

    await rejectsWith(V.unwrapDataKey(wrapped, V.createRecoveryKey().bytes), 'wrong-key');
    const [k, salt, iv, body] = wrapped.split('.');
    const flipped = body.slice(0, -2) + (body.at(-2) === 'A' ? 'B' : 'A') + body.at(-1);
    await rejectsWith(V.unwrapDataKey([k, salt, iv, flipped].join('.'), recovery.bytes), 'wrong-key');
    await rejectsWith(V.unwrapDataKey('k2.a.b.c', recovery.bytes), 'corrupt');
});

test('a new recovery key wraps the same data key', async () => {
    const dataKey = await V.createDataKey();
    const first = V.createRecoveryKey();
    const second = V.createRecoveryKey();
    const sealed = await V.sealItem(dataKey, [1, 2, 3], context);
    const viaSecond = await V.unwrapDataKey(await V.wrapDataKey(dataKey, second.bytes), second.bytes);
    assert.deepEqual(await V.openItem(viaSecond, sealed, context), [1, 2, 3]);
    assert.notEqual(await V.wrapDataKey(dataKey, first.bytes), await V.wrapDataKey(dataKey, first.bytes), 'a fresh salt and iv each time');
});

// ── Items ──────────────────────────────────────────────────────────────────

test('a sealed item opens only as the item, version and vault it was sealed for', async () => {
    const dataKey = await V.createDataKey();
    const plan = { id: 'p_abc123', name: 'Retire at 55', nodes: [{ id: 'n_1', params: { balance: 12000 } }] };
    const sealed = await V.sealItem(dataKey, plan, context);
    assert.match(sealed, SEALED);
    assert.ok(!sealed.includes('Retire'), 'nothing readable');
    assert.deepEqual(await V.openItem(dataKey, sealed, context), plan);
    assert.notEqual(await V.sealItem(dataKey, plan, context), sealed, 'a fresh iv each time');

    for (const other of [{ ...context, id: 'p_other' }, { ...context, version: 2 }, { ...context, vaultId: 'B'.repeat(22) }]) {
        await rejectsWith(V.openItem(dataKey, sealed, other), 'corrupt');
    }
    await rejectsWith(V.openItem(await V.createDataKey(), sealed, context), 'corrupt');
    await rejectsWith(V.openItem(dataKey, `${sealed.slice(0, -1)}${sealed.at(-1) === 'A' ? 'B' : 'A'}`, context), 'corrupt');
    await rejectsWith(V.openItem(dataKey, 'v1.not+base64.x', context), 'corrupt');
    await rejectsWith(V.openItem(dataKey, 'v9.a.b', context), 'corrupt');
});
