'use strict';

// ─── settings.js ────────────────────────────────────────────────────────────
// Preferences: Appearance (surface theme, flow animation), Format (currency
// symbol, its position, digit separators), Storage (whether the browser has
// promised to keep the plans), Account (shell/account.js), About.
//
// Appearance and Format live in localStorage (per browser, read pre-paint by
// theme-init.js and by core/format.js). A Format change fires 'citrine:format'
// so the app can redraw its numbers.

(function () {
    const overlay = document.getElementById('prefs');
    if (!overlay) return;
    const html = document.documentElement;

    // ── Tabs ───────────────────────────────────────────────────────────────

    const tabs = [...overlay.querySelectorAll('.settings-tab')];

    function selectTab(name) {
        for (const t of tabs) {
            const on = t.dataset.tab === name;
            t.setAttribute('aria-selected', String(on));
            t.tabIndex = on ? 0 : -1;
        }
        overlay.querySelectorAll('.settings-panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
        if (name === 'storage') refreshStorage();
        if (name === 'account') Account.refresh();
    }

    overlay.querySelector('.settings-tabs').addEventListener('click', (e) => {
        const t = e.target.closest('.settings-tab');
        if (t) selectTab(t.dataset.tab);
    });
    overlay.querySelector('.settings-tabs').addEventListener('keydown', (e) => {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        const i = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
        const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
        selectTab(next.dataset.tab);
        next.focus();
    });

    // ── Appearance ─────────────────────────────────────────────────────────

    const themeChoice = () => { const s = Prefs.get('color-theme'); return s === 'dark' || s === 'system' ? s : ''; };
    const dark = window.matchMedia('(prefers-color-scheme: dark)');

    function applyTheme(choice) {
        Prefs.set('color-theme', choice);
        const effective = choice === 'system' ? (dark.matches ? 'dark' : '') : choice;
        if (effective) html.dataset.theme = effective;
        else delete html.dataset.theme;
        markTheme();
    }

    function markTheme() {
        const choice = themeChoice();
        overlay.querySelectorAll('[data-theme-choice]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.themeChoice === choice)));
    }

    dark.addEventListener('change', () => { if (themeChoice() === 'system') applyTheme('system'); });

    overlay.querySelector('.theme-options').addEventListener('click', (e) => {
        const b = e.target.closest('[data-theme-choice]');
        if (b) applyTheme(b.dataset.themeChoice);
    });

    function markSwitch(name, value) {
        overlay.querySelectorAll(`[data-pref="${name}"] .seg-switch-btn`).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)));
    }

    overlay.querySelector('[data-pref="flow-motion"]').addEventListener('click', (e) => {
        const b = e.target.closest('.seg-switch-btn');
        if (!b) return;
        Prefs.set('flow-motion', b.dataset.value);
        if (b.dataset.value === 'off') html.dataset.motion = 'off';
        else delete html.dataset.motion;
        markSwitch('flow-motion', b.dataset.value);
    });

    // ── Format ─────────────────────────────────────────────────────────────

    const formatChanged = () => window.dispatchEvent(new Event('citrine:format'));
    const symbolInput = overlay.querySelector('[data-pref="currency-symbol"]');
    const numberSelect = overlay.querySelector('[data-pref="number-format"]');

    symbolInput.addEventListener('input', () => {
        Fmt.setPref('currency-symbol', symbolInput.value.trim().slice(0, 3));
        formatChanged();
    });
    overlay.querySelector('[data-pref="symbol-position"]').addEventListener('click', (e) => {
        const b = e.target.closest('.seg-switch-btn');
        if (!b) return;
        Fmt.setPref('symbol-position', b.dataset.value);
        markSwitch('symbol-position', b.dataset.value);
        formatChanged();
    });
    numberSelect.addEventListener('change', () => {
        Fmt.setPref('number-format', numberSelect.value);
        formatChanged();
    });

    function refreshAppearance() {
        markTheme();
        markSwitch('flow-motion', Prefs.get('flow-motion', 'on'));
        symbolInput.value = Fmt.prefs.symbol;
        markSwitch('symbol-position', Fmt.prefs.position);
        numberSelect.value = Fmt.prefs.numberFormat;
    }

    // ── Storage ────────────────────────────────────────────────────────────
    // Has the browser promised not to clear the plans when space runs low?

    const persistDesc = overlay.querySelector('[data-persist-desc]');
    const persistBtn = overlay.querySelector('[data-persist-request]');
    const PERSIST_TEXT = {
        kept: 'The browser will not clear its copy of your plans when it runs low on space.',
        open: 'The browser may clear its copy of your plans when it runs low on space. Ask it to keep that copy.',
        declined: 'The browser declined. If it clears its copy, your synced plans are still in your account.',
        unsupported: 'This browser cannot promise to keep its copy, but your synced plans are also in your account.',
    };

    function showPersistence(state) {
        persistDesc.textContent = PERSIST_TEXT[state];
        persistBtn.hidden = state !== 'open';
    }

    async function refreshStorage() {
        const store = navigator.storage;
        if (!store || typeof store.persisted !== 'function' || typeof store.persist !== 'function') {
            showPersistence('unsupported');
            return;
        }
        try {
            showPersistence((await store.persisted()) ? 'kept' : 'open');
        } catch {
            showPersistence('unsupported');
        }
    }

    persistBtn.addEventListener('click', async () => {
        persistBtn.disabled = true;
        persistBtn.classList.add('is-busy');
        try {
            showPersistence((await navigator.storage.persist()) ? 'kept' : 'declined');
        } catch {
            showPersistence('declined');
        } finally {
            persistBtn.disabled = false;
            persistBtn.classList.remove('is-busy');
        }
    });

    function open(tab = 'appearance') {
        refreshAppearance();
        selectTab(tab);
        UI.openModal(overlay, { initialFocus: overlay.querySelector('.settings-tab[aria-selected="true"]') });
    }

    window.Settings = { open };
}());
