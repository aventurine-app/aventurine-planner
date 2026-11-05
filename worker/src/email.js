// ─── email.js ───────────────────────────────────────────────────────────────
// Sends email through Resend's HTTP API: the sign-in link, and the warning
// that a lapsed account's plans are about to be deleted. Isolated here so
// changing provider means changing this file only.

const SUBJECT = 'Your Aventurine Planner sign-in link';

export class EmailError extends Error {}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The message body. `link` is built by us from APP_ORIGIN and a random token. */
export function loginMessage(link, minutes) {
    const text = `Open this link to sign in to Aventurine Planner:\n\n${link}\n\n`
        + `It works once and expires in ${minutes} minutes. If you did not ask for it, you can ignore this email.`;
    const html = `<p>Open this link to sign in to Aventurine Planner:</p>`
        + `<p><a href="${escapeHtml(link)}">Sign in to Aventurine Planner</a></p>`
        + `<p>It works once and expires in ${minutes} minutes. If you did not ask for it, you can ignore this email.</p>`;
    return { subject: SUBJECT, text, html };
}

/** A date as people read it, in UTC (the day the daily job runs on): 'January 4, 2027'. */
const longDate = (ms) => new Date(ms).toLocaleDateString('en-US', { dateStyle: 'long', timeZone: 'UTC' });

/**
 * The warning before a lapsed account's plans are deleted. `loginUrl` and
 * `pricingUrl` are ours, never from a request.
 */
export function deletionWarningMessage({ deleteOn, loginUrl, pricingUrl }) {
    const day = longDate(deleteOn);
    const subject = `Your Aventurine Planner plans will be deleted on ${day}`;
    const text = `Your Aventurine Planner subscription has ended. Your plans are still saved in your account, encrypted, `
        + `until ${day}. After that they are deleted for good, and nobody can get them back, including us.\n\n`
        + `To keep them, you can:\n\n`
        + `- Subscribe again, and find everything as you left it:\n  ${pricingUrl}\n\n`
        + `- Or export them. Sign in at ${loginUrl}, choose Export your plans, and enter your recovery key. `
        + `You can download every plan as a PDF report, a spreadsheet or a plan file.\n\n`
        + `If you do nothing, your plans are deleted on ${day}. This is the only reminder we send.`;
    const html = `<p>Your Aventurine Planner subscription has ended. Your plans are still saved in your account, encrypted, `
        + `until <strong>${escapeHtml(day)}</strong>. After that they are deleted for good, and nobody can get them back, including us.</p>`
        + `<p>To keep them, you can:</p><ul>`
        + `<li><a href="${escapeHtml(pricingUrl)}">Subscribe again</a>, and find everything as you left it.</li>`
        + `<li>Or export them. <a href="${escapeHtml(loginUrl)}">Sign in</a>, choose Export your plans, and enter your recovery key. `
        + `You can download every plan as a PDF report, a spreadsheet or a plan file.</li></ul>`
        + `<p>If you do nothing, your plans are deleted on ${escapeHtml(day)}. This is the only reminder we send.</p>`;
    return { subject, text, html };
}

/** Send `message` ({ subject, text, html }) to `to`. Throws EmailError if it was not accepted. */
export async function sendEmail({ apiKey, from, to, message, fetchImpl = fetch }) {
    if (!apiKey || !from) throw new EmailError('email is not configured');
    const response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to: [to], ...message }),
        signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new EmailError(`the email service answered ${response.status}`);
}

export function sendLoginEmail({ apiKey, from, to, link, minutes, fetchImpl = fetch }) {
    return sendEmail({ apiKey, from, to, message: loginMessage(link, minutes), fetchImpl });
}
