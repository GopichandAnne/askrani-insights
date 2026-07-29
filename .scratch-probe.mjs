import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const { createClient } = await import("@supabase/supabase-js");
const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);
process.stdout.write("URL=" + process.env.NEXT_PUBLIC_SUPABASE_URL + "\n");
for (const t of ["organization", "business", "offer", "totally_fake_table_zzz"]) {
  const r = await db.from(t).select("id").limit(1);
  process.stdout.write(
    t.padEnd(24) + " -> " + (r.error ? "ERR: " + r.error.message : "ok rows=" + (r.data?.length ?? 0)) + "\n",
  );
}
