'use strict';

// ─── titlebar.js ────────────────────────────────────────────────────────────
// The top bar: whether the plans are saved and the signed-in user at its
// right edge. It also keeps the window title naming the workspace and the plan
// open in it. Plans are listed, opened and managed (exported included) in the
// navigation (nav.js).

(function () {
    const userEl = document.getElementById('titlebar-user');
    const saveEl = document.getElementById('titlebar-save');

    // What each workspace is called here; Plans and Analyze also name the plan.
    const WORKSPACE_NAME = { plans: 'Plans', goals: 'Goals', analyze: 'Analyze', compare: 'Compare' };
    const NAMES_PLAN = new Set(['plans', 'analyze']);

    let drawn = null;

    // Runs on every plan edit (drags included), so it writes only on a change.
    function renderTitle() {
        const { plan, workspace } = Store.state;
        const name = WORKSPACE_NAME[workspace] || 'Plans';
        const planName = plan && NAMES_PLAN.has(workspace) ? plan.name : '';
        const sig = `${name}|${planName}`;
        if (sig === drawn) return;
        drawn = sig;
        document.title = `Aventurine - ${planName || name}`;
    }

    // ── Signed-in user ─────────────────────────────────────────────────────
    // The email comes from /api/me. Where there is no server (local dev) or the
    // session is gone, the spot says so. Clicking opens Preferences → Account.
    // (In the free sandbox it reads "Free demo" and opens its explainer.)
    if (userEl) {
        userEl.innerHTML = `${iconSvg('user-circle')}<span class="titlebar-user-name"></span>`;
        const nameEl = userEl.querySelector('.titlebar-user-name');
        userEl.addEventListener('click', () => Settings.open('account'));
        const show = (email) => {
            nameEl.textContent = email || 'Not signed in';
            userEl.title = email ? `Signed in as ${email}` : 'Account';
            userEl.setAttribute('aria-label', email ? `Account: ${email}` : 'Account');
        };
        if (window.PrismDemo) {
            // The free sandbox has no sign-in: the spot names it instead.
            nameEl.textContent = 'Free demo';
            userEl.title = 'About the free demo';
            userEl.setAttribute('aria-label', 'About the free demo');
        } else {
            show('');
            fetch('/api/me', { credentials: 'same-origin' })
                .then((r) => (r.ok ? r.json() : null))
                .then((me) => show(me && me.email))
                .catch(() => {});
        }
    }

    // ── Saved ──────────────────────────────────────────────────────────────
    // A status dot and a word, as Ant's Badge: green once every change is in
    // this browser's storage, blue while one is on its way, red if one failed.
    // With encrypted sync on, a saved change also says whether it reached the
    // account (amber offline, red if sync stopped). The words stay short, so
    // the bar does not shift as each edit saves.
    const SAVE = {
        saved: ['success', 'Saved', 'Every change is saved in this browser'],
        saving: ['processing', 'Saving…', 'Saving your changes in this browser'],
        error: ['error', 'Not saved', 'Your latest changes could not be saved'],
    };
    const SYNC = {
        synced: ['success', 'Synced', 'Every change is saved, encrypted, to your account'],
        offline: ['warning', 'Offline', 'Saved in this browser. Your changes sync when you are back online'],
        error: ['error', 'Not synced', 'Saved in this browser, but not synced to your account'],
    };
    const SYNC_PROBLEM = {
        vault_full: 'Saved in this browser, but your account is full. Delete a plan to sync again',
        vault_changed: 'Saved in this browser. Sync stopped: reload to enter your recovery key',
        signed_out: 'Saved in this browser. Sync stopped: reload to sign in',
        server: 'Saved in this browser. Sync will try again shortly',
    };
    // With sync on, the status is an Ant Design cloud instead: CloudSync green
    // once synced and orange when a change is not synced (or not saved at all),
    // CloudUpload grey while a change is on its way, and Cloud grey with a slash
    // offline (Ant has no crossed-out cloud: the slash is Disconnect's, cut
    // into the cloud). The word stays for screen readers and in the tooltip.
    // Paths from @ant-design/icons-svg 4.4.2 (outlined), MIT licensed.
    const ANT_CLOUD_SYNC = '<path d="M811.4 368.9C765.6 248 648.9 162 512.2 162S258.8 247.9 213 368.8C126.9 391.5 63.5 470.2 64 563.6 64.6 668 145.6 752.9 247.6 762c4.7.4 8.7-3.3 8.7-8v-60.4c0-4-3-7.4-7-7.9-27-3.4-52.5-15.2-72.1-34.5-24-23.5-37.2-55.1-37.2-88.6 0-28 9.1-54.4 26.2-76.4 16.7-21.4 40.2-36.9 66.1-43.7l37.9-10 13.9-36.7c8.6-22.8 20.6-44.2 35.7-63.5 14.9-19.2 32.6-36 52.4-50 41.1-28.9 89.5-44.2 140-44.2s98.9 15.3 140 44.3c19.9 14 37.5 30.8 52.4 50 15.1 19.3 27.1 40.7 35.7 63.5l13.8 36.6 37.8 10c54.2 14.4 92.1 63.7 92.1 120 0 33.6-13.2 65.1-37.2 88.6-19.5 19.2-44.9 31.1-71.9 34.5-4 .5-6.9 3.9-6.9 7.9V754c0 4.7 4.1 8.4 8.8 8 101.7-9.2 182.5-94 183.2-198.2.6-93.4-62.7-172.1-148.6-194.9z"/><path d="M376.9 656.4c1.8-33.5 15.7-64.7 39.5-88.6 25.4-25.5 60-39.8 96-39.8 36.2 0 70.3 14.1 96 39.8 1.4 1.4 2.7 2.8 4.1 4.3l-25 19.6a8 8 0 003 14.1l98.2 24c5 1.2 9.9-2.6 9.9-7.7l.5-101.3c0-6.7-7.6-10.5-12.9-6.3L663 532.7c-36.6-42-90.4-68.6-150.5-68.6-107.4 0-195 85.1-199.4 191.7-.2 4.5 3.4 8.3 8 8.3H369c4.2-.1 7.7-3.4 7.9-7.7zM703 664h-47.9c-4.2 0-7.7 3.3-8 7.6-1.8 33.5-15.7 64.7-39.5 88.6-25.4 25.5-60 39.8-96 39.8-36.2 0-70.3-14.1-96-39.8-1.4-1.4-2.7-2.8-4.1-4.3l25-19.6a8 8 0 00-3-14.1l-98.2-24c-5-1.2-9.9 2.6-9.9 7.7l-.4 101.4c0 6.7 7.6 10.5 12.9 6.3l23.2-18.2c36.6 42 90.4 68.6 150.5 68.6 107.4 0 195-85.1 199.4-191.7.2-4.5-3.4-8.3-8-8.3z"/>';
    const ANT_CLOUD_UPLOAD = '<path d="M518.3 459a8 8 0 00-12.6 0l-112 141.7a7.98 7.98 0 006.3 12.9h73.9V856c0 4.4 3.6 8 8 8h60c4.4 0 8-3.6 8-8V613.7H624c6.7 0 10.4-7.7 6.3-12.9L518.3 459z"/><path d="M811.4 366.7C765.6 245.9 648.9 160 512.2 160S258.8 245.8 213 366.6C127.3 389.1 64 467.2 64 560c0 110.5 89.5 200 199.9 200H304c4.4 0 8-3.6 8-8v-60c0-4.4-3.6-8-8-8h-40.1c-33.7 0-65.4-13.4-89-37.7-23.5-24.2-36-56.8-34.9-90.6.9-26.4 9.9-51.2 26.2-72.1 16.7-21.3 40.1-36.8 66.1-43.7l37.9-9.9 13.9-36.6c8.6-22.8 20.6-44.1 35.7-63.4a245.6 245.6 0 0152.4-49.9c41.1-28.9 89.5-44.2 140-44.2s98.9 15.3 140 44.2c19.9 14 37.5 30.8 52.4 49.9 15.1 19.3 27.1 40.7 35.7 63.4l13.8 36.5 37.8 10C846.1 454.5 884 503.8 884 560c0 33.1-12.9 64.3-36.3 87.7a123.07 123.07 0 01-87.6 36.3H720c-4.4 0-8 3.6-8 8v60c0 4.4 3.6 8 8 8h40.1C870.5 760 960 670.5 960 560c0-92.7-63.1-170.7-148.6-193.3z"/>';
    const ANT_CLOUD_OFF =
        '<mask id="titlebar-sync-cut" maskUnits="userSpaceOnUse" x="64" y="64" width="896" height="896">' +
            '<rect x="64" y="64" width="896" height="896" fill="#fff"/>' +
            '<path d="M229 229L795 795" stroke="#000" stroke-width="150" stroke-linecap="round"/>' +
        '</mask>' +
        '<path mask="url(#titlebar-sync-cut)" d="M811.4 418.7C765.6 297.9 648.9 212 512.2 212S258.8 297.8 213 418.6C127.3 441.1 64 519.1 64 612c0 110.5 89.5 200 199.9 200h496.2C870.5 812 960 722.5 960 612c0-92.7-63.1-170.7-148.6-193.3zm36.3 281a123.07 123.07 0 01-87.6 36.3H263.9c-33.1 0-64.2-12.9-87.6-36.3A123.3 123.3 0 01140 612c0-28 9.1-54.3 26.2-76.3a125.7 125.7 0 0166.1-43.7l37.9-9.9 13.9-36.6c8.6-22.8 20.6-44.1 35.7-63.4a245.6 245.6 0 0152.4-49.9c41.1-28.9 89.5-44.2 140-44.2s98.9 15.3 140 44.2c19.9 14 37.5 30.8 52.4 49.9 15.1 19.3 27.1 40.7 35.7 63.4l13.8 36.5 37.8 10c54.3 14.5 92.1 63.8 92.1 120 0 33.1-12.9 64.3-36.3 87.7z"/>' +
        '<path d="M260.3 209.4a8.03 8.03 0 00-11.3 0L209.4 249a8.03 8.03 0 000 11.3l554.4 554.4c3.1 3.1 8.2 3.1 11.3 0l39.6-39.6c3.1-3.1 3.1-8.2 0-11.3L260.3 209.4z"/>';
    const antIcon = (inner) => `<svg class="icon" viewBox="64 64 896 896" fill="currentColor" aria-hidden="true" focusable="false">${inner}</svg>`;
    const CLOUD = {
        success: [ANT_CLOUD_SYNC, 'synced', 'Synced'],
        error: [ANT_CLOUD_SYNC, 'unsynced', 'Unsynced'],
        warning: [ANT_CLOUD_OFF, 'offline', 'Offline'],
        processing: [ANT_CLOUD_UPLOAD, 'saving', 'Saving'],
    };
    function renderSave() {
        if (!saveEl) return;
        const { save, sync, syncProblem } = Store.state;
        let [tone, text, title] = (save === 'saved' && SYNC[sync]) || SAVE[save] || SAVE.saved;
        if (save === 'saved' && sync === 'error' && SYNC_PROBLEM[syncProblem]) title = SYNC_PROBLEM[syncProblem];
        saveEl.title = title;
        if (sync === 'off' || !SYNC[sync]) {
            saveEl.className = `titlebar-save badge-dot badge-dot--${tone}`;
            saveEl.textContent = text;
            return;
        }
        // The cloud's hover text is one word; a change that failed to save
        // locally says so rather than "Unsynced".
        const [icon, state, cloudWord] = CLOUD[tone];
        const word = save === 'error' ? 'Unsaved' : cloudWord;
        saveEl.title = word;
        saveEl.className = `titlebar-save titlebar-sync titlebar-sync--${state}`;
        saveEl.innerHTML = `${antIcon(icon)}<span class="sr-only"></span>`;
        saveEl.lastChild.textContent = word;
    }

    renderTitle();
    renderSave();
    Store.on((c) => {
        if (c.type === 'tabs' || c.type === 'plan' || c.type === 'workspace') renderTitle();
        else if (c.type === 'save') renderSave();
    });
}());
