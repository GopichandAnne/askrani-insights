/**
 * Playwright rendering fallback — guide 5.4 step 5: "Use Playwright only when
 * meaningful content requires JavaScript rendering." Observations sourced this
 * way are tagged PUBLIC_WEBSITE_BROWSER.
 *
 * Design choices to stay lean and robust:
 *  • playwright-core (no bundled browser) driving your INSTALLED Chrome/Edge via
 *    `channel` — no 130MB download.
 *  • Dynamic import + graceful null on any failure, so a machine without a
 *    usable browser simply falls back to static crawling (never crashes).
 *  • A single shared browser instance, launched lazily and reused across pages.
 *
 * For serverless deploy later, swap the launcher for @sparticuz/chromium.
 */

let browserPromise: Promise<any | null> | null = null;

async function getBrowser(): Promise<any | null> {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    let chromium: any;
    try {
      ({ chromium } = await import("playwright-core"));
    } catch {
      return null; // playwright-core not installed
    }
    // Prefer installed browsers by channel (no download needed).
    for (const channel of ["chrome", "msedge", "chromium"] as const) {
      try {
        return await chromium.launch({ channel, headless: true });
      } catch {
        /* try next channel */
      }
    }
    try {
      return await chromium.launch({ headless: true }); // bundled, if present
    } catch {
      return null; // no usable browser — caller falls back to static
    }
  })();
  return browserPromise;
}

export function isRenderAvailable(): Promise<boolean> {
  return getBrowser().then((b) => !!b);
}

export async function closeBrowser(): Promise<void> {
  const b = await browserPromise?.catch(() => null);
  if (b) {
    try {
      await b.close();
    } catch {
      /* ignore */
    }
  }
  browserPromise = null;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 local-intel-bot";

/**
 * Render a URL and return its fully-hydrated HTML, or null if rendering isn't
 * possible / failed. Waits for network to settle so client-fetched menus load.
 */
export async function renderHtml(
  url: string,
  opts: { timeoutMs?: number; settleMs?: number } = {},
): Promise<string | null> {
  const browser = await getBrowser();
  if (!browser) return null;

  let context: any;
  try {
    context = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    // block heavy assets we don't need (images/fonts/media) to speed up render
    await page.route("**/*", (route: any) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") return route.abort();
      return route.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: opts.timeoutMs ?? 20000 });
    // let SPA data-fetches complete (best-effort)
    await page.waitForLoadState("networkidle", { timeout: opts.settleMs ?? 6000 }).catch(() => {});
    const html = await page.content();
    return html;
  } catch {
    return null;
  } finally {
    try {
      await context?.close();
    } catch {
      /* ignore */
    }
  }
}
