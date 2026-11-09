'use strict';

// ─── compare.js ─────────────────────────────────────────────────────────────
// The Compare workspace, as an Ant Design page: two plans side by side, and
// every plan ranked. Every plan runs over the same length (the Over chips,
// kept in Prefs) from its own start; the plans keep their own lengths, as
// Compare runs a copy (Runs.all({ years })).
//
//   Two plans     picked in the bar (A in blue, B in orange; Swap trades
//                 them), with which ends ahead and by how much
//     Net worth     both plans' net worth over the run, the gap between them
//                   shaded; hovering reads every month
//     Side by side  net worth and debt at the end, when debt is gone, what was
//                   spent, interest, growth, taxes and the goals met on time,
//                   each with the difference
//   All plans     every plan in a row: net worth at the end, growth (account
//                 earnings plus card cash back), debt payoff (months until
//                 nothing is owed for the rest of the run: "No debt" when
//                 nothing ever is, "Not paid off" when debt is still owed at
//                 the end), expenses (what expense modules and budget groups
//                 spent over the run; taxes and card fees aside). Each
//                 column is ranked: the best tagged Best with a green trophy,
//                 the runners-up 2nd (silver) and 3rd (bronze), each tinted,
//                 so rank never rests on colour alone.
//
// Pressing a plan's name opens it in Analyze.

