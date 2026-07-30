# Deploy — Ask Rani Insights → insights.askrani.ai

Ships on **Vercel** (Next.js) + your existing **Supabase** project. ~20 minutes.
The background collection worker runs as a **Vercel Cron** in production (no
separate process — the local `npm run worker` is only for dev).

## 1. Push to GitHub (your side)
1. Create an empty repo on GitHub (private), e.g. `askrani-insights`. Don't add a README.
2. In the `local-intel` folder:
   ```bash
   git remote add origin https://github.com/<you>/askrani-insights.git
   git push -u origin main
   ```
   (`.env.local` is git-ignored, so no secrets are pushed.)

## 2. Import into Vercel
1. vercel.com → **Add New → Project** → import the GitHub repo.
2. Framework preset: **Next.js** (auto-detected). Leave build/output defaults.
3. Don't deploy yet — set env vars first (next step).

## 3. Environment variables (Vercel → Project → Settings → Environment Variables)
Add these for **Production** (and Preview if you want previews to work):

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | from Supabase → Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key (server-only) |
| `ANTHROPIC_API_KEY` | your Claude key |
| `NEXT_PUBLIC_APP_URL` | `https://insights.askrani.ai` |
| `WORKER_SECRET` | any long random string |
| `CRON_SECRET` | any long random string (Vercel sends it to the cron) |
| `SUPERADMIN_EMAILS` | your email(s), comma-separated |
| *(optional)* `GOOGLE_MAPS_API_KEY`, `YELP_API_KEY`, `YOUTUBE_API_KEY`, `APIFY_TOKEN`, `APIFY_*_ACTOR` | activate those sources |

Then **Deploy**.

## 4. Custom domain — insights.askrani.ai
1. Vercel → Project → **Settings → Domains** → add `insights.askrani.ai`.
2. In your DNS (where askrani.ai is managed), add the **CNAME** Vercel shows
   (usually `cname.vercel-dns.com`) for the `insights` subdomain.
3. Once it verifies, set `NEXT_PUBLIC_APP_URL=https://insights.askrani.ai` (redeploy if you changed it).
4. From your product site, link/redirect the "Insights" product to
   `https://insights.askrani.ai` (same pattern as `app.askrani.ai`).

## 5. Supabase for production
- Use the **same** migrations: run `supabase/setup.sql` on the production project
  (or `supabase/apply_0003.sql` if it already has the earlier ones).
- **Auth → URL Configuration**: set Site URL to `https://insights.askrani.ai` and
  add it to Redirect URLs. Re-enable "Confirm email" for production.

## 6. The background worker (automatic)
`vercel.json` registers a cron hitting `/api/worker/tick` every 5 minutes; each
tick drains a batch of collection jobs. Authenticated by `CRON_SECRET`.
- **Plan note:** frequent crons + the 300s function duration need **Vercel Pro**.
  On Hobby, crons run **once/day** and functions cap at **60s** — fine to trial,
  but collection will be slow. For real use, Pro.

## Caveats (known, by design)
- **Playwright rendering** (JS-only sites) is **disabled on Vercel** — serverless
  has no installed Chrome, so the crawler falls back to static (graceful). To
  enable it in prod later, add `@sparticuz/chromium` and branch the launcher in
  `src/lib/providers/website/render.ts`. Local dev uses your installed Chrome.
- **Long collection** runs as many short cron-driven ticks, not one long job —
  robust for serverless, but a business appears in the feed a few minutes after
  it's queued rather than instantly.
- Keep `service_role` and secrets in Vercel env only — never in the repo.
