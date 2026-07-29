# Supabase setup (do this once)

You do steps 1–5; then run `npm run doctor` to confirm. ~10 minutes.

> **Security:** keep all keys in `.env.local` only (it's git-ignored). Do **not**
> paste the `service_role` key into chat, commits, or the browser — it bypasses
> all row-level security.

## 1. Create the project
1. Go to https://supabase.com → sign in → **New project**.
2. Name it (e.g. `local-intel`), set a strong database password (save it), pick a
   region near you. Wait ~2 min for it to provision.

## 2. Grab the keys
In the project: **Project Settings → API**. Copy three values:
- **Project URL** → `NEXT_PUBLIC_SUPABASE_URL`
- **anon / public** key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- **service_role** key (under "Project API keys", reveal it) → `SUPABASE_SERVICE_ROLE_KEY`

## 3. Fill in `.env.local`
In the project folder:
```bash
cp .env.example .env.local
```
Open `.env.local` and paste the three values above. Optionally add
`ANTHROPIC_API_KEY` now to enable AI extraction (recommended — without it,
extraction is limited to sites that publish structured menu markup).

## 4. Apply the database schema
**Easiest — SQL Editor (no CLI):**
1. Supabase → **SQL Editor** → **New query**.
2. Open `supabase/setup.sql` from this repo, copy its entire contents, paste, **Run**.
3. You should see "Success". (It creates all tables, RLS policies, and starter taxonomy.)

**Alternative — Supabase CLI** (you already use it for Ask Rani):
```bash
supabase link --project-ref <your-new-project-ref>
supabase db push          # applies supabase/migrations/*.sql
# then paste supabase/seed.sql in the SQL Editor, or:
#   supabase db execute --file supabase/seed.sql
```
Use a **different** project ref than Ask Rani — this is a separate database.

## 5. Turn off email confirmation (dev only)
So email+password sign-up logs you straight in:
- Supabase → **Authentication → Sign In / Providers → Email** → turn **off**
  "Confirm email" → Save.
- (Re-enable it before any real launch.)

## 6. Verify
```bash
npm run doctor      # checks keys + that the tables exist
```
Green across "Required" and "Database" means you're set. Then:
```bash
npm run dev
```
- Open http://localhost:3000/login → **Create account** → you're signed in.
- Go to **/onboarding**, enter your restaurant + a few competitor URLs → **Run
  live analysis**. It saves automatically; **/offers**, **/competitors**,
  **/recommendations** and **/feed** now populate from your workspace.
- **/admin** shows which collection adapters and models are active.

## Troubleshooting
- **doctor: "table … does not exist"** → step 4 didn't run; re-paste `setup.sql`.
- **Sign-up says "check your email"** → step 5 (confirm-email) is still on.
- **"Supabase is not configured"** → keys missing/typo in `.env.local`; restart `npm run dev` after editing env.
- **Saved analysis but screens empty** → make sure you're signed in as the same
  user; the screens are RLS-scoped to your organization.
