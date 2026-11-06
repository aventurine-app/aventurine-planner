'use strict';

// ─── limits.js (free sandbox) ───────────────────────────────────────────────
// What the free sandbox allows, and the one global (`PrismDemo`) that tells the
// rest of the page it is the sandbox. It loads straight after sim/plan.js.
//
// The caps are not drawn anywhere new. The app already refuses a plan past
// `LIMITS.nodes` modules or `LIMITS.goals` goals, in the editor and again when
// a plan or goal list is saved or imported, so the sandbox lowers those two
// numbers. The plan cap is the workspace's (`maxPlans`, demo/boot.js).
//
// PrismDemo.limitToast is what the app adds to its "limit reached" messages
// (Store.limitReached): a button to the full app.

(function () {
    const P = window.CitrinePlan;

    const LIMITS = Object.freeze({ plans: 1, modules: 7, goals: 1 });
    const UPGRADE_URL = 'https://aventurine-app.com/#pricing';
    // What a new plan is called here (the app's own default is "Untitled plan").
    const PLAN_NAME = 'Demo Plan';

    P.LIMITS.nodes = LIMITS.modules;
    P.LIMITS.goals = LIMITS.goals;

    function openUpgrade() {
        window.open(UPGRADE_URL, '_blank', 'noopener');
    }

    window.PrismDemo = Object.freeze({
        LIMITS,
        UPGRADE_URL,
        PLAN_NAME,
        limitToast: Object.freeze({ action: Object.freeze({ label: 'Get the full app', onClick: openUpgrade }) }),
    });
}());
