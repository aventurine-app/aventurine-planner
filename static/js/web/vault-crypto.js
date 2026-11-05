'use strict';

// ─── vault-crypto.js ────────────────────────────────────────────────────────
// The cryptography behind encrypted sync. Everything runs in the browser, on
// WebCrypto; the server only ever receives the sealed strings made here.
//
//   recovery key   20 random bytes (160 bits), shown to the user once as 32
//                  characters in groups of four: K7QM-3RXA-…. It never leaves
//                  the device it was typed into.
//   data key       a random AES-256-GCM key that encrypts the plans. Stored on
//                  the server only wrapped (encrypted) under the recovery key,
//                  so a new recovery key never means re-encrypting the plans.
//   item           one plan (or the tab order, or the goals): JSON, sealed
//                  with the data key.
//
// Formats (base64url parts joined by dots, the shape the worker accepts):
//
//   wrapped key    k1.<salt>.<iv>.<ciphertext>   AES-GCM under HKDF-SHA-256(recovery key, salt)
//   item           v1.<iv>.<ciphertext>          AES-GCM under the data key
//
// Each item is bound to its vault, id and version as associated data, so the
// server cannot pass one plan off as another, or an old copy as a newer one.
//
// The recovery key is random, not chosen by a person, so it needs no slow
// password hashing: HKDF is enough, and 160 bits cannot be guessed.
//
// Dual-environment: window.PrismWeb in the page, CommonJS for tests (Node has
// the same WebCrypto as globalThis.crypto).

