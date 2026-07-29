/**
 * Setup doctor — verifies your Supabase + keys are wired correctly.
 * Run: npm run doctor
 *
 * Loads .env.local manually (tsx doesn't auto-load it), checks required keys,
 * connects with the service-role key, and confirms the schema is applied by
 * probing a few canonical tables. Prints a checklist — no data is written.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function loadEnvLocal() {
  try {
    const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = val;
    }
  } catch {
    console.error("⚠  No .env.local found. Copy .env.example → .env.local and fill it in.");
  }
}

const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);
const info = (m: string) => console.log(`  · ${m}`);

async function main() {
  loadEnvLocal();
  let problems = 0;

  console.log("\nRequired — Supabase");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;
  url ? ok("NEXT_PUBLIC_SUPABASE_URL set") : (bad("NEXT_PUBLIC_SUPABASE_URL missing"), problems++);
  anon ? ok("NEXT_PUBLIC_SUPABASE_ANON_KEY set") : (bad("NEXT_PUBLIC_SUPABASE_ANON_KEY missing"), problems++);
  service ? ok("SUPABASE_SERVICE_ROLE_KEY set") : (bad("SUPABASE_SERVICE_ROLE_KEY missing"), problems++);

  if (url && service) {
    console.log("\nDatabase — schema applied?");
    const { createClient } = await import("@supabase/supabase-js");
    const db = createClient(url, service, { auth: { persistSession: false } });
    const tables = ["organization", "workspace", "business", "offer", "recommendation", "competitor_edge"];
    for (const t of tables) {
      // Use a real row select (not a HEAD count) — HEAD requests don't reliably
      // surface PostgREST's "table not in schema cache" error, which gives false
      // positives when the schema hasn't been applied.
      const { error } = await db.from(t).select("id").limit(1);
      if (error) {
        bad(`table "${t}" — ${error.message}`);
        problems++;
      } else {
        ok(`table "${t}" exists`);
      }
    }
    if (problems > 0) {
      info('→ Run supabase/setup.sql in the Supabase SQL Editor to create the schema.');
    }
  } else {
    info("skipping DB probe until Supabase keys are set");
  }

  console.log("\nAI extraction (optional but recommended)");
  process.env.ANTHROPIC_API_KEY
    ? ok("ANTHROPIC_API_KEY set (Claude extraction enabled)")
    : process.env.OPENAI_API_KEY
      ? ok("OPENAI_API_KEY set (OpenAI extraction enabled)")
      : info("no LLM key — extraction runs in structured-markup-only mode");

  console.log("\nCollection adapters (optional)");
  info(`Google Places: ${process.env.GOOGLE_MAPS_API_KEY ? "enabled" : "off"}`);
  info(`Apify social:  ${process.env.APIFY_TOKEN ? "enabled" : "off"}`);
  info(`Bright Data:   ${process.env.BRIGHTDATA_API_TOKEN ? "enabled" : "off"}`);

  console.log(
    problems === 0
      ? "\n✅ All required checks passed. Run `npm run dev` and sign in at /login.\n"
      : `\n❌ ${problems} problem(s) above. Fix them, then re-run: npm run doctor\n`,
  );
  process.exit(problems === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
