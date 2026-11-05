'use strict';

// ─── backend.js ─────────────────────────────────────────────────────────────
// The URL map for the browser backend. The app calls api('GET', '/api/plans')
// as it always did; this module routes that to the workspace and answers
// { status, body }, so no call site knows the data now lives in the browser.
//
// Dispatch contract (what static/js/core/api.js relies on):
//   dispatch(method, url, body) -> Promise<{ status, body }>
//   - a handler returns a body object              -> 200
//   - a handler throws ApiError(message, status)   -> { ok: false, error, ...extra }
//   - no route                                     -> 404
//
// Bodies are copied on the way in and out (structuredClone), as a network call
// would. The workspace therefore never shares an object with the page, and an
// edit the page makes to its own copy cannot reach stored data unsaved.
//
// `files` is { save({ name, text | data, kind }) -> Promise<boolean>, open() -> Promise<string|null> }
// (file-dialogs.js). Both resolve false/null when the user cancels. `kind` is
// 'plan', 'csv' or 'zip'; `data` is bytes (the zip).
//
// Dual-environment: window.PrismWeb.createBackend in the page, CommonJS for tests.

(function (root, factory) {
    const isNode = typeof module === 'object' && module.exports;
    const web = isNode
        ? { ...require('./api-error.js'), ...require('./plan-files.js'), ...require('./exports.js') }
        : root.PrismWeb;
    const api = factory(web.ApiError, web.PlanFiles, web.Exports);
    if (isNode) module.exports = api;
    else root.PrismWeb = Object.assign(root.PrismWeb || {}, api);
}(typeof self !== 'undefined' ? self : this, function (ApiError, PlanFiles, Exports) {

    function planBody(body) {
        if (!body || typeof body !== 'object' || !body.plan) throw new ApiError('plan required', 400);
        return body.plan;
    }

    /** A pattern like '/api/plans/<id>' as { regex, names }. A param is one path segment. */
    function compile(pattern) {
        const names = [];
        const source = pattern.split('/').map((seg) => {
            const m = /^<([A-Za-z_]\w*)>$/.exec(seg);
            if (!m) return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            names.push(m[1]);
            return '([^/]+)';
        }).join('/');
        return { regex: new RegExp(`^${source}$`), names };
    }

    function createBackend({ workspace, files, clone = structuredClone, logger = console }) {
        // The file is made before the dialog opens: the dialog needs the
        // click that asked for it, so nothing may be awaited first.
        const EXPORTS = {
            json: (plan) => ({ name: PlanFiles.fileName(plan.name), text: PlanFiles.serialize(plan), kind: 'plan' }),
            csv: (plan) => ({ name: PlanFiles.fileName(plan.name, 'csv'), text: Exports.planCsv(plan, { logger }), kind: 'csv' }),
        };

        async function exportPlan({ params, body }) {
            const format = (body && body.format) || 'json';
            if (!Object.hasOwn(EXPORTS, format)) throw new ApiError('unknown export format', 400);
            const saved = await files.save(EXPORTS[format](workspace.getPlan(params.id)));
            return saved ? { saved: true } : { canceled: true };
        }

        /** "Download All": every plan, in navigation order, and the goals, as a zip. */
        async function exportAll() {
            const plans = workspace.listPlans().order.map((id) => workspace.getPlan(id));
            const { goals } = workspace.getGoals();
            const saved = await files.save({ name: Exports.archiveName(), data: Exports.archive({ plans, goals }, { logger }), kind: 'zip' });
            return saved ? { saved: true } : { canceled: true };
        }

        /** A one-plan file answers { plan }; an every-plan file { plans, goals }. */
        async function importPlan() {
            const text = await files.open();
            if (text == null) return { canceled: true };
            const contents = PlanFiles.read(text);
            if (contents.plans.length === 1 && contents.goals == null) {
                return { plan: await workspace.importPlan(contents.plans[0]) };
            }
            return workspace.importPlans(contents);
        }

        // Literal segments ('/api/plans/import', '/api/plans/order') are listed
        // before the '<id>' patterns beside them.
        const routes = [
            ['GET',    '/api/status',             () => workspace.status()],
            ['GET',    '/api/plans',              () => workspace.listPlans()],
            ['POST',   '/api/plans',              async ({ body }) => ({ plan: await workspace.addPlan(planBody(body)) })],
            ['POST',   '/api/plans/import',       importPlan],
            ['PUT',    '/api/plans/order',        ({ body }) => workspace.setTabs(body || {})],
            ['GET',    '/api/plans/<id>',         ({ params }) => ({ plan: workspace.getPlan(params.id) })],
            ['PUT',    '/api/plans/<id>',         ({ params, body }) => workspace.putPlan(params.id, planBody(body))],
            ['DELETE', '/api/plans/<id>',         ({ params }) => workspace.deletePlan(params.id)],
            ['POST',   '/api/plans/<id>/export',  exportPlan],
            ['POST',   '/api/export',             exportAll],
            ['GET',    '/api/goals',              () => workspace.getGoals()],
            ['PUT',    '/api/goals',              ({ body }) => workspace.putGoals(body ? body.goals : undefined)],
        ].map(([method, pattern, handler]) => ({ method, handler, ...compile(pattern) }));

        // No await before a handler runs: a file picker needs the click that
        // asked for it, and a save made while the page closes must start now.
        async function dispatch(method, url, body) {
            const q = url.indexOf('?');
            const path = q === -1 ? url : url.slice(0, q);
            for (const r of routes) {
                if (r.method !== method) continue;
                const m = r.regex.exec(path);
                if (!m) continue;
                try {
                    const params = {};
                    r.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
                    const result = await r.handler({ params, body: body == null ? null : clone(body) });
                    return { status: 200, body: clone(result) };
                } catch (e) {
                    if (e instanceof ApiError) {
                        return { status: e.status, body: { ok: false, error: e.message, ...(e.extra || {}) } };
                    }
                    if (e instanceof URIError) return { status: 400, body: { ok: false, error: 'bad request' } };
                    logger.error(`[backend] ${method} ${path} failed:`, e);
                    return { status: 500, body: { ok: false, error: 'internal error' } };
                }
            }
            return { status: 404, body: { ok: false, error: 'not found' } };
        }

        return { dispatch };
    }

    return { createBackend };
}));