(function () {
    const D = window.Describe;
    const G = window.CitrineGoals;
    const K = window.Components;
    const root = document.getElementById('compare');
    if (!root) return;

    const esc = escapeHtml;
    const money = (v, o) => Fmt.money(v, o);

    // The tint each podium place wears (--heat in compare.css), best first.
    const HEAT = [1, 0.6, 0.32];
    const PLACES = ['Best', '2nd', '3rd'];
    // The medal the runners-up's trophies wear (--medal-* in style.css). Best
    // wears the success green instead.
    const MEDALS = [null, 'silver', 'bronze'];

    // The lengths on offer: the same as Analyze's (LENGTHS in outlook.js).
    const LENGTHS = [1, 3, 5, 10, 20, 30, 40, 50];
    const PREFS = { years: 'compare-years', pair: 'compare-pair' };
    const yearsWord = (y) => `${y} year${y === 1 ? '' : 's'}`;

    /** Months until debt-free, in words. */
    const payoff = (v) => (v === Infinity ? 'Not paid off' : v === 0 ? 'No debt' : D.duration(v));

    // All plans' columns: their name, how to read them off a run, and which end is best.
    const COLUMNS = [
        { id: 'worth', name: 'Net worth', note: 'At the end', best: 'max', show: (v) => money(v), signed: true },
        { id: 'growth', name: 'Growth', note: 'Interest and rewards', best: 'max', show: (v) => money(v) },
        { id: 'payoff', name: 'Debt payoff', note: 'Until debt-free', best: 'min', show: payoff },
        { id: 'expenses', name: 'Expenses', note: 'Over the whole run', best: 'min', show: (v) => money(v) },
    ];


    root.innerHTML = `
        <div class="page scroll-y">
            <section class="card compare-pick" aria-label="Two plans to compare">
                <div class="compare-pick-body">
                    <span class="badge-dot compare-dot--a" aria-hidden="true"></span>${K.planPick({ act: 'pick-a', label: 'First plan' })}
                    <button class="button-secondary button-icon" type="button" data-act="swap" aria-label="Swap the two plans" title="Swap">${iconSvg('arrows-left-right')}</button>
                    <span class="badge-dot compare-dot--b" aria-hidden="true"></span>${K.planPick({ act: 'pick-b', label: 'Second plan' })}
                    <div class="compare-over">
                        <span class="page-label" aria-hidden="true">Over</span>
                        ${K.segmented(LENGTHS.map((y) => [y, `${y}Y`]), null, { attr: 'years', label: 'Length every plan runs over', chips: true })}
                    </div>
                </div>
            </section>
            <div class="card-row" data-pair>
                <section class="card" aria-labelledby="compare-chart-title">
                    <div class="card-head"><h2 class="card-title" id="compare-chart-title">Net worth</h2><div class="chart-legend compare-legend"></div></div>
                    <div class="compare-chart-body"><div class="chart-box compare-chart"></div></div>
                </section>
                <section class="card" aria-labelledby="compare-side-title">
                    <div class="card-head"><h2 class="card-title" id="compare-side-title">Side by side</h2></div>
                    <div class="card-body card-body--flush"><div class="table-wrap" data-side></div></div>
                </section>
            </div>
            <section class="card compare-all" aria-labelledby="compare-all-title">
                <div class="card-head"><h2 class="card-title" id="compare-all-title">All plans</h2></div>
                <div class="card-body card-body--flush"><div class="table-wrap compare-wrap"></div></div>
            </section>
        </div>`;

    const pickA = root.querySelector('[data-act="pick-a"]');
    const pickB = root.querySelector('[data-act="pick-b"]');
    const swapBtn = root.querySelector('[data-act="swap"]');
    const pairRow = root.querySelector('[data-pair]');
    const legendEl = root.querySelector('.compare-legend');
    const chartBox = root.querySelector('.compare-chart');
    const sideEl = root.querySelector('[data-side]');
    const wrap = root.querySelector('.compare-wrap');
    const showing = () => Store.state.workspace === 'compare';

    /** The length every plan is run over. */
    function years() {
        const y = Number(Prefs.get(PREFS.years, 30));
        return LENGTHS.includes(y) ? y : 30;
    }

    /** The two plans side by side, as ids: the pair kept in Prefs where both
     *  still exist, else the first plans in the navigation. `b` is null when
     *  there is only one plan. */
    function pair() {
        const { tabs } = Store.state;
        let saved = [];
        try { saved = JSON.parse(Prefs.get(PREFS.pair, '[]')); } catch { saved = []; }
        if (!Array.isArray(saved)) saved = [];
        const a = tabs.includes(saved[0]) ? saved[0] : tabs[0] || null;
        const b = tabs.includes(saved[1]) && saved[1] !== a ? saved[1] : tabs.find((id) => id !== a) || null;
        return { a, b };
    }
    const setPair = (a, b) => Prefs.set(PREFS.pair, JSON.stringify([a, b]));

    // ── Figures ────────────────────────────────────────────────────────────

    /** Months until no debt is owed for the rest of the run: 0 when none ever
     *  is, Infinity when some still is at the end. */
    function debtFree(res) {
        const n = res.months;
        const debts = Object.values(res.nodes).filter((r) => r.role === 'debt');
        for (let k = n; k >= 0; k--) {
            let owed = 0;
            for (const r of debts) owed += r.balance[k];
            if (owed > 0.005) return k === n ? Infinity : k + 1;
        }
        return 0;
    }

    /** One plan's figures over its run, in the money shown, or null when the
     *  run failed. */
    function figures(plan, res) {
        if (!res) return null;
        const n = res.months;
        const def = G.deflator(plan, n);
        const F = res.flows;
        const sum = (fn) => { let s = 0; for (let m = 0; m < n; m++) s += fn(m) * def[m + 1]; return s; };
        let owed = 0;
        for (const r of Object.values(res.nodes)) {
            if (r.role === 'debt') owed += r.balance[n];
        }
        // Goals are judged over the goal horizon, not the length compared.
        const goals = Store.state.goals;
        const goalRes = goals.length ? Runs.forGoals(plan) : null;
        const evs = goalRes ? G.evaluate(plan, goalRes, goals) : [];
        return {
            worth: res.netWorth[n] * def[n],
            worthSeries: Float64Array.from(res.netWorth, (v, k) => v * def[k]),
            owed: owed * def[n],
            payoff: debtFree(res),
            spent: sum((m) => F.spent[m] + F.skimmed[m]),
            // What expenses and budget groups spent: the Sankey's Spending,
            // without taxes or a card's fees.
            expenses: sum((m) => F.spent[m]),
            interest: sum((m) => F.interest[m]),
            growth: sum((m) => F.growth[m] + F.cashback[m]),
            // Card annual fees (the only other cut, `skimmed`) are fees, not taxes.
            taxes: sum((m) => F.withheld[m]),
            goalsMet: evs.filter((e) => e.status === 'met').length,
            goalCount: goals.length,
        };
    }

    // ── Two plans ──────────────────────────────────────────────────────────

    /** A difference as a tag: green where A does better, red where worse,
     *  grey where they match or neither way is better. */
    function diffTag(d, { better = 'up', text } = {}) {
        if (Math.abs(d) < 0.5) return K.tag('Same');
        const up = d > 0;
        const tone = better === 'none' ? '' : (up === (better === 'up')) ? 'success' : 'error';
        return K.tag(text || money(Math.abs(d), { compact: true }), { tone, icon: up ? 'arrow-up' : 'arrow-down' });
    }

    /** When a plan is debt-free from, as words. */
    function freeFrom(plan, f) {
        if (f.payoff === Infinity) return 'Not in this run';
        if (f.payoff === 0) return 'No debt';
        return D.monthLabel(plan, f.payoff);
    }

    function sideBySide(a, b, fa, fb) {
        const rows = [
            ['Net worth at the end', money(fa.worth), money(fb.worth), diffTag(fa.worth - fb.worth)],
            ['Owed at the end', money(fa.owed), money(fb.owed), diffTag(fa.owed - fb.owed, { better: 'down' })],
            ['Debt-free from', freeFrom(a.plan, fa), freeFrom(b.plan, fb),
                Number.isFinite(fa.payoff) && Number.isFinite(fb.payoff) && fa.payoff !== fb.payoff
                    ? diffTag(fa.payoff - fb.payoff, { better: 'down', text: D.duration(Math.abs(fa.payoff - fb.payoff)) })
                    : fa.payoff === fb.payoff ? K.tag('Same') : '<span class="is-muted">—</span>'],
            ['Spent', money(fa.spent), money(fb.spent), diffTag(fa.spent - fb.spent, { better: 'none' })],
            ['Interest paid', money(fa.interest), money(fb.interest), diffTag(fa.interest - fb.interest, { better: 'down' })],
            ['Growth', money(fa.growth), money(fb.growth), diffTag(fa.growth - fb.growth)],
            ['Taxes paid', money(fa.taxes), money(fb.taxes), diffTag(fa.taxes - fb.taxes, { better: 'down' })],
        ];
        if (fa.goalCount) {
            rows.push(['Goals met on time', `${fa.goalsMet} of ${fa.goalCount}`, `${fb.goalsMet} of ${fb.goalCount}`,
                diffTag(fa.goalsMet - fb.goalsMet, { text: String(Math.abs(fa.goalsMet - fb.goalsMet)) })]);
        }
        sideEl.innerHTML = `<table class="data-table table--md compare-side">
            <caption class="sr-only">${esc(a.plan.name)} and ${esc(b.plan.name)} side by side</caption>
            <thead><tr><th scope="col">Measure</th>
                <th scope="col" class="is-num"><span class="badge-dot compare-dot--a">${esc(a.plan.name)}</span></th>
                <th scope="col" class="is-num"><span class="badge-dot compare-dot--b">${esc(b.plan.name)}</span></th>
                <th scope="col" class="is-num"><abbr title="${esc(a.plan.name)} against ${esc(b.plan.name)}">Difference</abbr></th></tr></thead>
            <tbody>${rows.map(([name, va, vb, d]) => `<tr><th scope="row" class="is-muted">${esc(name)}</th>
                <td class="is-num">${esc(va)}</td><td class="is-num">${esc(vb)}</td><td class="is-num">${d}</td></tr>`).join('')}</tbody>
        </table>`;
    }

    /** Ticks along a run of `y` years counted from each plan's own start
     *  (the plans may start in different months): Start, 1y, 2y…, thinned
     *  to at most ~8 labels. */
    function runTicks(y) {
        const step = Math.ceil((y + 1) / 8);
        const ticks = [];
        for (let j = 0; j <= y; j += step) ticks.push({ i: j * 12, label: j ? `${j}y` : 'Start' });
        return ticks;
    }

    function drawPair(a, b, fa, fb, y) {
        const count = y * 12 + 1;
        legendEl.innerHTML = [[a.plan.name, '--chart-plan-a'], [b.plan.name, '--chart-plan-b']].map(([name, color]) =>
            `<span class="chart-legend-item"><i class="is-line" style="--swatch: var(${color})"></i>${esc(name)}</span>`).join('');
        Chart.draw(chartBox, {
            kind: 'area',
            label: `Net worth of ${a.plan.name} and ${b.plan.name} over ${yearsWord(y)}`,
            count,
            xTicks: runTicks(y),
            bands: [],
            lines: [
                { label: a.plan.name, color: '--chart-plan-a', values: fa.worthSeries },
                { label: b.plan.name, color: '--chart-plan-b', values: fb.worthSeries },
            ],
            between: true,
            format: (v) => money(v, { compact: true }),
            tooltip: (k) => ({
                title: k === 0 ? 'At the start' : `${D.duration(k)} in`,
                rows: [
                    { label: a.plan.name, color: '--chart-plan-a', value: money(fa.worthSeries[k]) },
                    { label: b.plan.name, color: '--chart-plan-b', value: money(fb.worthSeries[k]) },
                    { label: 'Difference', color: '--chart-grid', value: money(fa.worthSeries[k] - fb.worthSeries[k], { sign: true }), total: true },
                ],
            }),
        });
    }

    function renderPair(rows, y) {
        const { a: aId, b: bId } = pair();
        const a = rows.find((r) => r.plan.id === aId);
        const b = rows.find((r) => r.plan.id === bId);
        pickA.querySelector('.plan-pick-name').textContent = a ? a.plan.name : '';
        pickB.querySelector('.plan-pick-name').textContent = b ? b.plan.name : 'Add a second plan';
        pickB.disabled = !b;
        swapBtn.disabled = !b;
        pairRow.hidden = !a || !b || !a.f || !b.f;
        if (pairRow.hidden) return;
        sideBySide(a, b, a.f, b.f);
        drawPair(a, b, a.f, b.f, y);
    }

    // ── All plans ──────────────────────────────────────────────────────────

    function renderAll(rows, y) {
        if (!rows.length) {
            wrap.innerHTML = K.empty({ icon: 'files', title: 'No plans yet' });
            return;
        }
        // Each column's distinct figures, best first, when the plans differ on
        // it at all. Figures within half a unit tie and share a place (debt
        // still owed at the end, Infinity, never places).
        const ranked = {};
        const measured = rows.filter((r) => r.f);
        for (const c of COLUMNS) {
            const vals = measured.map((r) => r.f[c.id]).sort((p, q) => (c.best === 'max' ? q - p : p - q));
            const distinct = vals.filter((v, i) => i === 0 || Math.abs(v - vals[i - 1]) >= 0.5);
            if (distinct.length > 1) ranked[c.id] = distinct;
        }
        /** A figure's podium place (0 = best), or -1 off the podium or last. */
        const place = (c, v) => {
            const distinct = ranked[c.id];
            if (!distinct) return -1;
            const i = distinct.findIndex((d) => Math.abs(v - d) < 0.5);
            return i < HEAT.length && i < distinct.length - 1 ? i : -1;
        };
        const cell = (r, c) => {
            if (!r.f) return '<td class="is-num is-muted">—</td>';
            const v = r.f[c.id];
            const p = place(c, v);
            const cls = ['is-num', p >= 0 ? 'is-heat' : '', c.signed && v < -0.5 ? 'is-negative' : ''].filter(Boolean).join(' ');
            const badge = p >= 0 ? K.tag(PLACES[p], { tone: p === 0 ? 'success' : '', icon: 'trophy' }) : '';
            const medal = p > 0 ? ` data-medal="${MEDALS[p]}"` : '';
            return `<td class="${cls}"${p >= 0 ? ` style="--heat: ${HEAT[p]}"` : ''}><span class="compare-cell"${medal}>${badge}<span class="compare-value">${esc(c.show(v))}</span></span></td>`;
        };
        wrap.innerHTML = `<table class="data-table compare-table">
            <caption class="sr-only">Every plan compared over ${esc(yearsWord(y))}</caption>
            <thead><tr><th scope="col" class="is-sticky">Plan</th>${COLUMNS.map((c) => `<th scope="col" class="is-num"><span class="compare-col">${esc(c.name)}<span class="compare-col-note">${esc(c.note)}</span></span></th>`).join('')}</tr></thead>
            <tbody>${rows.map((r) => {
                // The first and last months, as the plan builder's scrubber names them.
                const span = `${D.monthLabel(r.plan, 0)} to ${D.monthLabel(r.plan, y * 12 - 1)}`;
                return `<tr>
                    <th scope="row" class="is-sticky">
                        <button class="button-link compare-plan" type="button" data-open="${esc(r.plan.id)}" title="Analyze ${esc(r.plan.name)}">${esc(r.plan.name)}</button>
                        <span class="compare-span">${esc(span)}</span>
                    </th>
                    ${COLUMNS.map((c) => cell(r, c)).join('')}
                </tr>`;
            }).join('')}</tbody>
        </table>`;
    }

    // ── Render ─────────────────────────────────────────────────────────────

    function render() {
        if (!showing()) return;
        const y = years();
        root.querySelectorAll('[data-years]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.years) === y)));
        const rows = Runs.all({ years: y }).map(({ plan, results }) => ({ plan, results, f: figures(plan, results) }));
        renderPair(rows, y);
        renderAll(rows, y);
    }

    /** The plans' menu for one side of the pair; picking the other side's
     *  plan swaps the two. */
    function pickMenu(btn, side) {
        const { a, b } = pair();
        const now = side === 'a' ? a : b;
        UI.menu(btn, Store.state.tabs.map((id) => ({
            label: Store.planName(id), icon: id === now ? 'check' : 'file', chosen: id === now,
            onSelect: () => {
                if (side === 'a') setPair(id, id === b ? a : b);
                else setPair(id === a ? b : a, id);
                render();
            },
        })));
    }

    root.addEventListener('click', (e) => {
        const open = e.target.closest('[data-open]');
        if (open) {
            Store.setWorkspace('analyze');
            Store.openPlan(open.dataset.open);
            return;
        }
        const y = e.target.closest('[data-years]');
        if (y) { Prefs.set(PREFS.years, y.dataset.years); render(); return; }
        const act = e.target.closest('[data-act]');
        if (!act) return;
        if (act.dataset.act === 'swap') {
            const { a, b } = pair();
            if (b) { setPair(b, a); render(); }
        } else if (act.dataset.act === 'pick-a') pickMenu(act, 'a');
        else if (act.dataset.act === 'pick-b') pickMenu(act, 'b');
    });

    // Redraw the chart when its box changes size, coalesced to one per frame.
    let resizeQueued = false;
    new ResizeObserver(() => {
        if (resizeQueued) return;
        resizeQueued = true;
        requestAnimationFrame(() => { resizeQueued = false; render(); });
    }).observe(chartBox);

    Store.on((c) => {
        if (c.type === 'workspace' || c.type === 'tabs' || c.type === 'results' || c.type === 'goals') render();
    });
    window.addEventListener('citrine:format', render);
}());
