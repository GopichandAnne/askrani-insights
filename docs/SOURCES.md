# Full-scan setup — turn on every data source

Every source is an **adapter that self-activates when its key is present**. Nothing
else to code: add the env var(s) in Vercel → redeploy → the source starts feeding
collection automatically. Check live status any time at **/admin** (super-admin).

## The complete source list

| Source | What it adds | Env var(s) | Where to get it | Cost | Notes |
|---|---|---|---|---|---|
| **Website / menus / PDFs** | Menus, offers, prices, business facts | — | built-in | free | Always on |
| **OpenStreetMap** | Business search + nearby competitors | — | built-in | free | Always on |
| **Claude (AI extraction)** | Turns text/flyers/images into structured offers | `ANTHROPIC_API_KEY` | console.anthropic.com | usage | Already set |
| **Yelp** | Reviews + ratings | `YELP_API_KEY` | yelp.com/developers | **free** | Official API — easiest first |
| **YouTube** | Channel videos, titles, descriptions | `YOUTUBE_API_KEY` | Google Cloud → YouTube Data API v3 | **free** quota | Official API |
| **Google Places** | Better discovery + **reviews & photos** | `GOOGLE_MAPS_API_KEY` | Google Cloud → Places API (New) | needs **GCP billing** (~$200/mo free credit) | Official API |
| **Instagram** | Public posts (offers from captions) | `APIFY_TOKEN` | apify.com | paid (~$2.70/1k) | Against IG ToS — your call |
| **Facebook** | Public page posts | `APIFY_TOKEN` (+ `APIFY_FACEBOOK_ACTOR`) | apify.com | paid | Against FB ToS |
| **TikTok** | Public profile posts (captions) | `APIFY_TOKEN` (+ `APIFY_TIKTOK_ACTOR`) | apify.com | paid | Against TikTok ToS; video text only |
| **DoorDash / UberEats** | Delivery menus + live prices | `APIFY_TOKEN` + `APIFY_DOORDASH_ACTOR` / `APIFY_UBEREATS_ACTOR` | apify.com (choose an actor) | paid | Against their ToS; **verify the actor's output** |
| **Bright Data** | Enterprise bulk / historical datasets | `BRIGHTDATA_API_TOKEN` | brightdata.com | enterprise contract | Skeleton — delivery parser wired per contract |
| **Meta (owner-authorized)** | *Your own* IG/FB private metrics + publishing | `META_APP_ID` / `META_APP_SECRET` | developers.facebook.com | app review (weeks) | **Deferred** by decision |
| **Google Business Profile (owner)** | *Your own* GBP reviews/posts/insights | `GOOGLE_OAUTH_CLIENT_ID` / `_SECRET` | Google Cloud (approved project) | free, approval | OAuth workstream |

## One-shot flow (add all at once)

1. **Collect the keys** you want (start with the free ones: Yelp, YouTube; add
   Google + Apify for full coverage).
2. **Vercel → askrani-insights → Settings → Environment Variables → Production** —
   paste each variable (values from the providers above). Add all of them in one
   sitting.
3. **Redeploy** (I can run this for you, or a push triggers it).
4. **/admin** now shows every source you keyed as **configured / ok**.
5. New collections automatically fan out across all active sources; existing
   businesses pick them up on the next scan.

Copy-ready block for `.env` (fill what you want; blanks stay off):

```
ANTHROPIC_API_KEY=            # already set
YELP_API_KEY=                 # free
YOUTUBE_API_KEY=              # free
GOOGLE_MAPS_API_KEY=          # needs GCP billing
APIFY_TOKEN=                  # paid — unlocks IG/FB/TikTok/delivery
APIFY_FACEBOOK_ACTOR=apify~facebook-posts-scraper
APIFY_TIKTOK_ACTOR=clockworks~tiktok-scraper
APIFY_DOORDASH_ACTOR=         # pick a working Apify actor id
APIFY_UBEREATS_ACTOR=         # pick a working Apify actor id
BRIGHTDATA_API_TOKEN=         # enterprise
```

## Honest limits (not blockers, but know them)

- **Video is text-only today.** TikTok/YouTube give titles/captions/descriptions;
  extracting offers from the *video frames/audio* (guide §6.2) isn't built yet.
- **Playwright rendering is off on Vercel serverless** (no installed browser) — JS-only
  sites fall back to static. Enable later with `@sparticuz/chromium`.
- **Social + delivery scraping is against those platforms' ToS.** The adapters stay
  **off until you add the key**, and there's no detection-evasion. Get counsel
  comfortable before turning them on at scale (the guide flags this too).
- **Delivery actors vary** — after setting `APIFY_DOORDASH_ACTOR` etc., we should
  verify that actor's output maps cleanly (I'll check it live once keyed).
- **Rough cost** at ~100 monitored businesses (guide §16.1): social $200–1,000/mo,
  AI $200–1,000, website/crawl $100–400 — the app records real per-run cost in
  `provider_run`, visible in /admin.
