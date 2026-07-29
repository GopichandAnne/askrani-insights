import { providerHealth } from "@/lib/providers/registry";
import { isLlmConfigured, getLlm } from "@/lib/extraction/llm";

export const metadata = { title: "Admin — provider health" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const health = await providerHealth();
  let llmLine = "not configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY)";
  if (isLlmConfigured()) {
    const llm = getLlm();
    llmLine = `${llm.provider} · extract=${llm.modelFor("extract")} · classify=${llm.modelFor("classify")}`;
  }

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold tracking-tight">Admin · provider health</h1>
        <p className="mt-1 text-ink-soft">
          Which collection adapters and models are active. Adapters light up when
          their keys are present (guide §12.1 Admin, §3.1 stack).
        </p>
      </section>

      <section className="overflow-hidden rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-left text-ink-faint">
            <tr>
              <th className="px-4 py-2 font-medium">Provider</th>
              <th className="px-4 py-2 font-medium">Provenance</th>
              <th className="px-4 py-2 font-medium">Configured</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Detail</th>
            </tr>
          </thead>
          <tbody>
            {health.map((h) => (
              <tr key={h.provider} className="border-t border-line">
                <td className="px-4 py-2 font-medium">{h.provider}</td>
                <td className="px-4 py-2 text-ink-faint">
                  {h.provider === "website"
                    ? "PUBLIC_WEBSITE_HTTP"
                    : h.provider === "google"
                      ? "OFFICIAL_PUBLIC_API"
                      : h.provider === "apify"
                        ? "MANAGED_PUBLIC_PROVIDER_APIFY"
                        : "LICENSED_DATASET_BRIGHTDATA"}
                </td>
                <td className="px-4 py-2">
                  <span className={h.configured ? "text-trust-direct" : "text-ink-faint"}>
                    {h.configured ? "yes" : "no"}
                  </span>
                </td>
                <td className="px-4 py-2">
                  <span className={h.ok ? "text-trust-direct" : "text-trust-inferred"}>
                    {h.ok ? "ok" : "inactive"}
                  </span>
                </td>
                <td className="px-4 py-2 text-ink-faint">{h.detail ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-xl border border-line bg-surface p-4 text-sm">
        <span className="font-medium">AI extraction: </span>
        <span className="text-ink-soft">{llmLine}</span>
      </section>
    </div>
  );
}
