'use strict';

// ─── auth/inactive.js ───────────────────────────────────────────────────────
// Where a signed-in person without an active subscription lands. Says why, and
// offers the ways forward: subscribe again, fix billing, or sign out. While
// their encrypted plans are kept (60 days), it says until when and links to
// the export page, where they can take them away.

(function () {
    const title = document.getElementById('auth-title');
    const note = document.getElementById('inactive-note');
    const error = document.getElementById('inactive-error');
    const pricing = document.getElementById('inactive-pricing');
    const billing = document.getElementById('inactive-billing');
    const signout = document.getElementById('inactive-signout');
    const exportLink = document.getElementById('inactive-export');

    const date = (ms) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });

    function explain(me) {
        const sub = me.subscription;
        if (!sub) return ['No active subscription', `There is no Aventurine Planner subscription for ${me.email}.`];
        if (sub.status === 'paused') return ['Subscription paused', 'Your subscription is paused. Resume it from billing to keep using Aventurine Planner.'];
        if (sub.status === 'canceled') {
            return ['Subscription ended', 'Your subscription has ended. Subscribe again to open your plans.'];
        }
        return ['Subscription not active', 'Your subscription is not active. Check it in billing.'];
    }

    function showError(message) {
        error.textContent = message;
        error.hidden = false;
    }

    async function load() {
        let me;
        try {
            const response = await fetch('/api/me', { credentials: 'same-origin' });
            if (response.status === 401) {
                location.replace('/auth/login');
                return;
            }
            me = await response.json();
        } catch {
            title.textContent = 'Could not check your subscription';
            note.textContent = 'Reload the page to try again.';
            return;
        }
        if (me.access) {
            try { sessionStorage.setItem('signed-in', '1'); } catch { /* the app then opens where it was left */ }
            location.replace('/');
            return;
        }
        const [heading, text] = explain(me);
        title.textContent = heading;
        note.textContent = me.subscription && me.subscription.renewsAt ? `${text} (Last paid period ended ${date(me.subscription.renewsAt)}.)` : text;
        pricing.hidden = false;
        billing.hidden = !me.subscription;
        signout.hidden = false;
        await offerExport();
    }

    /** If the account still has saved plans, say until when, and offer to export them. */
    async function offerExport() {
        let body;
        try {
            const response = await fetch('/api/vault', { credentials: 'same-origin' });
            if (!response.ok) return;
            body = await response.json();
        } catch {
            return; // the page still offers the rest
        }
        if (!body.vault) return;
        const kept = body.keptUntil ? ` until ${date(body.keptUntil)}, then deleted for good` : '';
        note.textContent += ` They are kept in your account${kept}. Export them to keep a copy.`;
        exportLink.hidden = false;
    }

    billing.addEventListener('click', async () => {
        billing.disabled = true;
        error.hidden = true;
        const r = await authPost('/api/billing/portal');
        if (r.status === 200 && r.body.url) {
            location.assign(r.body.url);
            return;
        }
        billing.disabled = false;
        showError('Billing could not be opened right now. Try again in a moment.');
    });

    signout.addEventListener('click', async () => {
        await authPost('/api/auth/logout');
        location.replace('/auth/login');
    });

    load();
}());
