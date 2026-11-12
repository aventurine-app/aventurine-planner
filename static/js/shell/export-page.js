'use strict';

// ─── export-page.js ─────────────────────────────────────────────────────────
// The export page (/export). Someone whose subscription has ended can still
// sign in while their encrypted plans are kept (60 days, worker/src/vault.js),
// and here they open them and take them away: every plan as a zip, a PDF
// report, or one plan as a CSV, a PDF or a plan file.
//
//   1. Ask the server for the vault. Signed out: to the sign-in page.
//   2. Open it: with this browser's own copy of the data key if it has one
//      (it ran the app before), otherwise with the recovery key typed here.
//      A typed key is used for this visit only; nothing is saved.
//   3. Read every plan (readVault, web/sync.js) and offer the downloads.
//
// The server lets this page read the vault but never change it, and reading
// it does not restart the 60 days.

(function () {
    const { createVaultApi, openVaultKeys, VaultCrypto, readVault, Exports, PlanFiles, fileDialogs, AccountApi } = window.PrismWeb;

    const note = document.getElementById('export-note');
    const unlockForm = document.getElementById('export-unlock');
    const keyInput = document.getElementById('export-key');
    const unlockError = document.getElementById('export-error');
    const unlockBtn = unlockForm.querySelector('[type="submit"]');
    const ready = document.getElementById('export-ready');
    const list = document.getElementById('export-list');
    const failed = document.getElementById('export-failed');
    const allBtn = document.getElementById('export-all');
    const reportBtn = document.getElementById('export-report');
    const foot = document.getElementById('export-foot');
    const signout = document.getElementById('export-signout');

    const api = createVaultApi();
    const date = (ms) => new Date(ms).toLocaleDateString(undefined, { dateStyle: 'long' });

    const MESSAGES = {
        format: `A recovery key has ${VaultCrypto.RECOVERY_CHARS} letters and numbers. Check that none are missing or extra.`,
        'wrong-key': 'That is not the recovery key for these plans. Check it against the one you saved.',
        offline: 'Aventurine cannot be reached right now. Check your connection and try again.',
        server: 'Something went wrong on our side. Try again in a moment.',
    };

    function messageFor(e) {
        if (e && MESSAGES[e.code]) return MESSAGES[e.code];
        console.error('[export]', e);
        return MESSAGES.server;
    }

    function showError(el, message) {
        el.textContent = message;
        el.hidden = !message;
    }

    function setBusy(button, busy) {
        button.disabled = busy;
        button.classList.toggle('is-busy', busy);
    }

    // ── Opening the vault ──────────────────────────────────────────────────

    let vault = null;
    let keptUntil = null;
    let contents = null;   // { plans, goals, unreadable }

    const keptText = () => (keptUntil ? `Your plans are kept until ${date(keptUntil)}, then deleted for good.` : '');

    async function start() {
        const r = await api.getVault();
        if (r.status === 401) {
            location.replace('/auth/login');
            return;
        }
        if (r.status !== 200) {
            note.textContent = r.status === 0 ? MESSAGES.offline : MESSAGES.server;
            return;
        }
        vault = r.body.vault;
        keptUntil = r.body.keptUntil;
        foot.hidden = r.body.access;
        if (!vault) {
            note.textContent = 'There are no plans saved to this account.';
            return;
        }
        const saved = await savedKey(vault.id);
        if (saved) {
            await open(saved);
            return;
        }
        note.textContent = `${keptText()} Enter the recovery key you saved when you set up sync to open them here. Nothing is saved in this browser.`.trim();
        unlockForm.hidden = false;
        keyInput.focus();
    }

    /** This browser's copy of the data key, if it ran the app with this vault. */
    async function savedKey(vaultId) {
        try {
            const saved = await (await openVaultKeys()).get(vaultId);
            return saved ? saved.dataKey : null;
        } catch (e) {
            console.warn('[export] this browser\'s keys could not be read:', e);
            return null;
        }
    }

    unlockForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        setBusy(unlockBtn, true);
        showError(unlockError, '');
        try {
            const bytes = VaultCrypto.parseRecoveryKey(keyInput.value);
            const dataKey = await VaultCrypto.unwrapDataKey(vault.wrappedKey, bytes);
            await open(dataKey);
        } catch (err) {
            showError(unlockError, messageFor(err));
            keyInput.setAttribute('aria-invalid', 'true');
            keyInput.select();
        } finally {
            setBusy(unlockBtn, false);
        }
    });

    async function open(dataKey) {
        contents = await readVault({ api, vault, dataKey });
        unlockForm.hidden = true;
        const count = contents.plans.length;
        const unread = contents.unreadable ? ` ${contents.unreadable} saved ${contents.unreadable === 1 ? 'item' : 'items'} could not be read.` : '';
        const kept = keptUntil ? ` ${count === 1 ? 'It is' : 'They are'} kept in your account until ${date(keptUntil)}, then deleted for good.` : '';
        note.textContent = count
            ? `${count === 1 ? 'Your plan is' : `Your ${count} plans are`} open in this tab only.${kept}${unread}`
            : `There are no plans saved to this account.${unread}`;
        renderList();
        ready.hidden = !count;
    }

    // ── Downloads ──────────────────────────────────────────────────────────

    function run(plan) {
        try {
            return window.CitrineEngine.simulate(plan);
        } catch (e) {
            console.error('[export] simulation failed', plan.id, e);
            return null;
        }
    }

    function renderList() {
        list.innerHTML = contents.plans.map((plan, i) => `
            <li class="export-item">
                <span class="export-item-name">${escapeHtml(plan.name)}</span>
                <span class="export-item-actions">
                    <button class="button-secondary" type="button" data-i="${i}" data-format="pdf" aria-label="${escapeHtml(plan.name)}: PDF report">${iconSvg('file-pdf')}PDF</button>
                    <button class="button-secondary" type="button" data-i="${i}" data-format="csv" aria-label="${escapeHtml(plan.name)}: spreadsheet">${iconSvg('file-csv')}CSV</button>
                    <button class="button-secondary" type="button" data-i="${i}" data-format="json" aria-label="${escapeHtml(plan.name)}: plan file">${iconSvg('file-code')}JSON</button>
                </span>
            </li>`).join('');
    }

    function printReport(plans, title) {
        window.Report.print({ entries: plans.map((plan) => ({ plan, results: run(plan) })), goals: contents.goals, title });
    }

    /** Make and save a file; nothing may be awaited before the save dialog, which needs the click. */
    async function save(file) {
        showError(failed, '');
        try {
            await fileDialogs.save(file);
        } catch (e) {
            console.error('[export] the file could not be saved:', e);
            showError(failed, 'The file could not be saved. Try again.');
        }
    }

    list.addEventListener('click', (e) => {
        const b = e.target.closest('[data-format]');
        if (!b) return;
        const plan = contents.plans[Number(b.dataset.i)];
        if (b.dataset.format === 'pdf') printReport([plan], `${plan.name} - Aventurine Planner report`);
        else if (b.dataset.format === 'csv') save({ name: PlanFiles.fileName(plan.name, 'csv'), text: Exports.planCsv(plan), kind: 'csv' });
        else save({ name: PlanFiles.fileName(plan.name), text: PlanFiles.serialize(plan), kind: 'plan' });
    });

    allBtn.addEventListener('click', () => save({
        name: Exports.archiveName(), data: Exports.archive({ plans: contents.plans, goals: contents.goals }), kind: 'zip',
    }));
    reportBtn.addEventListener('click', () => printReport(contents.plans, 'Aventurine Planner report'));

    signout.addEventListener('click', async () => {
        await AccountApi.logout();
        location.replace('/auth/login');
    });

    start().catch((e) => {
        note.textContent = messageFor(e);
    });
}());
