'use strict';

// ─── other-tab.js ───────────────────────────────────────────────────────────
// The screen shown while another tab is editing the plans. Two tabs would
// overwrite each other's changes, so this one waits. The backend answers
// /api/ready once the other tab is closed, and the app then carries on from
// where it was, with no reload.

(function () {
    const root = document.getElementById('lockscreen');
    if (!root) return;

    /** Show the waiting screen. `onReady` starts the app once this tab may load the plans. */
    function show(onReady) {
        root.hidden = false;
        root.innerHTML = `
            <div class="lock-card" role="status" aria-live="polite">
                <span class="role-tile role-tile--lg role-tile--accent">${iconSvg('copy')}</span>
                <h1 class="lock-title">Aventurine Planner is open in another tab</h1>
                <p class="lock-note">Plans can be edited in one tab at a time. Close the other tab and your plans will open here.</p>
            </div>`;
        api('GET', '/api/ready').then((r) => {
            if (r.ok) {
                root.hidden = true;
                onReady();
                return;
            }
            root.querySelector('.lock-note').textContent = 'Your plans could not be opened. Reload the page to try again.';
        });
    }

    window.OtherTab = { show };
}());
