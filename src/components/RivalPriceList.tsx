"use client";

import { useState } from "react";

export interface PricedRow { item: string; terms?: string; price?: string; ago?: string; isNew?: boolean; isDropped?: boolean }

/**
 * A rival's flyer prices, fully viewable IN-APP: shows the top 8 by default and
 * expands to the complete list on click (previously the extra items were only a
 * non-clickable "+N more" — the full list was reachable only via the external
 * source or by asking the assistant). Footer carries the expand toggle + source.
 */
export function RivalPriceList({ items, offersLabel, sourceLink }: { items: PricedRow[]; offersLabel: string; sourceLink?: string | null }) {
  const [open, setOpen] = useState(false);
  const shown = open ? items : items.slice(0, 8);
  const more = items.length - 8;

  return (
    <>
      {items.length > 0 && (
        <ul className="mt-3 divide-y divide-line/50">
          {shown.map((d, i) => (
            <li key={i} className="flex items-center justify-between gap-2 py-1.5 text-sm">
              <span className="flex min-w-0 items-center gap-1.5 truncate text-ink">
                {d.isNew && <span className="chip shrink-0 bg-trust-direct/15 px-1.5 py-0 text-[10px] font-bold text-trust-direct">NEW</span>}
                {d.isDropped && <span className="chip shrink-0 bg-coral/15 px-1.5 py-0 text-[10px] font-bold text-coral-dark">⬇ DROP</span>}
                <span className="truncate">{d.item}{d.terms ? <span className="text-ink-faint"> · {d.terms}</span> : null}</span>
              </span>
              <span className="flex shrink-0 items-center gap-2">
                {d.ago && <span className="text-[11px] text-ink-faint">{d.ago}</span>}
                {d.price && <span className="font-semibold text-coral-dark">{d.price}</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex items-center justify-between text-xs">
        {more > 0 ? (
          <button onClick={() => setOpen(!open)} className="font-medium text-brand hover:underline">
            {open ? "Show less ▴" : `Show all ${items.length} items ▾`}
          </button>
        ) : (
          <span className="text-ink-faint">{offersLabel}</span>
        )}
        {sourceLink && <a href={sourceLink} target="_blank" rel="noreferrer" className="font-medium text-brand hover:underline">see source ↗</a>}
      </div>
    </>
  );
}
