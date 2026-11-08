'use strict';

// ─── runs.js ────────────────────────────────────────────────────────────────
// Every plan's run of the engine, for the views that look at more than the
// open plan (Compare, the goal board, the goal inspector). A plan is
// simulated once per version of it (its updatedAt) and length; the open
// plan's run over the app's length is the store's own.
//
//   Runs.all()           [{ plan, results }] for every plan, in navigation
//                        order, each run over the app's length (Store.state.years);
//                        results is null for a plan the engine failed on
//   Runs.all({ years })  the same, every plan run over `years` instead
//                        (Compare); the plans are not changed

(function () {
    const cache = new Map();   // `${plan id}|${years}` → { updatedAt, results }

    /** One plan's results over `years`, or null if the engine failed on it. */
    function of(plan, years) {
        if (years === Store.state.years && plan === Store.state.plan && Store.state.results) return Store.state.results;
        const key = `${plan.id}|${years}`;
        const hit = cache.get(key);
        if (hit && hit.updatedAt === plan.updatedAt) return hit.results;
        let results = null;
        try {
            results = window.CitrineEngine.simulate(Store.atLength(plan, years));
        } catch (e) {
            console.error('[runs] simulation failed', plan.id, e);
        }
        cache.set(key, { updatedAt: plan.updatedAt, results });
        return results;
    }

    function all({ years = null } = {}) {
        return Store.state.tabs.map((id) => Store.getPlan(id)).filter(Boolean)
            .map((plan) => ({ plan, results: of(plan, years ?? Store.state.years ?? plan.settings.years) }));
    }

    // A deleted plan's runs go with it.
    Store.on((c) => {
        if (c.type !== 'tabs') return;
        for (const key of cache.keys()) {
            if (!Store.state.tabs.includes(key.slice(0, key.lastIndexOf('|')))) cache.delete(key);
        }
    });

    window.Runs = { all };
}());
