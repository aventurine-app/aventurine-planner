'use strict';

// ─── sandbox.js (free sandbox) ──────────────────────────────────────────────
// The parts of the page that only the free sandbox has:
//
//   - the bar's title, "Aventurine Demo", and, together in the middle
//     of the bar, the limits meter and the "Get the full app" button;
//   - Preferences → "Free demo", which explains the sandbox and can reset it
//     (it takes the Account tab's place, since there is no account);
//   - the Storage tab's text, which says where the sandbox's data really is.
//
// Everything is drawn from Store.state, so it is right whenever it runs. This
// file loads just before app/main.js, but the plans may already be loaded by
// then, so it draws once at start as well as on each change.

(function () {
    const { LIMITS, UPGRADE_URL } = window.PrismDemo;

    const bar = document.querySelector('.titlebar');
    const prefs = document.getElementById('prefs');
    if (!bar || !prefs) return;

    // ── Top bar ────────────────────────────────────────────────────────────

    document.querySelector('.titlebar-name').textContent = 'Aventurine Demo';

    const CAPS = [
        ['plans', 'Plans'],
        ['modules', 'Modules'],
        ['goals', 'Goals'],
    ];

    // The limits and the button sit together in the middle of the bar (demo.css).
    const center = document.createElement('div');
    center.className = 'sandbox-center';
    center.innerHTML = `
        <div class="sandbox-meter" role="group" aria-label="Free demo limits">
            ${CAPS.map(([id, label]) => `
            <span class="sandbox-cap" data-cap="${id}">${label} <b class="sandbox-cap-count"></b></span>`).join('')}
        </div>
        <a class="sandbox-cta" href="${UPGRADE_URL}" target="_blank" rel="noopener">Get the full app</a>`;
    bar.insertBefore(center, document.getElementById('titlebar-save'));

    const counts = Object.fromEntries(CAPS.map(([id]) => [id, center.querySelector(`[data-cap="${id}"]`)]));

    function used() {
        const { tabs, plan, goals } = Store.state;
        return { plans: tabs.length, modules: plan ? plan.nodes.length : 0, goals: goals.length };
    }

    function renderMeter() {
        const now = used();
        for (const [id] of CAPS) {
            const el = counts[id];
            const full = now[id] >= LIMITS[id];
            el.dataset.state = full ? 'full' : 'open';
            el.querySelector('.sandbox-cap-count').textContent = `${now[id]}/${LIMITS[id]}`;
            el.title = full ? `The demo's ${id} limit is reached` : '';
        }
    }

    Store.on((c) => {
        if (c.type === 'tabs' || c.type === 'plan' || c.type === 'goals') renderMeter();
    });
    renderMeter();

    // ── Preferences ────────────────────────────────────────────────────────

    // The Account tab becomes the sandbox's explainer. Static markup, no user text.
    prefs.querySelector('.settings-tab[data-tab="account"]').textContent = 'Free Demo';
    prefs.querySelector('[data-panel="account"] .settings-section').innerHTML = `
        <div class="settings-section-header eyebrow">Free Demo</div>
        <div class="settings-card">
            <div class="settings-row settings-row--stack">
                <div class="settings-row-name">You are in the sandbox</div>
                <div class="settings-row-desc">It is the whole of Aventurine Planner with room for ${LIMITS.plans} plan, ${LIMITS.modules} modules and ${LIMITS.goals} goal. Your work stays in this tab and is never sent anywhere. Close the tab and it is gone, so export your plan if you want to keep it.</div>
            </div>
            <div class="settings-row">
                <div class="settings-row-label">
                    <div class="settings-row-name">Get the full app</div>
                    <div class="settings-row-desc">Room for more plans, modules and goals, synced across your devices with end-to-end encryption.</div>
                </div>
                <div class="settings-actions">
                    <a class="button-primary" href="${UPGRADE_URL}" target="_blank" rel="noopener">See Plans</a>
                </div>
            </div>
            <div class="settings-row">
                <div class="settings-row-label">
                    <div class="settings-row-name">Reset Sandbox</div>
                    <div class="settings-row-desc">Clear the plan and goal and start again.</div>
                </div>
                <div class="settings-actions">
                    <button class="button-secondary" type="button" data-sandbox-reset>Reset</button>
                </div>
            </div>
        </div>`;

    // Storage: there is nothing to protect, so say where the data is and hide the request.
    const storageNote = prefs.querySelector('[data-panel="storage"] .settings-row--stack');
    storageNote.querySelector('.settings-row-name').textContent = 'The sandbox lives in this tab';
    storageNote.querySelector('.settings-row-desc').textContent = 'Your work is kept while this tab is open, even through a reload, and is never sent to a server or saved on this device. Closing the tab clears it.';
    prefs.querySelector('[data-persist-desc]').closest('.settings-row').hidden = true;

    // Settings calls Account.refresh() when its tab opens; the sandbox has no account to load.
    window.Account = { refresh() {} };

    // ── Reset ──────────────────────────────────────────────────────────────

    prefs.querySelector('[data-sandbox-reset]').addEventListener('click', async () => {
        const ok = await UI.confirm({
            title: 'Reset Sandbox',
            message: 'Your plan and goal will be deleted and the sandbox will start again. This cannot be undone.',
            confirmLabel: 'Reset',
        });
        if (!ok) return;
        // Let any edit still waiting to be saved land first, so it cannot
        // write the plan back after the reset has cleared it.
        await Store.flush();
        window.PrismSandbox.reset();
        location.reload();
    });
}());
