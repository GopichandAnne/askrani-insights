# Spec — Shareable Report Link → Claim → Trial (Insights launch GTM)

Status: proposed (not built). Owner: annen315. Scope: Insights (`local-intel`) only — Rani/`askrani-app` untouched. Drafted 2026-09-18.

## 1. Why
The report is our lead magnet. Today it only lives behind app login or as a one-off preview, so a cold prospect can't feel the value before signing up. This feature turns any workspace's market read into a **public, personalized web page** we can send, which converts to a **claimed, self-owned account** with a **15-day free trial** — zero setup, because the workspace is pre-provisioned.

Guiding principle: **show value before asking for anything.** The static read is fully free and public; login unlocks only the *living* layer.

## 2. The experience (target flow)
1. **Send** — we email the prospect a link: `insights.askrani.ai/r/<token>`.
2. **Read (no login)** — a personalized, mobile-first report page: their name, their standings, rivals' prices, price-moves, the one move. Reads as "a report about *them*," not a marketing site. 100% of the static read is free.
3. **Pull** — the *living* layer is teased with locks: "🔒 Get alerted when a rival cuts a price," "🔒 Watch this update weekly," "🔒 See what changed." Each is a **Claim your dashboard →** CTA.
4. **Claim** — passwordless login (choice of phone / email / Google, **phone pushed first**). On success the token **binds/transfers the workspace to their new account**.
5. **Land** — they arrive *inside* the Insights app on their live dashboard, **already populated** with their store + 5 rivals + the full read. No setup wizard, no empty state. 15-day trial starts now.
6. **Phone capture** — regardless of login method, we capture phone during onboarding (reuses the existing `/welcome` gate), framed as *"Where should we text your price-cut & weekly alerts?"* — a benefit, not a toll.

## 3. Decisions (locked)
- **Pre-provisioned, independent page** per business (Patel Brothers gets its own token now).
- **Claim = transfer**: the workspace currently under our `Manpasand` org transfers to the claimer's new org on first claim.
- **15-day free trial**, **clock starts on claim** (not on send).
- **Day 15 → drop to the free plan** (still sees weekly report + standings); upgrade prompts live on the gated living bits. Not a hard paywall.
- **Channel for Patel:** email, direct.
- **Login:** user's choice; **phone-first** in the UI; **phone captured regardless**.
- **Static report always free/public**; the 15 days gates the *living dashboard* only.

## 4. Architecture

### 4.1 Token + page
- New route `app/r/[token]/page.tsx` — **public SSR**, no auth. Must be exempt in `middleware.ts` (add `/r` to the public-path list alongside `/explore`, `/login`, `/auth`, `/api`, `/welcome`).
- Reuses the existing report renderer (`reportpdf.tsx` section builders / `buildReportSections`) so the web page and PDF stay in sync. Render as HTML (not the PDF) for the page.
- Token → workspace lookup via a new table (below). Unguessable (≥128-bit random, URL-safe). Returns 404 for unknown/revoked/expired tokens.
- SEO: `noindex` (personalized, not for search); OpenGraph tags so the link preview in email/WhatsApp shows the business name + "Your market read."

### 4.2 Data model (new migration, next number in sequence)
```
report_share
  id            uuid pk
  token         text unique not null        -- URL-safe random
  workspace_id  uuid not null → workspace(id)
  created_by    uuid                         -- our admin
  status        text not null default 'active'  -- active | revoked
  claimed_by    uuid                         -- auth.users id, set on claim
  claimed_at    timestamptz
  view_count    int default 0
  created_at    timestamptz default now()
  expires_at    timestamptz                  -- optional link expiry (nullable)
```
Trial fields on the workspace's org (reuse existing trial concept — `TRIAL_CREDITS` already exists in `credits.ts`):
```
organization
  trial_started_at   timestamptz            -- set on claim
  trial_ends_at      timestamptz            -- claim + 15d
  plan               -- 'trialing' during window, then 'free' at day 15
```
(If a trial state already exists, extend it rather than duplicate.)

