'use strict';

// ─── account.js ─────────────────────────────────────────────────────────────
// Preferences → Account: who is signed in, what their subscription is, and the
// two things they can do about it (open billing, sign out). Below that,
// Encrypted Sync: whether it is on for this device, and a new recovery key
// (the dialog and every vault request are shell/vault-gate.js's). Signing out
// with sync on sends what is unsent, then clears the plans from this browser.
//
// Every call to the server goes through web/account-api.js. Where there is
// no server (the local dev server), it does not answer and the tab says so
// instead of failing.

(function () {
    const panel = document.querySelector('[data-panel="account"]');
    if (!panel) return;
    const { AccountApi } = window.PrismWeb;
    const emailEl = panel.querySelector('[data-account-email]');
    const statusEl = panel.querySelector('[data-account-status]');
    const billingBtn = panel.querySelector('[data-account-billing]');
    const signoutRow = panel.querySelector('[data-account-signout-row]');
    const signoutBtn = panel.querySelector('[data-account-signout]');
    const errorEl = panel.querySelector('[data-account-error]');
    const syncSection = panel.querySelector('[data-sync-section]');
    const syncStatus = panel.querySelector('[data-sync-status]');
    const syncKeyRow = panel.querySelector('[data-sync-key-row]');
    const syncKeyBtn = panel.querySelector('[data-sync-new-key]');

    const date = (ms) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });

    // What sync is doing now (Store.state.sync, from web/sync.js). New Recovery
    // Key needs the vault opened this session, so only after the gate's 'ready'.
    const SYNC_TEXT = {
        synced: 'On. Your plans are encrypted on this device before they are saved to your account, and only your recovery key can open them.',
        offline: 'Offline. Your changes are saved in this browser and sync when you are back online.',
        error: 'Paused. Your changes are saved in this browser, and sync will try again.',
        off: 'Not connected. Your plans are saved in this browser only.',
    };

    function refreshSync() {
        syncSection.hidden = !window.VaultGate || !window.Store;
        if (syncSection.hidden) return;
        syncStatus.textContent = SYNC_TEXT[Store.state.sync] || SYNC_TEXT.off;
        syncKeyRow.hidden = VaultGate.current().state !== 'ready';
    }

    syncKeyBtn.addEventListener('click', async () => {
        syncKeyBtn.disabled = true;
        try {
            await VaultGate.newRecoveryKey();
        } catch (e) {
            console.error('[account] a new recovery key could not be made:', e);
            UI.toast('A new recovery key could not be made. Try again in a moment.', { type: 'error' });
        } finally {
            syncKeyBtn.disabled = false;
            refreshSync();
        }
    });

    /** One plain sentence for a subscription. */
    function describe(me) {
        if (me.complimentary) return 'Complimentary access.';
        const sub = me.subscription;
        if (!sub) return 'No subscription.';
        const until = sub.cancelsAt ? date(sub.cancelsAt) : null;
        switch (sub.status) {
            case 'active':
                if (until) return `Active until ${until}. It will not renew.`;
                return sub.renewsAt ? `Active. Renews ${date(sub.renewsAt)}.` : 'Active.';
            case 'trialing': return 'Free trial.';
            case 'past_due': return 'The last payment failed. Update your payment method to keep access.';
            case 'paused': return 'Paused.';
            case 'canceled': return 'Canceled.';
            default: return 'Not active.';
        }
    }

    function showError(message) {
        errorEl.textContent = message;
        errorEl.hidden = !message;
    }

    async function refresh() {
        refreshSync();
        showError('');
        billingBtn.hidden = true;
        signoutRow.hidden = true;
        // Asked afresh: the subscription may have changed in billing meanwhile.
        const r = await AccountApi.me({ fresh: true });
        if (r.status !== 200) {
            emailEl.textContent = '—';
            statusEl.textContent = r.status === 401
                ? 'You are signed out. Reload the page to sign in.'
                : 'Not signed in. Accounts are not available in local development.';
            return;
        }
        const me = r.body;
        emailEl.textContent = me.email;
        statusEl.textContent = describe(me);
        billingBtn.hidden = !me.subscription;
        signoutRow.hidden = false;
    }

    billingBtn.addEventListener('click', async () => {
        billingBtn.disabled = true;
        billingBtn.classList.add('is-busy');
        showError('');
        const r = await AccountApi.billingPortal();
        billingBtn.disabled = false;
        billingBtn.classList.remove('is-busy');
        if (r.status === 200 && r.body.url) {
            window.open(r.body.url, '_blank', 'noopener');
            return;
        }
        showError('Billing could not be opened right now. Try again in a moment.');
    });

    /**
     * With sync on, signing out sends what is unsent and then clears this
     * browser's plans and key (they are in the account); if something could
     * not be sent, it asks first. Resolves false if the person stays.
     */
    async function leaveDevice() {
        const result = await PrismWeb.signOutSync();
        if (!result.unsent) return true;
        const leave = await UI.confirm({
            title: 'Sign out without syncing?',
            message: 'Some changes on this device have not reached your account yet, perhaps because you are offline. '
                + 'Signing out now removes them from this browser for good.',
            confirmLabel: 'Sign Out Anyway',
        });
        if (!leave) return false;
        await PrismWeb.signOutSync({ force: true });
        return true;
    }

    signoutBtn.addEventListener('click', async () => {
        // Saves are debounced, so make sure the last edit is stored before leaving.
        if (window.Store && !(await Store.flush())) return;
        signoutBtn.disabled = true;
        signoutBtn.classList.add('is-busy');
        try {
            if (!(await leaveDevice())) return;
            await AccountApi.logout();
            location.assign('/auth/login');
        } catch (e) {
            console.error('[account] sign out failed:', e);
            showError('Signing out did not finish. Try again in a moment.');
        } finally {
            signoutBtn.disabled = false;
            signoutBtn.classList.remove('is-busy');
        }
    });

    window.Account = { refresh };
}());