(function (root, factory) {
    const api = factory(globalThis.crypto);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.PrismWeb = Object.assign(root.PrismWeb || {}, { VaultCrypto: api });
}(typeof self !== 'undefined' ? self : this, function (webCrypto) {
    const subtle = webCrypto.subtle;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const RECOVERY_BYTES = 20;
    // Crockford's base32: no I, L, O or U, so it reads aloud and copies by hand.
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const RECOVERY_CHARS = (RECOVERY_BYTES * 8) / 5;
    const GROUP = 4;

    const WRAP_INFO = encoder.encode('aventurine-planner/recovery-key/v1');
    const WRAP_AAD = encoder.encode('aventurine-planner/data-key/v1');
    const ITEM_AAD = 'aventurine-planner/item/v1';

    /** A failure the person can act on. `code` says which. */
    class VaultCryptoError extends Error {
        constructor(code, message) {
            super(message);
            this.name = 'VaultCryptoError';
            this.code = code; // 'format' | 'wrong-key' | 'corrupt'
        }
    }

    // ── Encoding ───────────────────────────────────────────────────────────

    function toBase64Url(bytes) {
        let binary = '';
        for (const b of new Uint8Array(bytes)) binary += String.fromCharCode(b);
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function fromBase64Url(text) {
        if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new VaultCryptoError('corrupt', 'not base64url');
        const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
        return Uint8Array.from(binary, (c) => c.charCodeAt(0));
    }

    const randomBytes = (n) => webCrypto.getRandomValues(new Uint8Array(n));

    // ── Recovery key ───────────────────────────────────────────────────────

    /** 20 bytes as 32 base32 characters (5 bits each, no padding needed). */
    function encodeBase32(bytes) {
        let bits = 0;
        let value = 0;
        let out = '';
        for (const b of bytes) {
            value = (value << 8) | b;
            bits += 8;
            while (bits >= 5) {
                out += ALPHABET[(value >>> (bits - 5)) & 31];
                bits -= 5;
            }
        }
        return out;
    }

    /** A new recovery key: { bytes, text } with text grouped for display. */
    function createRecoveryKey() {
        const bytes = randomBytes(RECOVERY_BYTES);
        return { bytes, text: formatRecoveryKey(encodeBase32(bytes)) };
    }

    /** 32 characters as eight groups of four. */
    function formatRecoveryKey(chars) {
        return chars.match(new RegExp(`.{1,${GROUP}}`, 'g')).join('-');
    }

    /**
     * Read a recovery key as typed: any case, any spaces or dashes, and the
     * look-alikes O → 0 and I, L → 1. Throws VaultCryptoError('format').
     */
    function parseRecoveryKey(input) {
        const chars = String(input || '').toUpperCase().replace(/[\s-]/g, '')
            .replace(/O/g, '0').replace(/[IL]/g, '1');
        if (chars.length !== RECOVERY_CHARS) {
            throw new VaultCryptoError('format', `a recovery key has ${RECOVERY_CHARS} characters`);
        }
        const bytes = new Uint8Array(RECOVERY_BYTES);
        let bits = 0;
        let value = 0;
        let i = 0;
        for (const c of chars) {
            const digit = ALPHABET.indexOf(c);
            if (digit < 0) throw new VaultCryptoError('format', `"${c}" is not in a recovery key`);
            value = (value << 5) | digit;
            bits += 5;
            if (bits >= 8) {
                bytes[i++] = (value >>> (bits - 8)) & 255;
                bits -= 8;
            }
        }
        return bytes;
    }

    // ── Data key ───────────────────────────────────────────────────────────

    /**
     * A new data key. Extractable, because a device that still has it must be
     * able to wrap it under a new recovery key when the old one is lost.
     */
    function createDataKey() {
        return subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    }

    async function wrappingKey(recoveryBytes, salt) {
        const base = await subtle.importKey('raw', recoveryBytes, 'HKDF', false, ['deriveKey']);
        return subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt, info: WRAP_INFO },
            base, { name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey'],
        );
    }

    /** The data key, wrapped under the recovery key, as the `k1.` string the server stores. */
    async function wrapDataKey(dataKey, recoveryBytes) {
        const salt = randomBytes(16);
        const iv = randomBytes(12);
        const kek = await wrappingKey(recoveryBytes, salt);
        const wrapped = await subtle.wrapKey('raw', dataKey, kek, { name: 'AES-GCM', iv, additionalData: WRAP_AAD });
        return ['k1', toBase64Url(salt), toBase64Url(iv), toBase64Url(wrapped)].join('.');
    }

    /** The data key from its wrapped form. Throws VaultCryptoError('wrong-key') for another key. */
    async function unwrapDataKey(wrappedText, recoveryBytes) {
        const parts = String(wrappedText).split('.');
        if (parts.length !== 4 || parts[0] !== 'k1') throw new VaultCryptoError('corrupt', 'unknown wrapped key format');
        const [salt, iv, wrapped] = parts.slice(1).map(fromBase64Url);
        const kek = await wrappingKey(recoveryBytes, salt);
        try {
            return await subtle.unwrapKey(
                'raw', wrapped, kek, { name: 'AES-GCM', iv, additionalData: WRAP_AAD },
                { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
            );
        } catch {
            // AES-GCM cannot tell a wrong key from a damaged ciphertext; a wrong key is far likelier.
            throw new VaultCryptoError('wrong-key', 'this recovery key does not open this vault');
        }
    }

    // ── Items ──────────────────────────────────────────────────────────────

    const itemContext = ({ vaultId, id, version }) => encoder.encode(`${ITEM_AAD}|${vaultId}|${id}|${version}`);

    /** Seal a JSON value as item `id` at `version` of vault `vaultId`. */
    async function sealItem(dataKey, value, context) {
        const iv = randomBytes(12);
        const plaintext = encoder.encode(JSON.stringify(value));
        const sealed = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: itemContext(context) }, dataKey, plaintext);
        return ['v1', toBase64Url(iv), toBase64Url(sealed)].join('.');
    }

    /** Open a sealed item. Throws VaultCryptoError('corrupt') if it is not what `context` says. */
    async function openItem(dataKey, sealedText, context) {
        const parts = String(sealedText).split('.');
        if (parts.length !== 3 || parts[0] !== 'v1') throw new VaultCryptoError('corrupt', 'unknown item format');
        const [iv, sealed] = parts.slice(1).map(fromBase64Url);
        let plaintext;
        try {
            plaintext = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: itemContext(context) }, dataKey, sealed);
        } catch {
            throw new VaultCryptoError('corrupt', `item ${context.id} could not be opened`);
        }
        return JSON.parse(decoder.decode(plaintext));
    }

    return {
        VaultCryptoError,
        createRecoveryKey,
        formatRecoveryKey,
        parseRecoveryKey,
        createDataKey,
        wrapDataKey,
        unwrapDataKey,
        sealItem,
        openItem,
        RECOVERY_CHARS,
    };
}));
