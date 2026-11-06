# Aventurine Planner worker: sign-in, billing and access

One Cloudflare Worker serves the whole app and decides who may open it. A
visitor signs in by email link; Paddle tells the worker who has paid; the app's
page and scripts go only to someone with an active subscription.

**Plans reach this server only as ciphertext.** The browser encrypts them with
a key the server never sees (see "The vault" below), so they follow the user
to any device without the server being able to read them. Besides that
ciphertext, the worker knows an email address, whether it has a subscription,
and who is signed in.

## What it does

| Route | Who | Job |
|---|---|---|
| `POST /api/paddle/webhook` | Paddle (signature checked) | Copies customers and subscriptions into the database |
| `POST /api/auth/request` | anyone | Emails a one-time sign-in link, only to emails with access (the access rule below) or with saved plans still kept |
| `POST /api/auth/verify` | anyone with a link | Spends the link, starts a session |
| `POST /api/auth/logout`, `GET /api/me` | signed in | End the session; who am I and what do I have |
| `POST /api/billing/portal` | signed in customers | The link to Paddle's billing page |
| `/api/vault`, `/api/vault/items[/:id]` | active subscription; reading only, signed in without one | The encrypted plans: the wrapped key, pull changes, conditional writes, erase |
| `/auth/login`, `/auth/confirm`, `/auth/inactive`, CSS, fonts, icons | public | The sign-in pages and what they need |
| `/demo`, `/demo/js/*` | public | The free sandbox (one plan, seven modules, one goal) and its copy of the scripts |
| `/api/privacy/*` | an emailed link, not a session | See, download or delete what is held for an address (`PRIVACY.md`) |
| `/auth/privacy` | public | The page behind Delete Me on the website |
| `/export` | public (it asks the vault itself) | The export page: a lapsed subscriber opens their plans with their recovery key and downloads them; runs from `/demo/js/` |
| everything else (`/`, all app JavaScript) | active subscription | The app |

