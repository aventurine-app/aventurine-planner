'use strict';

// ─── auth/privacy.js ────────────────────────────────────────────────────────
// The page behind "Delete Me" on the website: see what we hold for an email
// address, download it, or delete it (worker/src/privacy.js). Without a link it
// asks for one. With one, it reads the token after the #, removes it from the
// address bar, and uses it only when the person presses a button.

(function () {
    const steps = [...document.querySelectorAll('.auth-step')];
    const title = document.getElementById('auth-title');

    const match = /^#t=([A-Za-z0-9_-]{43})$/.exec(location.hash);
    const token = match ? match[1] : null;
    history.replaceState(null, '', location.pathname);

    const GENERIC_ERROR = 'Something went wrong. Try again in a moment.';
    const OFFLINE_ERROR = 'Could not reach the server. Check your connection and try again.';
    const EXPIRED_ERROR = 'This link has expired or was already used. Ask for a new one.';

    /** Show one step, retitle the card, and move focus so a screen reader follows. */
    function show(id, heading) {
        for (const step of steps) step.hidden = step.id !== id;
        if (heading) title.textContent = heading;
        title.focus();
    }

    /** Run `action` with `button` disabled and spinning, so it cannot be pressed twice. */
    async function busy(button, action) {
        button.disabled = true;
        button.classList.add('is-busy');
        try {
            return await action();
        } finally {
            button.disabled = false;
            button.classList.remove('is-busy');
        }
    }

    function showError(element, message) {
        element.textContent = message;
        element.hidden = !message;
    }

    // ── Asking for a link ───────────────────────────────────────────────────

    const requestForm = document.getElementById('request-form');
    const emailInput = document.getElementById('email');
    const requestError = document.getElementById('request-error');

    requestForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        showError(requestError, '');
        emailInput.removeAttribute('aria-invalid');
        const email = emailInput.value.trim();
        const messages = {
            400: 'Enter a valid email address.',
            429: 'Too many attempts. Wait a minute and try again.',
            0: OFFLINE_ERROR,
        };
        const r = email
            ? await busy(requestForm.querySelector('button'), () => authPost('/api/privacy/request', { email }))
            : { status: 400 };
        if (r.status === 202) {
            show('step-sent');
            return;
        }
        showError(requestError, messages[r.status] || GENERIC_ERROR);
        emailInput.setAttribute('aria-invalid', 'true');
    });

    // ── The report ──────────────────────────────────────────────────────────

    const longDate = (iso) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'long' });
    const kilobytes = (bytes) => `${Math.max(1, Math.round(bytes / 1024))} KB`;
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

    /** What the report says, as [label, value] rows. */
    function reportRows(report) {
        const rows = [['Email', report.email]];
        for (const s of report.subscriptions) {
            rows.push(['Subscription', s.status + (s.cancelsAt ? `, ends ${longDate(s.cancelsAt)}` : '')]);
        }
        if (report.complimentary) rows.push(['Access', 'Complimentary']);
        if (report.vault) {
            rows.push(['Encrypted plans', `${plural(report.vault.items, 'item')}, ${kilobytes(report.vault.bytes)}. We cannot read these.`]);
            rows.push(['Last synced', longDate(report.vault.lastUsedAt)]);
        }
        if (report.sessions.length) rows.push(['Signed in on', plural(report.sessions.length, 'browser')]);
        return rows;
    }

    /** What pressing delete will do for this person, in the order it matters to them. */
    function effects(report) {
        const list = [];
        const live = report.subscriptions.filter((s) => s.status !== 'canceled');
        if (live.length) {
            list.push('Your subscription is cancelled now, and you lose access straight away. If a refund is due, ask for it before you delete.');
        }
        if (report.vault) list.push('Your encrypted plans are deleted for good. Nobody can get them back, including us.');
        if (report.holdsData) list.push('Your email address, subscription record and sign-in records are deleted, and you are signed out everywhere.');
        list.push('We remove your emails to support within 30 days.');
        return list;
    }

    function renderReport(report) {
        document.getElementById('report-lead').textContent = report.holdsData
            ? 'This is what Aventurine Planner holds for your email address.'
            : 'Aventurine Planner holds nothing for this email address. You can still ask us to remove any emails to support.';

        const list = document.getElementById('report-list');
        list.replaceChildren(...reportRows(report).flatMap(([label, value]) => {
            const term = document.createElement('dt');
            const detail = document.createElement('dd');
            term.textContent = label;
            detail.textContent = value;
            return [term, detail];
        }));

        document.getElementById('report-plans').hidden = !report.vault;
        document.getElementById('report-effects').replaceChildren(...effects(report).map((text) => {
            const item = document.createElement('li');
            item.textContent = text;
            return item;
        }));

        document.getElementById('report-download').addEventListener('click', () => {
            const { ok: _ok, ...copy } = report;
            const url = URL.createObjectURL(new Blob([JSON.stringify(copy, null, 2)], { type: 'application/json' }));
            const link = document.createElement('a');
            link.href = url;
            link.download = 'aventurine-my-data.json';
            link.click();
            URL.revokeObjectURL(url);
        });
        show('step-report', 'Your data');
    }

    // ── Opening a link ──────────────────────────────────────────────────────

    const openButton = document.getElementById('open-button');
    const openError = document.getElementById('open-error');

    function openLink() {
        show('step-open', 'Your data');
        openButton.addEventListener('click', async () => {
            showError(openError, '');
            const r = await busy(openButton, () => authPost('/api/privacy/report', { token }));
            if (r.status === 200) {
                if (r.body.erasurePending) show('step-pending', 'Deletion in progress');
                else renderReport(r.body);
                return;
            }
            showError(openError, r.status === 0 ? OFFLINE_ERROR : r.status === 400 ? EXPIRED_ERROR : GENERIC_ERROR);
            if (r.status === 400) {
                openButton.hidden = true;
                document.getElementById('open-retry').hidden = false;
            }
        });
        openButton.focus();
    }

    // ── Deleting ────────────────────────────────────────────────────────────

    const eraseForm = document.getElementById('erase-form');
    const confirmInput = document.getElementById('confirm');
    const eraseError = document.getElementById('erase-error');

    eraseForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        showError(eraseError, '');
        confirmInput.removeAttribute('aria-invalid');
        const confirm = confirmInput.value.trim();
        if (confirm !== 'DELETE') {
            showError(eraseError, 'Type DELETE in capital letters to confirm.');
            confirmInput.setAttribute('aria-invalid', 'true');
            return;
        }
        const r = await busy(eraseForm.querySelector('button'), () => authPost('/api/privacy/erase', { token, confirm }));
        if (r.status === 200) show('step-done', 'Deleted');
        else if (r.status === 202) show('step-pending', 'Deletion in progress');
        else showError(eraseError, r.status === 0 ? OFFLINE_ERROR : r.status === 400 ? EXPIRED_ERROR : GENERIC_ERROR);
    });

    if (token) {
        openLink();
    } else {
        show('step-request');
        emailInput.focus();
    }
}());
