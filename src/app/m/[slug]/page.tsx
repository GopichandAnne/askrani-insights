import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublishedAiPage, type AiPage } from "@/lib/aipage";

export const dynamic = "force-dynamic";

/**
 * Public, server-rendered AI-ready listing for a business. The facts are in plain
 * visible HTML (what AI crawlers actually read — they don't run JS); JSON-LD rides
 * along only as a classic indexing aid. Rendered from the published goals.aiPage.
 */
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const found = await getPublishedAiPage(slug);
  if (!found) return { title: "Not found" };
  const { page } = found;
  return {
    title: page.title,
    description: page.intro.slice(0, 155),
    alternates: { canonical: `/m/${page.slug}` },
    openGraph: { title: page.title, description: page.intro.slice(0, 200) },
  };
}

function jsonLd(page: AiPage) {
  const type = page.vertical === "restaurant" ? "Restaurant" : page.vertical === "grocery" ? "GroceryStore" : page.vertical === "salon" ? "HealthAndBeautyBusiness" : "LocalBusiness";
  const doc: Record<string, unknown> = {
    "@context": "https://schema.org", "@type": type, name: page.title.split("—")[0].trim(),
    ...(page.address ? { address: page.address } : {}),
    ...(page.website ? { url: page.website } : {}),
    ...(page.items.length ? {
      hasMenu: { "@type": "Menu", hasMenuItem: page.items.slice(0, 40).map((i) => ({ "@type": "MenuItem", name: i.name, ...(i.price ? { offers: { "@type": "Offer", price: i.price.replace(/[^0-9.]/g, ""), priceCurrency: "USD" } } : {}) })) },
    } : {}),
  };
  const faq = page.faqs.length ? { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: page.faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })) } : null;
  return faq ? [doc, faq] : [doc];
}

export default async function AiListingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const found = await getPublishedAiPage(slug);
  if (!found) notFound();
  const { page } = found;
  const asOf = new Date(page.updatedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  return (
    <main className="mx-auto max-w-2xl px-5 py-10 text-ink">
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd(page)) }} />

      <h1 className="font-display text-3xl font-extrabold tracking-tight">{page.title}</h1>
      <p className="mt-3 text-[15px] leading-relaxed text-ink-soft">{page.intro}</p>

      <div className="mt-3 space-y-1 text-sm text-ink-soft">
        {page.address && <p><span className="font-semibold text-ink">Location:</span> {page.address}</p>}
        {page.hours && <p><span className="font-semibold text-ink">Hours:</span> {page.hours}</p>}
        {page.website && <p><span className="font-semibold text-ink">Website:</span> <a href={page.website} className="text-brand-deep underline" rel="noopener">{page.website.replace(/^https?:\/\//, "")}</a></p>}
      </div>

      {page.items.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-bold">Menu &amp; prices</h2>
          <ul className="mt-2 divide-y divide-line/60">
            {page.items.map((it, i) => (
              <li key={i} className="flex items-baseline justify-between gap-4 py-1.5 text-sm">
                <span>{it.name}</span>
                {it.price && <span className="shrink-0 tabular-nums text-ink-soft">{it.price}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {page.faqs.length > 0 && (
        <section className="mt-8">
          <h2 className="text-lg font-bold">Frequently asked</h2>
          <dl className="mt-2 space-y-3">
            {page.faqs.map((f, i) => (
              <div key={i}>
                <dt className="text-sm font-semibold">{f.q}</dt>
                <dd className="mt-0.5 text-sm text-ink-soft">{f.a}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {page.reviewTakeaway && (
        <section className="mt-8">
          <h2 className="text-lg font-bold">What customers say</h2>
          <p className="mt-1 text-sm text-ink-soft">{page.reviewTakeaway}</p>
        </section>
      )}

      <p className="mt-10 border-t border-line/60 pt-3 text-xs text-ink-faint">Information as of {asOf}. Listing maintained by Ask Rani.</p>
    </main>
  );
}
