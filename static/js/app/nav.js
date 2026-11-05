'use strict';

// ─── nav.js ─────────────────────────────────────────────────────────────────
// The navigation on the left, and the workspace it has open:
//
//   Plans     expands to list every plan. Opening one shows the plan builder
//             (the canvas, with the modules across its top). Each plan can be
//             renamed (double-click, F2 or its menu), duplicated, exported,
//             deleted, and dragged to a new place in the list.
//   Goals     the goals every plan is measured against (goals-board.js)
//   Analyze   the open plan's charts and tables, and how it does against the
//             goals (outlook.js)
//   Compare   every plan side by side (compare.js)
//
// Settings sits at the foot, and under it the toggle that collapses the pane
// to a rail of icons (also Ctrl+B); there, Plans opens a menu of the plans
// instead. Add plan, at the foot of the open list, makes a new plan or imports
// one from a file; each plan's own menu exports it.
//
// The open workspace is Store.state.workspace. This file mirrors it onto the
// app root as data-workspace, which the stylesheets use to show only it.

(function () {
    const root = document.getElementById('nav');
    const app = document.getElementById('app');
    if (!root) return;

    const RAIL_KEY = 'nav-rail';
    const PLANS_OPEN_KEY = 'nav-plans-open';
    const WORKSPACES = [
        ['goals', 'target', 'Goals'],
        ['analyze', 'chart-line-up', 'Analyze'],
        ['compare', 'scales', 'Compare'],
    ];

    let plansOpen = Prefs.get(PLANS_OPEN_KEY) !== '0';
    // The rail was the module library's before the library moved to the builder's top.
    let railOn = (Prefs.get(RAIL_KEY) ?? Prefs.get('library-rail')) === '1';

    root.innerHTML = `
        <div class="nav-scroll scroll-y">
            <div class="nav-group">
                <button class="nav-item" type="button" data-act="plans" aria-expanded="${plansOpen}" aria-controls="nav-plans" title="Plans">
                    ${iconSvg('files')}<span class="nav-label">Plans</span>
                    ${iconSvg('caret-down', { cls: 'nav-caret' })}
                </button>
                <div class="nav-plans-panel" id="nav-plans">
                    <ul class="nav-plans" aria-label="Plans"></ul>
                    <button class="nav-add" type="button" data-act="add-plan" aria-haspopup="menu" aria-expanded="false"
                        title="New plan (Ctrl+T) or import one">${iconSvg('plus', { cls: 'nav-plan-icon' })}<span class="nav-plan-name">Add plan</span></button>
                </div>
            </div>
            ${WORKSPACES.map(([id, icon, name]) => `
            <button class="nav-item" type="button" data-go="${id}" title="${name}">
                ${iconSvg(icon)}<span class="nav-label">${name}</span>
            </button>`).join('')}
        </div>
        <div class="nav-foot">
            <button class="nav-item" type="button" data-act="settings" title="Settings">${iconSvg('gear-six')}<span class="nav-label">Settings</span></button>
            <button class="nav-item" type="button" data-act="rail" aria-expanded="true" aria-label="Collapse navigation" title="Collapse navigation (Ctrl+B)">
                ${iconSvg('sidebar-simple')}<span class="nav-label">Collapse</span></button>
        </div>`;

    const panel = root.querySelector('.nav-plans-panel');
    const list = root.querySelector('.nav-plans');
    const plansBtn = root.querySelector('[data-act="plans"]');
    const railBtn = root.querySelector('[data-act="rail"]');

    // ── The plan list ──────────────────────────────────────────────────────

    let renaming = null;
    let listSig = null;

    function renderPlans() {
        if (renaming) return;
        const { tabs, activeId, workspace } = Store.state;
        const sig = `${tabs.map((id) => `${id}:${Store.planName(id)}`).join('|')}#${activeId}#${workspace}`;
        if (sig === listSig) return;
        listSig = sig;
        list.innerHTML = tabs.map((id) => {
            const open = id === activeId && workspace === 'plans';
            return `<li><div class="nav-plan" role="button" tabindex="0" data-id="${escapeHtml(id)}"
                    ${open ? 'aria-current="page"' : ''} title="${escapeHtml(Store.planName(id))}">
                ${iconSvg('file', { cls: 'nav-plan-icon' })}
                <span class="nav-plan-name">${escapeHtml(Store.planName(id))}</span>
                <button class="nav-plan-menu" type="button" tabindex="-1" aria-label="Plan options" aria-haspopup="menu">${iconSvg('dots-three')}</button>
            </div></li>`;
        }).join('');
    }

    function setPlansOpen(open) {
        plansOpen = open;
        Prefs.set(PLANS_OPEN_KEY, open ? '1' : '0');
        plansBtn.setAttribute('aria-expanded', String(open));
        panel.hidden = !open;
    }

    /** Open a plan in the builder. */
    function openPlan(id) {
        Store.setWorkspace('plans');
        Store.openPlan(id);
    }

    function planMenu(id, anchor) {
        UI.menu(anchor, [
            { label: 'Open', icon: 'arrow-right', onSelect: () => openPlan(id) },
            { label: 'Rename', icon: 'pencil-simple', onSelect: () => startRename(id) },
            { label: 'Duplicate', icon: 'copy', onSelect: () => Store.duplicatePlan(id) },
            { label: 'Export…', icon: 'export', onSelect: () => ExportMenu.plan(id) },
            'sep',
            { label: 'Delete', icon: 'trash', danger: true, onSelect: () => confirmDelete(id) },
        ]);
    }

    async function confirmDelete(id) {
        const ok = await UI.confirm({
            title: 'Delete Plan',
            message: `${Store.planName(id)} and everything on its canvas will be deleted. This cannot be undone.`,
            confirmLabel: 'Delete',
        });
        if (ok) Store.deletePlan(id);
    }

    function startRename(id) {
        if (railOn) setRail(false);
        if (!plansOpen) setPlansOpen(true);
        const item = list.querySelector(`.nav-plan[data-id="${CSS.escape(id)}"]`);
        if (!item) return;
        renaming = id;
        const nameEl = item.querySelector('.nav-plan-name');
        const input = document.createElement('input');
        input.className = 'nav-rename';
        input.value = Store.planName(id);
        input.maxLength = window.CitrinePlan.LIMITS.name;
        input.setAttribute('aria-label', 'Plan name');
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (save) => {
            if (done) return;
            done = true;
            renaming = null;
            listSig = null;
            if (save && input.value.trim()) Store.renamePlan(id, input.value);
            renderPlans();
        };
        input.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('pointerdown', (e) => e.stopPropagation());
        input.addEventListener('click', (e) => e.stopPropagation());
    }

    // Pointer: drag to reorder (up and down the list). A press that does not
    // drag is a click, which opens the plan (so does a click from assistive
    // tech, which sends no pointer events); the click a drag ends with is not.
    let drag = null;
    let dragged = false;

    list.addEventListener('pointerdown', (e) => {
        const item = e.target.closest('.nav-plan');
        if (!item || e.button !== 0 || renaming || e.target.closest('.nav-plan-menu')) return;
        drag = { id: item.dataset.id, y0: e.clientY, active: false, item, target: null };
        item.setPointerCapture(e.pointerId);
    });

    list.addEventListener('pointermove', (e) => {
        if (!drag) return;
        if (!drag.active && Math.abs(e.clientY - drag.y0) < 5) return;
        drag.active = true;
        drag.item.classList.add('is-dragging');
        const items = [...list.querySelectorAll('.nav-plan')];
        items.forEach((t) => t.classList.remove('is-drop-before', 'is-drop-after'));
        const over = items.find((t) => {
            const r = t.getBoundingClientRect();
            return e.clientY >= r.top && e.clientY < r.bottom;
        });
        if (over && over !== drag.item) {
            const r = over.getBoundingClientRect();
            const before = e.clientY < r.top + r.height / 2;
            over.classList.add(before ? 'is-drop-before' : 'is-drop-after');
            drag.target = { id: over.dataset.id, before };
        } else {
            drag.target = null;
        }
    });

    function endDrag() {
        if (!drag) return;
        const d = drag;
        drag = null;
        if (!d.active) return;
        dragged = true;
        setTimeout(() => { dragged = false; }, 0);
        if (d.target) {
            const order = Store.state.tabs.filter((x) => x !== d.id);
            let i = order.indexOf(d.target.id);
            if (!d.target.before) i += 1;
            order.splice(i, 0, d.id);
            Store.reorderTabs(order);
        }
        listSig = null;
        renderPlans();
    }
    list.addEventListener('pointerup', endDrag);
    list.addEventListener('pointercancel', endDrag);

    list.addEventListener('click', (e) => {
        const menuBtn = e.target.closest('.nav-plan-menu');
        if (menuBtn) { planMenu(menuBtn.closest('.nav-plan').dataset.id, menuBtn); return; }
        const item = e.target.closest('.nav-plan');
        if (item && !dragged && !renaming) openPlan(item.dataset.id);
    });
    list.addEventListener('dblclick', (e) => {
        const item = e.target.closest('.nav-plan');
        if (item && !e.target.closest('.nav-plan-menu')) startRename(item.dataset.id);
    });
    list.addEventListener('contextmenu', (e) => {
        const item = e.target.closest('.nav-plan');
        if (!item) return;
        e.preventDefault();
        planMenu(item.dataset.id, { x: e.clientX, y: e.clientY });
    });

    // Keyboard: arrows move along the list, Enter opens, F2 renames.
    list.addEventListener('keydown', (e) => {
        const item = e.target.closest('.nav-plan');
        if (!item || e.target !== item) return;
        const items = [...list.querySelectorAll('.nav-plan')];
        const i = items.indexOf(item);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
        } else if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openPlan(item.dataset.id);
        } else if (e.key === 'F2') {
            e.preventDefault();
            startRename(item.dataset.id);
        }
    });

    // ── Workspaces ─────────────────────────────────────────────────────────

    function renderWorkspace() {
        const w = Store.state.workspace;
        app.dataset.workspace = w;
        for (const b of root.querySelectorAll('[data-go]')) {
            if (b.dataset.go === w) b.setAttribute('aria-current', 'page');
            else b.removeAttribute('aria-current');
        }
        // In the rail the Plans icon stands for the builder.
        plansBtn.classList.toggle('is-current', w === 'plans');
        renderPlans();
    }

    // ── Rail ───────────────────────────────────────────────────────────────

    function setRail(on) {
        railOn = on;
        root.classList.toggle('is-rail', on);
        document.documentElement.classList.toggle('has-rail', on);
        railBtn.setAttribute('aria-expanded', String(!on));
        const label = on ? 'Expand navigation' : 'Collapse navigation';
        railBtn.setAttribute('aria-label', label);
        railBtn.title = `${label} (Ctrl+B)`;
        railBtn.querySelector('.nav-label').textContent = on ? 'Expand' : 'Collapse';
        Prefs.set(RAIL_KEY, on ? '1' : '0');
    }

    /** In the rail there is no room for the list: Plans opens a menu of them,
     *  beside the rail. (Placed at a point, so the menu leaves the button's
     *  aria-expanded, which reports the list, alone.) */
    function plansMenu(anchor) {
        const { tabs, activeId } = Store.state;
        const r = anchor.getBoundingClientRect();
        UI.menu({ x: r.right + 12, y: r.top }, [
            ...tabs.map((id) => ({ label: Store.planName(id), icon: id === activeId ? 'check' : 'file', onSelect: () => openPlan(id) })),
            'sep',
            ...addItems(),
        ]);
    }

    /** What Add plan offers: a blank plan, or one from a plan file. */
    const addItems = () => [
        { label: 'New plan', icon: 'plus', onSelect: () => newPlan() },
        { label: 'Import plan…', icon: 'download-simple', onSelect: () => importPlan() },
    ];

    function newPlan() {
        Store.setWorkspace('plans');
        Store.newPlan();
    }

    /** Import a plan file and open it in the builder. The import starts at
     *  once, in the click that asked for it, so the browser lets it open the
     *  file picker; cancelling it changes nothing. */
    async function importPlan() {
        const plan = await Store.importPlan();
        if (plan) Store.setWorkspace('plans');
    }

    // ── Input ──────────────────────────────────────────────────────────────

    // (A workspace button is data-go, not data-workspace: the app root carries
    // data-workspace, and closest() would find it from any button.)
    root.addEventListener('click', (e) => {
        const go = e.target.closest('[data-go]');
        if (go) {
            Store.setWorkspace(go.dataset.go);
            return;
        }
        const act = e.target.closest('[data-act]');
        if (!act) return;
        switch (act.dataset.act) {
            case 'rail': setRail(!railOn); break;
            case 'plans':
                if (railOn) plansMenu(act);
                else setPlansOpen(!plansOpen);
                break;
            case 'add-plan': UI.menu(act, addItems()); break;
            case 'settings': Settings.open(); break;
        }
    });

    document.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'b') return;
        if (e.target.closest('input, textarea, select')) return;
        e.preventDefault();
        setRail(!railOn);
    });

    Store.on((c) => {
        if (c.type === 'tabs' || c.type === 'plan') renderPlans();
        else if (c.type === 'workspace') renderWorkspace();
    });

    setPlansOpen(plansOpen);
    if (railOn) setRail(true);
    renderWorkspace();

    window.Nav = { toggleRail: () => setRail(!railOn) };
}());