Code map: `src/index.js` (routes and the access rule's enforcement), `paddle.js`
(signature, events), `auth.js` (links and sessions), `access.js` (who
gets in), `vault.js` (encrypted plans and their retention), `privacy.js`
(seeing and deleting an address's data), `store.js` (every
SQL statement), `email.js`, `http.js`, `config.js`, `crypto.js`. Schema:
`migrations/`.

## The vault

The browser makes a random data key, encrypts each plan (and the tab order and
goals) with it, and stores the data key here only encrypted under a **recovery
key** that it shows the user once and never sends. There is no other way in:
a user who loses their recovery key and every signed-in device loses their
plans, and support cannot get them back. Their only option is to erase the
vault and start over.

What the server can see: the email, the item ids (random, e.g. `p_x7k2m9q4`),
how many items there are and their sizes, and when each was written. Not a
plan's name, contents or numbers.

- **Writes are conditional.** Each names the version it replaces; a stale
  one gets `409` and the current value, and the browser decides what to keep.
  Deleting leaves an empty marker so other devices see the deletion.
- **Erasing** (`DELETE /api/vault` with the vault's id) removes everything.
  Re-creating makes a new vault id, so a device still holding the old data key
  gets `409 vault_changed` instead of writing into the new vault with it.
- **Limits:** 512 KiB per item, 16 MiB and 5,000 items per account
  (`LIMITS` in `vault.js`). The app itself allows 15 plans.
- **Retention.** A vault is kept while its owner has access and for 60 days
  after they lose it (counted from their last subscription change or last
  use, whichever is later); resubscribing in that time finds everything. On
  day 45 the daily cron emails the owner that their plans will be deleted and
  how to keep them (`warnLapsedVaults`, once per lapse; a failed send is tried
  the next day), and after day 60 it erases the vault, but never sooner than
  14 days after that email (a vault whose email never goes out is erased 30
  days late instead). If one run would warn or erase more than 20 vaults and
  more than 10% of all of them, it does neither and logs an error instead: that
  points at missing webhooks or a bad deploy, not at real cancellations.
- **Exporting after access ends.** For those 60 days the owner can still
  sign in (the inactive page links to `/export`) and read the vault: the GETs
  answer with `access: false` and `keptUntil`, the day the daily job may
  erase it. Every write is refused (`403 no_subscription`), and reading does
  not count as use, so it never puts the erasing off. The app itself stays
  closed to them.
- **A changed email** (Paddle's `customer.updated`) takes the vault with it.

## Access rule

A subscription grants access while Paddle says `active`, `trialing` or
`past_due` (a failed renewal that Paddle is still retrying: cutting someone off
for an expired card would be unkind). `paused` and `canceled` do not. A
cancellation the customer asks for stays `active` until the paid period ends,
then Paddle sends `canceled` and access stops on the next request. Addresses in
`COMPLIMENTARY_EMAILS` always have access.

## Run it locally

```bash
cp worker/.dev.vars.example worker/.dev.vars    # then edit
npm run build
npx wrangler d1 migrations apply aventurine-prism --local --config worker/wrangler.toml
npm run worker:dev                              # http://127.0.0.1:8787
```

Open exactly `http://127.0.0.1:8787` (the cookie and the Origin check are tied
to the address in `APP_ORIGIN`). With no `RESEND_API_KEY`, the sign-in link is
printed in the wrangler console. Sign in as your `COMPLIMENTARY_EMAILS` address,
or send yourself a signed webhook (see `scripts/smoke-worker.mjs` for how).

`npm run worker:smoke` runs the whole flow against Cloudflare's real local
runtime with a throwaway database. `npm test` covers the same rules without it.

## Set it up for real

Do all of it against Paddle's **sandbox** first; going live is the last section.

### 1. Cloudflare

```bash
npx wrangler login
npx wrangler d1 create aventurine-prism
```

Put the printed `database_id` in `wrangler.toml`, then create the tables:

```bash
npx wrangler d1 migrations apply aventurine-prism --remote --config worker/wrangler.toml
```

### 2. Domain

The worker works on its `*.workers.dev` address straight away: set `APP_ORIGIN`
to that address and skip to step 3. For `app.aventurine-app.com`, the domain's
DNS has to be on Cloudflare (free: add the site, change the nameservers at your
registrar, and recreate any existing records such as the website's). Then
uncomment `routes` in `wrangler.toml`.

`APP_ORIGIN` must be the exact origin people use. Sign-in links, the session
cookie and the same-origin check all depend on it; a request on any other host
is redirected to it.

### 3. Email (Resend)

1. Create a [Resend](https://resend.com) account and add your sending domain. It
   gives you DNS records (SPF, DKIM) to add at your registrar; this does not need
   the domain on Cloudflare.
2. Create an API key limited to sending, then `npx wrangler secret put RESEND_API_KEY --config worker/wrangler.toml`.
3. Set `EMAIL_FROM` in `wrangler.toml` to an address on that domain.

### 4. Paddle (sandbox)

In the sandbox dashboard:

1. **Catalog → Products**: create "Aventurine Planner" with three recurring
   prices: monthly ($7.99), monthly with a 14-day trial, and yearly ($74.99).
   Note the `pri_…` ids; the website's pricing buttons need them.
2. **Developer tools → Authentication → Client-side token**: for Paddle.js on
   the website's pricing page (not a secret).
   **Developer tools → Authentication → API keys**: create one with only
   `customer.read`, `subscription.read` and `subscription.write`, then
   `npx wrangler secret put PADDLE_API_KEY --config worker/wrangler.toml`.
   The worker uses it to cancel a subscription when its owner deletes their
   data, so without it those deletions wait for you (`PRIVACY.md`). A sandbox key
   also needs `PADDLE_API_URL` set to `https://sandbox-api.paddle.com`.
3. **Events → Notifications → New destination** (not under Developer tools):
   - URL: `<APP_ORIGIN>/api/paddle/webhook`
   - Events: `customer.created`, `customer.updated`, and every `subscription.*`
     event (`created`, `activated`, `updated`, `trialing`, `past_due`, `paused`,
     `resumed`, `canceled`).
   - Copy its secret (`pdl_ntfset_…`; later, Events → Notifications → the destination's menu → Edit destination → the copy icon):
     `npx wrangler secret put PADDLE_WEBHOOK_SECRET --config worker/wrangler.toml`
4. **Checkout → Checkout settings**: set the default payment link to the
   website's pricing page (`https://aventurine-app.com/#pricing`) and approve
   the website's domain for checkout.
5. Turn the customer portal on and put its link (`https://…customer-portal.paddle.com/cpl_…`)
   in `PADDLE_PORTAL_URL` in `wrangler.toml`. It is one link for every
   customer: Paddle signs them in by emailing a code, so there is no key to
   expire. Left empty, the billing button says billing is unavailable and
   nothing else changes.

Optionally `npx wrangler secret put COMPLIMENTARY_EMAILS` (comma separated) for
yourself and testers.

### 5. Deploy and test

```bash
npm run worker:deploy
```

Then buy with a Paddle sandbox test card on the website, open
`<APP_ORIGIN>/auth/login`, enter the purchase email, and follow the link. Paddle's
**Developer tools → Simulations** can replay cancellations and failed payments.
To see what the worker stored:

```bash
npx wrangler d1 execute aventurine-prism --remote --config worker/wrangler.toml \
  --command "SELECT c.email, s.status, s.period_end FROM subscriptions s JOIN customers c ON c.id = s.customer_id"
```

### 6. Going live

Paddle's live account is separate: repeat step 4 there (live catalog, live
notification destination, live portal link), re-set `PADDLE_WEBHOOK_SECRET`
and `PADDLE_PORTAL_URL`, use the live client token and price ids on the
website, and deploy again. Buy once with a real card and refund it.

## Things worth knowing

- **Customers who cannot sign in.** The sign-in form only emails addresses
  whose subscription grants access (or that are in `COMPLIMENTARY_EMAILS`), or
  that still have a vault kept after their access ended, so someone who left
  checkout before paying, or whose plans were already erased, gets nothing. If someone says no email arrives: run the query above first (no
  row means Paddle's `customer.created` or `subscription.created` was never
  delivered: see Paddle's notification log; a `canceled` or `paused` status
  means it is working as intended), then Resend's log, then spam.
- **A different email.** Paddle's `customer.updated` event changes the address
  here too; existing sessions are tied to the old address and stop working.
- **Out-of-order events.** Paddle may deliver webhooks in any order or twice.
  Each write only applies if it is newer than what is stored (`store.js`).
- **Sessions** last 30 days and are checked against the database on every
  request, so a cancellation or `logout` takes effect at once. The app that is
  already open in a tab keeps running until it is reloaded, but stops syncing.
- **Deploying the vault or privacy requests** needs their migrations (0002 to
  0004) applied first:
  `npx wrangler d1 migrations apply aventurine-prism --remote --config worker/wrangler.toml`.
- **Rotating a secret.** Paddle lets two webhook secrets overlap; the worker
  accepts a request if any signature matches. Roll the secret in Paddle, then
  `wrangler secret put PADDLE_WEBHOOK_SECRET`.
- **Rate limits.** Sign-in requests: 10 per minute per IP (the `RATE_LIMIT`
  binding), and at most 3 links per email per 15 minutes. Privacy requests: 10
  per minute per IP, and at most 3 links per email per day.