### 4.3 Claim / transfer
- On the report page, "Claim" carries the token into the login flow: `/login?claim=<token>&mode=signup` (the `?mode=signup` deep-link already opens the register tab).
- After auth completes (any method), a claim handler (server action or `/api/claim`):
  1. Validates the token is `active`, unclaimed, not expired.
  2. Creates the user's org (or uses the one just bootstrapped in `/welcome`).
  3. **Transfers the workspace**: set `workspace.organization_id` = new org; move `target_business_id`/competitor rows as needed (they're business-scoped, so mostly a workspace re-parent). Verify RLS now scopes it to the new owner.
  4. Sets `report_share.claimed_by/claimed_at`, `status` stays active (link still works for them).
  5. Starts the trial: `trial_started_at = now()`, `trial_ends_at = now()+15d`, plan → `trialing`.
- **Idempotent**: a second claim of an already-claimed token by the same user is a no-op; by a different user → deny (or issue a fresh workspace — decide later; default: deny, show "already claimed").

### 4.4 Trial enforcement
- A `trialing` org gets full living-dashboard access (alerts, weekly refresh, act-on-it) for 15 days.
- A daily job (reuse `scheduler/tick`) flips expired trials → `free`.
- Free plan keeps the static report + standings; gated bits show upgrade prompts (reuse `/billing`).

### 4.5 Phone capture
- No new build — the existing `/welcome` phone-capture gate already catches email/Google signups (the "phone on every account" mechanic). Only change: **copy** on that step for claim-origin users → alert-benefit framing.

## 5. Sending (Patel Brothers, now)
- Generate one `report_share` row for workspace `6d4ac992` → get token → email the link directly.
- Email: short, personal, from a real person; subject names their store; body = one-line hook + the link. No mass send (warm, single recipient — avoids spam/legal issues).
- (Future: in-person **QR** to the same `/r/<token>` for walk-in pitches.)

## 6. Instrumentation (funnel)
Log first-party events (reuse `analytics.logEvent`): `report_link_viewed` (token), `report_claim_clicked`, `report_claim_completed` (method: phone/email/google), `trial_started`, `trial_expired`, `upgraded`. This is the launch conversion funnel.

## 7. Security / privacy
- Token unguessable + revocable (`status='revoked'`) + optional `expires_at`.
- Page shows only public info (their public rating/reviews, rivals' public promoted prices) — **no PII, no owner-private data** pre-claim.
- Post-claim data access is RLS-scoped to the new org (verify the transfer re-scopes correctly).
- Rate-limit the public route; count views.

## 8. Out of scope (this pass)
- Rani / `app.askrani.ai` anything.
- Self-serve "generate a share link for any of my workspaces" UI (admin-generated for now).
- Multi-recipient / campaign sending, QR generation (later).
- Payment collection at claim (trial is card-optional; upgrade happens later via existing Stripe).

## 9. Build plan (phased)
- **P0 — the page:** `app/r/[token]` public SSR + `report_share` table + admin script to mint a token. Ship = a working public link for Patel. (No claim yet — validates the read/render.)
- **P1 — claim + trial:** `/login?claim=` binding, `/api/claim` transfer, trial start/expiry, `/welcome` copy. Ship = end-to-end send→claim→dashboard.
- **P2 — polish:** funnel events, revoke/expiry, OG preview, upgrade prompts on gated bits.
- **P3 (later):** self-serve link generation, QR, campaign send.

## 10. Open questions
- Second-user claim of a claimed token: deny vs. fork a fresh workspace? (default: deny.)
- Trial requires a card up front? (default: no — card-optional, upgrade later.)
- Does `trialing` unlock *growth*-tier breadth or *starter*? (default: starter-equivalent, 1 business = their own; they can add more on upgrade.)
