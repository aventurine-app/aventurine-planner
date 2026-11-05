'use strict';

// ─── export-menu.js ─────────────────────────────────────────────────────────
// How a person takes their plans away:
//
//   ExportMenu.plan(id)   the plan menu's Export…: a dialog offering the PDF
//                         report, a spreadsheet (CSV) or the plan file (JSON)
//   Preferences → Storage → Export:
//     Download All        every plan, the goals and a CSV per plan, as a zip
//     Report of All Plans one PDF report covering every plan
//
// The files are made by the browser backend (web/exports.js, through
// Store.exportPlan / Store.exportAll); the report is shell/report.js.

(function () {
    const CHOICES = [
        {
            format: 'pdf', icon: 'file-pdf', title: 'PDF Report',
            desc: 'Charts, figures, goals and a year-by-year table. Choose Save as PDF in the print dialog.',
        },
        {
            format: 'csv', icon: 'file-csv', title: 'Spreadsheet (CSV)',
            desc: 'Every month\'s income, spending and balances, for Excel, Numbers or Google Sheets.',
        },
        {
            format: 'json', icon: 'file-code', title: 'Plan File (JSON)',
            desc: 'The whole plan, to import into Aventurine Planner again.',
        },
    ];

    const reportTitle = (name) => `${name} - Aventurine Planner report`;

    /** Print the report on `plans` (each with its run, from Runs). */
    async function printReport(ids, title) {
        await Store.flush();
        const wanted = new Set(ids);
        const entries = Runs.all().filter(({ plan }) => wanted.has(plan.id));
        if (!entries.length) return;
        Report.print({ entries, goals: Store.state.goals, title });
    }

    function exportAs(id, format) {
        if (format === 'pdf') return printReport([id], reportTitle(Store.planName(id)));
        return Store.exportPlan(id, format);
    }

    /** The plan menu's Export…: pick a format, and it is made at once. */
    async function plan(id) {
        let chosen = null;
        const body = document.createElement('div');
        body.className = 'export-choices';
        body.innerHTML = CHOICES.map((c) => `
            <button class="export-choice" type="button" data-format="${c.format}" data-close>
                ${iconSvg(c.icon)}
                <span class="export-choice-text">
                    <span class="export-choice-title">${escapeHtml(c.title)}</span>
                    <span class="export-choice-desc">${escapeHtml(c.desc)}</span>
                </span>
            </button>`).join('');
        body.addEventListener('click', (e) => {
            const b = e.target.closest('[data-format]');
            if (b) chosen = b.dataset.format;
        });
        await UI.dialog({
            title: `Export ${Store.planName(id)}`,
            body,
            actions: [{ label: 'Cancel', className: 'button-secondary', value: () => null }],
        });
        if (chosen) await exportAs(id, chosen);
    }

    // ── Preferences → Storage ───────────────────────────────────────────────

    const panel = document.querySelector('[data-panel="storage"]');
    const allBtn = panel && panel.querySelector('[data-export-all]');
    const reportBtn = panel && panel.querySelector('[data-export-report]');

    /** Run `work` with `btn` busy, so a second click cannot start it twice. */
    async function busy(btn, work) {
        btn.disabled = true;
        btn.classList.add('is-busy');
        try {
            await work();
        } catch (e) {
            console.error('[export] failed:', e);
            UI.toast('The export did not finish. Try again in a moment.', { type: 'error' });
        } finally {
            btn.disabled = false;
            btn.classList.remove('is-busy');
        }
    }

    if (allBtn) allBtn.addEventListener('click', () => busy(allBtn, () => Store.exportAll()));
    if (reportBtn) {
        reportBtn.addEventListener('click', () => busy(reportBtn,
            () => printReport(Store.state.tabs, 'Aventurine Planner report')));
    }

    window.ExportMenu = { plan };
}());
