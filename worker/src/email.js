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

/** The link that proves someone owns an address, so they can see or delete its data. */
export function privacyLinkMessage(link, minutes) {
    const lead = 'Someone asked to see or delete the data Aventurine holds for this email address.';
    const foot = `The link expires in ${minutes} minutes. Nothing has changed yet, and nothing is deleted until you confirm it. `
        + 'If you did not ask for this, you can ignore this email.';
    return {
        subject: 'Your Aventurine privacy request',
        text: `${lead} Open this link to continue:\n\n${link}\n\n${foot}`,
        html: `<p>${lead}</p><p><a href="${escapeHtml(link)}">See or delete your data</a></p><p>${foot}</p>`,
    };
}

export const PADDLE_DELETION_URL = 'https://preferences.paddle.com/form/deletion';

/** The confirmation that a deletion finished. The last email sent to this address. */
export function erasureReceiptMessage() {
    const lead = 'We have deleted your Aventurine Planner data: your encrypted plans, your email address, '
        + 'your subscription record and your sign-in records. Any subscription is cancelled, so you will not be charged again.';
    const support = 'If you have emailed us or bought from us before, we will find and delete those records within 30 days, '
        + 'keeping only what the law requires.';
    const backups = 'Copies in our providers\' backups and email logs expire on their own within 30 days.';
    const paddle = 'Paddle, which took your payments, keeps its own records and decides on its own what to delete. '
        + 'To ask it to delete yours, use its form:';
    const foot = 'This is the last email we will send you.';
    return {
        subject: 'Your Aventurine data has been deleted',
        text: `${lead}\n\n${support}\n\n${backups}\n\n${paddle}\n${PADDLE_DELETION_URL}\n\n${foot}`,
        html: `<p>${lead}</p><p>${support}</p><p>${backups}</p>`
            + `<p>${paddle} <a href="${PADDLE_DELETION_URL}">${PADDLE_DELETION_URL}</a></p><p>${foot}</p>`,
    };
}

/**
 * The owner's checklist for one deletion: the steps no code can do. Sent before
 * the address is erased, and it is the only place the address survives, so
 * PRIVACY.md ends by deleting this email. Plain text, read only by the owner.
 */
export function erasureOpsMessage({ email, requestedAt, dueBy, cancelled, stuck, complimentary }) {
    const billing = stuck.length
        ? `NOT FINISHED. Cancel ${stuck.join(', ')} in the Paddle dashboard. Nothing is deleted until that is done; `
            + 'the worker retries daily and finishes by itself, and this email repeats until then.'
        : `${cancelled} subscription(s) cancelled. Nothing further to do in Paddle.`;
    const steps = [
        'Support inbox: search for the address and delete what you find.',
        complimentary
            ? 'COMPLIMENTARY_EMAILS: this address is on the list. Remove it with wrangler secret put.'
            : null,
        'Delete this email, including from Sent and Trash.',
    ].filter(Boolean).map((step, i) => `${i + 1}. ${step}`).join('\n');
    return {
        subject: `Privacy: finish deleting ${email} by ${longDate(dueBy)}`,
        text: `A deletion was confirmed on ${longDate(requestedAt)}. Finish the steps below by ${longDate(dueBy)}.\n\n`
            + `Address: ${email}\nBilling: ${billing}\n\n${steps}\n\nDetails are in worker/PRIVACY.md in the planner repo.`,
    };
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
