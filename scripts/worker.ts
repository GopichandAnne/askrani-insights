/**
 * Background collection worker. Polls /api/worker/tick, which claims and
 * processes one collection job per call. Run alongside the dev server:
 *
 *   npm run worker
 *
 * Pure HTTP — imports no app code (so it needs no path-alias/build setup). In
 * production this loop is replaced by a scheduled trigger (e.g. Vercel Cron)
 * hitting the same endpoint.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

function loadEnvLocal() {
  try {
    const raw = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) {
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        process.env[m[1]] = v;
      }
    }
  } catch {
    /* rely on ambient env */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  loadEnvLocal();
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const secret = process.env.WORKER_SECRET;
  if (!secret) {
    console.error("Set WORKER_SECRET in .env.local first.");
    process.exit(1);
  }
  const url = `${base}/api/worker/tick`;
  console.log(`local-intel worker → polling ${url}\n(collection jobs are drained here; leave this running)`);

  let idleLogged = false;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "x-worker-secret": secret } });
      const data = (await res.json()) as any;
      if (!res.ok) {
        console.error(`tick ${res.status}: ${data?.error ?? "error"}`);
        await sleep(5000);
        continue;
      }
      if (data.processed) {
        idleLogged = false;
        console.log(
          `✓ ${String(data.businessId).slice(0, 8)} → ${data.status} · ${data.offersWritten ?? 0} offers · ${data.remaining} left`,
        );
        // immediately try the next job
      } else {
        if (!idleLogged) {
          console.log("· queue empty, waiting for work…");
          idleLogged = true;
        }
        await sleep(3000);
      }
    } catch (e) {
      console.error("tick failed (is the dev server running?):", (e as Error).message);
      await sleep(5000);
    }
  }
}

main();
