'use strict';

// ─── vault-gate.js ──────────────────────────────────────────────────────────
// The screens between signing in and the plans, for encrypted sync:
//
//   Save your recovery key     the account has no vault yet. Shows a new key
//                              and creates the vault once the person says
//                              they have saved it.
//   Enter your recovery key    the account has a vault this device cannot
//                              open yet. "Lost your recovery key?" erases it
//                              (after a warning) and goes back to the first.
//
// Also "New Recovery Key" in Preferences → Account, for a device that still
// holds the key when the old recovery key is lost.
//
//   VaultGate.ensure()          resolves once the app may load: 'ready', or
//                               'unavailable' (no server: offline, local dev),
//                               in which case the app runs on this browser alone
//   VaultGate.current()         that state, kept up to date
//   VaultGate.newRecoveryKey()  the replace-key dialog; resolves true if replaced
//
// The logic and every server call are in web/vault-session.js; this file only
// draws. Not in the free sandbox (scripts/assemble.js drops it).

(function () {
    const root = document.getElementById('vault-screen');
    if (!root) return;
    const { createVaultSession, createVaultApi, openVaultKeys, fileDialogs, VaultCrypto } = window.PrismWeb;

    const session = createVaultSession({ api: createVaultApi(), keys: openVaultKeys() });
    let current = { state: 'unavailable', reason: 'unchecked' };

    const MESSAGES = {
        format: `A recovery key has ${VaultCrypto.RECOVERY_CHARS} letters and numbers. Check that none are missing or extra.`,
        'wrong-key': 'That is not the recovery key for these plans. Check it against the one you saved.',
        offline: 'Aventurine cannot be reached right now. Check your connection and try again.',
        server: 'Something went wrong on our side. Try again in a moment.',
        conflict: 'Your recovery key was just changed on another device. Close this and try again.',
    };

    function messageFor(e) {
        if (e && MESSAGES[e.code]) return MESSAGES[e.code];
        console.error('[vault]', e);
        return MESSAGES.server;
    }

    function setBusy(button, busy) {
        button.disabled = busy;
        button.classList.toggle('is-busy', busy);
    }

    function showError(el, message) {
        el.textContent = message;
        el.hidden = !message;
    }

    // ── The key and the ways to keep it ────────────────────────────────────

    function keyFile(recoveryKey) {
        const made = new Date().toLocaleDateString(undefined, { dateStyle: 'long' });
        return [
            'Aventurine Planner recovery key',
            '',
            recoveryKey,
            '',
            `Made on ${made}.`,
            '',
            'You need this key to open your plans on a new device or browser.',
            'Keep it somewhere safe, like a password manager. Aventurine never',
            'sees it and cannot reset it: if it is lost, the plans saved to your',
            'account cannot be opened.',
            '',
        ].join('\n');
    }

    /** The key, Copy and Download, and the "I have saved it" box. `onSaved(checked)` follows the box. */
    function keyPanel(recoveryKey, onSaved) {
        const groups = recoveryKey.split('-');
        const half = groups.length / 2;
        const el = document.createElement('div');
        el.className = 'vault-body';
        el.innerHTML = `
            <p class="recovery-key"><span></span><span></span></p>
            <div class="vault-key-actions">
                <button class="button-secondary" type="button" data-copy>${iconSvg('copy')}<span>Copy</span></button>
                <button class="button-secondary" type="button" data-download>${iconSvg('download-simple')}<span>Download</span></button>
            </div>
            <label class="vault-check">
                <input type="checkbox" data-saved>
                <span>I have saved my recovery key somewhere safe, like a password manager.</span>
            </label>`;
        const [first, second] = el.querySelectorAll('.recovery-key span');
        first.textContent = groups.slice(0, half).join('-');
        second.textContent = groups.slice(half).join('-');

        el.querySelector('[data-copy]').addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(recoveryKey);
                UI.toast('Recovery key copied.', { type: 'success' });
            } catch {
                getSelection().selectAllChildren(el.querySelector('.recovery-key'));
                UI.toast('Copying was blocked. The key is selected: copy it with your keyboard.', { type: 'warning' });
            }
        });
        el.querySelector('[data-download]').addEventListener('click', () => {
            fileDialogs.save({
                name: 'aventurine-planner-recovery-key.txt', text: keyFile(recoveryKey), kind: 'text',
            }).catch((e) => {
                console.error('[vault] the recovery key file could not be saved:', e);
                UI.toast('The file could not be saved. Copy the key instead.', { type: 'error' });
            });
        });
        el.querySelector('[data-saved]').addEventListener('change', (e) => onSaved(e.target.checked));
        return el;
    }

    // ── Screens ────────────────────────────────────────────────────────────

    function screen({ icon, title, note }) {
        root.innerHTML = `
            <section class="lock-card vault-card" role="dialog" aria-modal="true" aria-labelledby="vault-title" aria-describedby="vault-note">
                <span class="role-tile role-tile--lg role-tile--accent">${iconSvg(icon)}</span>
                <h1 class="lock-title" id="vault-title"></h1>
                <p class="lock-note" id="vault-note"></p>
            </section>`;
        root.querySelector('#vault-title').textContent = title;
        root.querySelector('#vault-note').textContent = note;
        root.hidden = false;
        return root.querySelector('.vault-card');
    }

    /** Resolves with the state after setup: 'ready', or 'locked' if another device set up first. */
    async function showSetup() {
        const pending = await session.prepareSetup();
        return new Promise((resolve) => {
            const card = screen({
                icon: 'shield-check',
                title: 'Save your recovery key',
                note: 'Your plans are encrypted on this device before they are saved to your account, so they can follow you to any device. '
                    + 'To open them somewhere new, you will need this key. We never see it, and we cannot reset it.',
            });
            const submit = document.createElement('button');
            submit.className = 'button-primary vault-submit';
            submit.type = 'button';
            submit.textContent = 'Continue';
            submit.disabled = true;
            const error = document.createElement('p');
            error.className = 'vault-error';
            error.setAttribute('role', 'alert');
            error.hidden = true;
            card.append(keyPanel(pending.recoveryKey, (saved) => { submit.disabled = !saved; }), error, submit);

            submit.addEventListener('click', async () => {
                setBusy(submit, true);
                showError(error, '');
                try {
                    resolve(await pending.commit());
                } catch (e) {
                    showError(error, messageFor(e));
                    setBusy(submit, false);
                }
            });
            card.querySelector('[data-copy]').focus();
        });
    }

    /** Resolves with the state after unlocking ('ready'), or after starting over ('setup'). */
    function showUnlock(vault) {
        return new Promise((resolve) => {
            const card = screen({
                icon: 'lock-key',
                title: 'Enter your recovery key',
                note: 'Your plans are encrypted. To open them on this device, enter the recovery key you saved when you set up sync.',
            });
            card.insertAdjacentHTML('beforeend', `
                <form class="vault-body" novalidate>
                    <label class="vault-label" for="vault-key">Recovery key</label>
                    <input class="field-input recovery-key-input" id="vault-key" type="text" autocomplete="off"
                           autocapitalize="characters" spellcheck="false" maxlength="64"
                           placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" aria-describedby="vault-error">
                    <p class="vault-error" id="vault-error" role="alert" hidden></p>
                    <button class="button-primary vault-submit" type="submit">Unlock</button>
                </form>
                <button class="button-link" type="button" data-lost>Lost your recovery key?</button>`);
            const form = card.querySelector('form');
            const input = form.querySelector('input');
            const error = form.querySelector('.vault-error');
            const submit = form.querySelector('[type="submit"]');
            const lost = card.querySelector('[data-lost]');

            function fail(e) {
                showError(error, messageFor(e));
                input.setAttribute('aria-invalid', 'true');
                if (e && (e.code === 'format' || e.code === 'wrong-key')) input.select();
            }

            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                setBusy(submit, true);
                showError(error, '');
                input.removeAttribute('aria-invalid');
                try {
                    resolve(await session.unlock(input.value));
                } catch (err) {
                    fail(err);
                } finally {
                    setBusy(submit, false);
                }
            });

            lost.addEventListener('click', async () => {
                const erase = await UI.confirm({
                    title: 'Erase your synced plans?',
                    message: 'Without the recovery key, nobody can open the plans saved to your account, not even us. '
                        + 'Starting over erases them for good and sets up sync with a new key. Plans already in this '
                        + 'browser are kept, and your other devices will need the new key.',
                    confirmLabel: 'Erase and Start Over',
                });
                if (!erase) return;
                setBusy(lost, true);
                try {
                    resolve(await session.startOver(vault));
                } catch (err) {
                    fail(err);
                } finally {
                    setBusy(lost, false);
                }
            });
            input.focus();
        });
    }

    async function ensure() {
        try {
            let state = navigator.onLine === false ? { state: 'unavailable', reason: 'unreachable' } : await session.check();
            while (state.state === 'setup' || state.state === 'locked') {
                state = state.state === 'setup' ? await showSetup() : await showUnlock(state.vault);
            }
            current = state;
        } catch (e) {
            // Sync could not start (say, storage blocked). The plans in this
            // browser are still the person's own, so the app opens without it.
            console.error('[vault] sync could not start:', e);
            current = { state: 'unavailable', reason: 'error' };
        }
        root.hidden = true;
        root.innerHTML = '';
        return current;
    }

    // ── Replacing the recovery key (Preferences → Account) ─────────────────

    async function newRecoveryKey() {
        if (current.state !== 'ready') return false;
        const pending = await session.prepareNewKey(current);
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `
            <div class="modal vault-dialog" role="dialog" aria-modal="true" aria-labelledby="vault-dialog-title">
                <div class="modal-header">
                    <h2 class="modal-title" id="vault-dialog-title">New recovery key</h2>
                    <button class="modal-close" type="button" data-close aria-label="Close">×</button>
                </div>
                <div class="modal-body">
                    <p class="vault-dialog-note">Save this key, then confirm. Your old recovery key will stop working. Devices that are already set up keep working without it.</p>
                    <p class="vault-error" role="alert" hidden></p>
                </div>
                <div class="modal-footer">
                    <button class="button-secondary" type="button" data-close>Cancel</button>
                    <button class="button-primary" type="button" data-confirm disabled>Use New Key</button>
                </div>
            </div>`;
        const confirmBtn = overlay.querySelector('[data-confirm]');
        const error = overlay.querySelector('.vault-error');
        error.before(keyPanel(pending.recoveryKey, (saved) => { confirmBtn.disabled = !saved; }));
        document.body.append(overlay);

        return new Promise((resolve) => {
            let replaced = false;
            confirmBtn.addEventListener('click', async () => {
                setBusy(confirmBtn, true);
                showError(error, '');
                try {
                    current = await pending.commit();
                    replaced = true;
                    UI.closeModal(overlay);
                    UI.toast('New recovery key saved. The old one no longer works.', { type: 'success' });
                } catch (e) {
                    showError(error, messageFor(e));
                    setBusy(confirmBtn, false);
                }
            });
            UI.openModal(overlay, {
                initialFocus: overlay.querySelector('[data-copy]'),
                onClose() {
                    overlay.remove();
                    resolve(replaced);
                },
            });
        });
    }

    window.VaultGate = { ensure, current: () => current, newRecoveryKey };
}());
