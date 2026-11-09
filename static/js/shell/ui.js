'use strict';

// ─── ui.js ──────────────────────────────────────────────────────────────────
// Shared UI primitives, all keyboard-operable:
//
//   UI.menu(anchor, items)            dropdown of actions
//   UI.popover(anchor, el, opts)      a small panel of controls by its button
//   UI.picker(point, groups, opts)    searchable list (add or link a module)
//   UI.iconPicker / UI.monthPicker    grids for a module's icon, a month
//   UI.confirm({ title, message })    yes/no dialog → Promise<boolean>
//   UI.toast(message, opts)           transient notice, optional action
//   UI.openModal(el) / closeModal(el) static dialogs: focus trap, Escape, backdrop
//
// Only one menu or picker is open at a time. All text passes through
// escapeHtml or textContent.

(function () {
    let openPop = null;

    function closePop() {
        if (!openPop) return;
        const p = openPop;
        openPop = null;
        p.cleanup();
    }

    /** Fixed-position `el` at (x, y), nudged to stay inside the window. With
     *  `alignRight`, x is where its right edge goes. */
    function place(el, x, y, alignRight = false) {
        const pad = 8;
        const r = el.getBoundingClientRect();
        const want = alignRight ? x - r.width : x;
        const left = Math.max(pad, Math.min(want, window.innerWidth - r.width - pad));
        const top = y + r.height > window.innerHeight - pad
            ? Math.max(pad, y - r.height)
            : y;
        el.style.left = `${Math.round(left)}px`;
        el.style.top = `${Math.round(top)}px`;
    }

    function pointFor(anchor, align) {
        if (!(anchor instanceof Element)) return { x: anchor.x, y: anchor.y, el: null };
        const r = anchor.getBoundingClientRect();
        return { x: align === 'right' ? r.right : r.left, y: r.bottom + 4, el: anchor, alignRight: align === 'right' };
    }

    /** Close the open pop on an outside press, Escape, resize or blur. */
    function guard(el, anchorEl) {
        const onDown = (e) => {
            if (el.contains(e.target) || (anchorEl && anchorEl.contains(e.target))) return;
            closePop();
        };
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closePop();
                if (anchorEl) anchorEl.focus();
            }
        };
        const onBlur = () => closePop();
        // Deferred so the press that opened the pop does not close it.
        setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
        document.addEventListener('keydown', onKey, true);
        window.addEventListener('resize', onBlur);
        window.addEventListener('blur', onBlur);
        return () => {
            document.removeEventListener('pointerdown', onDown, true);
            document.removeEventListener('keydown', onKey, true);
            window.removeEventListener('resize', onBlur);
            window.removeEventListener('blur', onBlur);
        };
    }

    /** Put `el` on the page as the one open pop, at `at` (from pointFor).
     *  `onClose` runs when it closes, however that happens. */
    function showPop(el, at, onClose = null) {
        document.body.appendChild(el);
        place(el, at.x, at.y, at.alignRight);
        const unguard = guard(el, at.el);
        openPop = {
            cleanup() {
                unguard();
                el.remove();
                if (onClose) onClose();
            },
        };
    }

    // ── Menu ───────────────────────────────────────────────────────────────

    /** items: [{ label, icon, onSelect, danger, disabled, chosen }] or 'sep'.
     *  `chosen` marks the current pick of a menu that chooses one. */
    function menu(anchor, items, { align = 'left' } = {}) {
        closePop();
        const at = pointFor(anchor, align);
        const el = document.createElement('div');
        el.className = 'menu-pop';
        el.setAttribute('role', 'menu');
        for (const it of items) {
            if (it === 'sep') {
                const s = document.createElement('div');
                s.className = 'menu-sep';
                el.appendChild(s);
                continue;
            }
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'menu-item';
            b.setAttribute('role', 'menuitem');
            if (it.danger) b.dataset.danger = '';
            if (it.chosen) b.classList.add('is-chosen');
            b.disabled = !!it.disabled;
            b.innerHTML = `${it.icon ? iconSvg(it.icon) : ''}<span>${escapeHtml(it.label)}</span>`;
            b.addEventListener('click', () => {
                closePop();
                if (it.onSelect) it.onSelect();
            });
            el.appendChild(b);
        }
        el.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Tab') return;
            if (e.key === 'Tab') { closePop(); return; }
            e.preventDefault();
            const btns = [...el.querySelectorAll('.menu-item:not(:disabled)')];
            const i = btns.indexOf(document.activeElement);
            const next = e.key === 'ArrowDown' ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
            btns[next].focus();
        });
        showPop(el, at, () => { if (at.el) at.el.setAttribute('aria-expanded', 'false'); });
        if (at.el) at.el.setAttribute('aria-expanded', 'true');
        // Open on the current pick, scrolled into view in a menu that scrolls.
        const first = el.querySelector('.menu-item.is-chosen:not(:disabled)')
            || el.querySelector('.menu-item:not(:disabled)');
        if (first) {
            first.focus({ preventScroll: true });
            if (el.scrollHeight > el.clientHeight) {
                el.scrollTop = first.offsetTop - (el.clientHeight - first.offsetHeight) / 2;
            }
        }
    }

    // ── Popover ────────────────────────────────────────────────────────────

    /** A small panel of controls (`el`, built by the caller) by `anchor`, as
     *  the one open pop: it closes on an outside press, Escape (back to the
     *  anchor), a resize, or another pop opening. Its first control takes the
     *  focus. `onClose` runs when it closes, however that happens. */
    function popover(anchor, el, { align = 'left', onClose = null } = {}) {
        closePop();
        const at = pointFor(anchor, align);
        el.classList.add('panel-pop');
        el.setAttribute('role', 'dialog');
        showPop(el, at, () => {
            if (at.el) at.el.setAttribute('aria-expanded', 'false');
            if (onClose) onClose();
        });
        if (at.el) at.el.setAttribute('aria-expanded', 'true');
        el.querySelector('input, select, button')?.focus({ preventScroll: true });
    }

    // ── Picker ─────────────────────────────────────────────────────────────

    /** groups: [{ label, items: [{ id, label, icon, role, keywords }] }].
     *  Calls onPick(item) or onCancel(). */
    function picker(anchor, groups, { placeholder = 'Search', onPick, onCancel } = {}) {
        closePop();
        const at = pointFor(anchor, 'left');
        const el = document.createElement('div');
        el.className = 'picker';
        el.innerHTML = `
            <label class="picker-search">${iconSvg('magnifying-glass')}
                <input type="text" spellcheck="false" autocomplete="off" aria-label="${escapeHtml(placeholder)}"
                       placeholder="${escapeHtml(placeholder)}">
            </label>
            <div class="picker-list scroll-y" role="listbox"></div>`;
        const input = el.querySelector('input');
        const list = el.querySelector('.picker-list');
        let visible = [];
        let active = 0;
        let picked = false;

        function render() {
            const q = input.value.trim().toLowerCase();
            visible = [];
            let html = '';
            for (const g of groups) {
                const items = g.items.filter((it) => !q
                    || it.label.toLowerCase().includes(q)
                    || (it.keywords || '').toLowerCase().includes(q));
                if (!items.length) continue;
                if (g.label) html += `<div class="picker-group eyebrow">${escapeHtml(g.label)}</div>`;
                for (const it of items) {
                    const i = visible.push(it) - 1;
                    html += `<button type="button" class="picker-item" role="option" data-i="${i}">
                        <span class="role-tile role-tile--sm" data-role="${escapeHtml(it.role || '')}">${iconSvg(it.icon)}</span>
                        <span>${escapeHtml(it.label)}</span></button>`;
                }
            }
            list.innerHTML = html || '<div class="picker-empty">No matches</div>';
            active = Math.min(active, Math.max(0, visible.length - 1));
            mark();
        }

        function mark() {
            list.querySelectorAll('.picker-item').forEach((b) => {
                const on = Number(b.dataset.i) === active;
                b.classList.toggle('is-active', on);
                b.setAttribute('aria-selected', String(on));
                if (on) b.scrollIntoView({ block: 'nearest' });
            });
        }

        function choose(i) {
            const it = visible[i];
            if (!it) return;
            picked = true;
            closePop();
            if (onPick) onPick(it);
        }

        input.addEventListener('input', () => { active = 0; render(); });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(visible.length - 1, active + 1); mark(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
            else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
        });
        list.addEventListener('click', (e) => {
            const b = e.target.closest('.picker-item');
            if (b) choose(Number(b.dataset.i));
        });
        list.addEventListener('pointermove', (e) => {
            const b = e.target.closest('.picker-item');
            if (b && Number(b.dataset.i) !== active) { active = Number(b.dataset.i); mark(); }
        });

        render();
        showPop(el, at, () => { if (!picked && onCancel) onCancel(); });
        input.focus();
    }

    // ── Icon picker ────────────────────────────────────────────────────────

    const ICON_COLUMNS = 6;
    const iconName = (name) => name.replace(/-/g, ' ');

    /** A grid of icons to choose from, drawn in the module's role colour.
     *  `value` is the icon now worn; onPick receives the chosen icon name. */
    function iconPicker(anchor, { icons, value, role = '', onPick } = {}) {
        closePop();
        const at = pointFor(anchor, 'left');
        const el = document.createElement('div');
        el.className = 'icon-pop scroll-y';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Choose an icon');
        el.innerHTML = `<div class="icon-pop-grid" data-role="${escapeHtml(role)}">${icons.map((name) =>
            `<button class="icon-pop-cell" type="button" data-icon="${escapeHtml(name)}" aria-pressed="${name === value}"
                aria-label="${escapeHtml(iconName(name))}" title="${escapeHtml(iconName(name))}">${iconSvg(name)}</button>`).join('')}</div>`;

        el.addEventListener('click', (e) => {
            const cell = e.target.closest('[data-icon]');
            if (!cell) return;
            closePop();
            if (onPick) onPick(cell.dataset.icon);
            if (at.el) at.el.focus();
        });
        el.addEventListener('keydown', (e) => {
            const cell = e.target.closest('[data-icon]');
            const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: ICON_COLUMNS, ArrowUp: -ICON_COLUMNS }[e.key];
            if (!cell || !move) return;
            e.preventDefault();
            const cells = [...el.querySelectorAll('[data-icon]')];
            const next = cells[cells.indexOf(cell) + move];
            if (next) next.focus();
        });

        showPop(el, at);
        (el.querySelector('[aria-pressed="true"]') || el.querySelector('[data-icon]')).focus();
    }

    // ── Month picker ───────────────────────────────────────────────────────

    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    // The grid's width in months (ui.css, .month-pop-grid), as Ant's month panel has.
    const MONTH_COLUMNS = 3;

    /** A year stepper over a grid of months. `value` is 'YYYY-MM' or null;
     *  onPick receives 'YYYY-MM', or null from the clear button. */
    function monthPicker(anchor, { value = null, fallback, onPick, clearLabel = null } = {}) {
        closePop();
        const at = pointFor(anchor, 'left');
        const seed = value || fallback || `${new Date().getFullYear()}-01`;
        let year = Number(seed.slice(0, 4));
        const chosen = value ? { y: Number(value.slice(0, 4)), m: Number(value.slice(5, 7)) } : null;
        const el = document.createElement('div');
        el.className = 'month-pop';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Choose a month');

        function render() {
            el.innerHTML = `
                <div class="month-pop-head">
                    <button class="button-icon" type="button" data-step="-1" aria-label="Previous year">${iconSvg('caret-left')}</button>
                    <span class="month-pop-year">${year}</span>
                    <button class="button-icon" type="button" data-step="1" aria-label="Next year">${iconSvg('caret-right')}</button>
                </div>
                <div class="month-pop-grid">${MONTHS.map((m, i) => {
                    const on = chosen && chosen.y === year && chosen.m === i + 1;
                    return `<button class="month-pop-cell" type="button" data-m="${i + 1}" aria-pressed="${!!on}">${m}</button>`;
                }).join('')}</div>
                ${clearLabel ? `<div class="month-pop-foot"><button class="button-link button-sm month-pop-clear" type="button" data-clear>${escapeHtml(clearLabel)}</button></div>` : ''}`;
        }

        function pick(v) {
            closePop();
            if (onPick) onPick(v);
            if (at.el) at.el.focus();
        }

        el.addEventListener('click', (e) => {
            const step = e.target.closest('[data-step]');
            if (step) {
                year = Math.min(2300, Math.max(1900, year + Number(step.dataset.step)));
                render();
                el.querySelector(`[data-step="${step.dataset.step}"]`).focus();
                return;
            }
            const cell = e.target.closest('[data-m]');
            if (cell) pick(`${year}-${String(cell.dataset.m).padStart(2, '0')}`);
            else if (e.target.closest('[data-clear]')) pick(null);
        });
        el.addEventListener('keydown', (e) => {
            const cell = e.target.closest('[data-m]');
            if (!cell) return;
            const m = Number(cell.dataset.m);
            const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: MONTH_COLUMNS, ArrowUp: -MONTH_COLUMNS }[e.key];
            if (!move) return;
            e.preventDefault();
            const next = m + move;
            if (next >= 1 && next <= 12) el.querySelector(`[data-m="${next}"]`).focus();
        });

        render();
        showPop(el, at);
        const seedMonth = Number(seed.slice(5, 7)) || 1;
        (el.querySelector('[aria-pressed="true"]') || el.querySelector(`[data-m="${seedMonth}"]`)).focus();
    }

    // ── Dialogs ────────────────────────────────────────────────────────────

    const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const openModals = [];

    function openModal(overlay, { initialFocus = null, onClose = null } = {}) {
        const state = { overlay, onClose, returnTo: document.activeElement };
        overlay.hidden = false;
        const onKey = (e) => {
            if (openModals[openModals.length - 1] !== state) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                closeModal(overlay);
            } else if (e.key === 'Tab') {
                const items = [...overlay.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
                if (!items.length) return;
                const first = items[0];
                const last = items[items.length - 1];
                if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
                else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
            }
        };
        const onDown = (e) => { if (e.target === overlay) closeModal(overlay); };
        const onClick = (e) => { if (e.target.closest('[data-close]')) closeModal(overlay); };
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('pointerdown', onDown);
        overlay.addEventListener('click', onClick);
        state.cleanup = () => {
            document.removeEventListener('keydown', onKey);
            overlay.removeEventListener('pointerdown', onDown);
            overlay.removeEventListener('click', onClick);
        };
        openModals.push(state);
        const target = initialFocus || overlay.querySelector(FOCUSABLE);
        if (target) target.focus();
    }

    function closeModal(overlay) {
        const i = openModals.findIndex((s) => s.overlay === overlay);
        if (i < 0) return;
        const [state] = openModals.splice(i, 1);
        state.cleanup();
        overlay.hidden = true;
        if (state.onClose) state.onClose();
        if (state.returnTo && document.contains(state.returnTo)) state.returnTo.focus();
    }

    /** Build a throwaway dialog. `body` is a DOM node; resolves with what
     *  `finish` was called with. `icon` ('warning' | 'danger') puts Modal.confirm's
     *  exclamation beside the title. */
    function dialog({ title, body, actions, icon = null }) {
        return new Promise((resolve) => {
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay';
            overlay.innerHTML = `
                <div class="modal dialog" role="dialog" aria-modal="true">
                    <div class="modal-header"><h2 class="modal-title"></h2>
                        <button class="modal-close" type="button" data-close aria-label="Close">×</button></div>
                    <div class="modal-body"></div>
                    <div class="modal-footer"></div>
                </div>`;
            overlay.querySelector('.modal-title').textContent = title;
            if (icon) {
                overlay.querySelector('.modal-header').insertAdjacentHTML('afterbegin',
                    iconSvg('warning-circle', { cls: `modal-title-icon${icon === 'danger' ? ' is-danger' : ''}` }));
            }
            overlay.querySelector('.modal-body').appendChild(body);
            let result = null;
            const footer = overlay.querySelector('.modal-footer');
            let primary = null;
            for (const a of actions) {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = a.className;
                b.textContent = a.label;
                b.addEventListener('click', () => {
                    result = a.value();
                    closeModal(overlay);
                });
                footer.appendChild(b);
                if (a.primary) primary = b;
            }
            document.body.appendChild(overlay);
            openModal(overlay, {
                initialFocus: body.querySelector('input') || primary,
                onClose() {
                    overlay.remove();
                    resolve(result);
                },
            });
            body.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && e.target.tagName === 'INPUT' && primary) {
                    e.preventDefault();
                    primary.click();
                }
            });
        });
    }

    function confirm({ title, message, confirmLabel = 'Delete', danger = true }) {
        const p = document.createElement('p');
        p.textContent = message;
        return dialog({
            title,
            body: p,
            icon: danger ? 'danger' : 'warning',
            actions: [
                { label: 'Cancel', className: 'button-secondary', value: () => false },
                { label: confirmLabel, className: danger ? 'button-danger button-danger--solid' : 'button-primary', value: () => true, primary: true },
            ],
        }).then((v) => v === true);
    }

    // ── Toast ──────────────────────────────────────────────────────────────

    let toastEl = null;
    let toastTimer = null;

    function toast(message, { type = 'info', action = null, duration = 4500 } = {}) {
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.className = 'toast';
            toastEl.setAttribute('role', 'status');
            document.body.appendChild(toastEl);
        }
        const icon = { error: 'x-circle', success: 'check-circle', warning: 'warning-circle' }[type] || 'info';
        toastEl.dataset.type = type;
        toastEl.innerHTML = `${iconSvg(icon)}<span></span>`;
        toastEl.querySelector('span').textContent = message;
        if (action) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'toast-action';
            b.textContent = action.label;
            b.addEventListener('click', () => {
                hide();
                action.onClick();
            });
            toastEl.appendChild(b);
        }
        requestAnimationFrame(() => toastEl.classList.add('is-visible'));
        clearTimeout(toastTimer);
        toastTimer = setTimeout(hide, duration);
    }

    function hide() {
        if (toastEl) toastEl.classList.remove('is-visible');
    }

    window.UI = { menu, popover, picker, iconPicker, monthPicker, closePop, dialog, confirm, toast, openModal, closeModal };
}());
