"use client";

import { useState } from "react";

export interface OrgRow { id: string; name: string; plan: string; balance: number }
export interface PayLink { key: string; label: string; url: string }

/**
 * Admin helper — copy a customer's billing links without hand-building them.
 * Two flows:
 *  1. "Billing page" — send it to a customer who will sign in; their session
 *     already carries their org, so in-app Checkout maps the payment for us.
 *  2. Per-product Payment Links (if STRIPE_LINK_* env is set) — for buyers who
 *     pay WITHOUT signing in; we append ?client_reference_id=<orgId> so the
 *     webhook credits the right org.
 */
export function OrgBillingLinks({ orgs, links, billingUrl }: { orgs: OrgRow[]; links: PayLink[]; billingUrl: string }) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1400);
    } catch { /* clipboard blocked — ignore */ }
  }
  const withRef = (url: string, orgId: string) => `${url}${url.includes("?") ? "&" : "?"}client_reference_id=${orgId}`;

  if (orgs.length === 0) return <p className="card text-sm text-ink-faint">No organizations yet.</p>;

  return (
    <div className="space-y-2">
      {links.length === 0 && (
        <p className="rounded-lg border border-dashed border-line bg-surface p-2.5 text-xs text-ink-faint">
          Tip: set <code className="rounded bg-surface-sunken px-1">STRIPE_LINK_STARTER</code> etc. to your Stripe Payment Link URLs to get one-click
          per-product links here. Without them, send the <b>Billing page</b> link — the customer signs in and buys there.
        </p>
      )}
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-sunken text-left text-ink-faint">
            <tr>
              <th className="px-4 py-2 font-medium">Organization</th>
              <th className="px-4 py-2 font-medium">Plan</th>
              <th className="px-4 py-2 font-medium">Balance</th>
              <th className="px-4 py-2 font-medium">Billing links</th>
            </tr>
          </thead>
          <tbody>
            {orgs.map((o) => (
              <tr key={o.id} className="border-t border-line align-top">
                <td className="px-4 py-2.5">
                  <div className="font-medium">{o.name || "Untitled org"}</div>
                  <button onClick={() => copy(`id-${o.id}`, o.id)} className="mt-0.5 font-mono text-[11px] text-ink-faint hover:text-brand" title="Copy org id">
                    {copied === `id-${o.id}` ? "copied ✓" : `${o.id.slice(0, 8)}… ⧉`}
                  </button>
                </td>
                <td className="px-4 py-2.5 capitalize">{o.plan}</td>
                <td className="px-4 py-2.5 tabular-nums">{o.balance.toLocaleString()}</td>
                <td className="px-4 py-2.5">
                  <div className="flex flex-wrap gap-1.5">
                    <button onClick={() => copy(`bp-${o.id}`, billingUrl)} className="chip bg-brand-soft text-brand-deep hover:opacity-80">
                      {copied === `bp-${o.id}` ? "copied ✓" : "Billing page ⧉"}
                    </button>
                    {links.map((l) => (
                      <button key={l.key} onClick={() => copy(`${l.key}-${o.id}`, withRef(l.url, o.id))}
                        className="chip bg-surface-sunken text-ink-soft hover:text-brand" title={`Copy ${l.label} Payment Link for this org`}>
                        {copied === `${l.key}-${o.id}` ? "copied ✓" : `${l.label} ⧉`}
                      </button>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
