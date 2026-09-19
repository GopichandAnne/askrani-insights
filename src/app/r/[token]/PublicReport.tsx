import React from "react";
import type { ReportData } from "@/lib/reportpage";

/**
 * Presentational render of the public market-read (the lead-magnet page). All
 * styles are scoped under `.rpt` with locally-defined CSS variables so nothing
 * clashes with the app's globals. Sections render only when the data backs them.
 */

const CSS = `
.rpt{--bg:#f6f7f4;--surface:#fff;--surface-2:#eef4f2;--ink:#152f2c;--ink-soft:#42605b;--muted:#7a8d89;--line:#e2e9e6;--teal:#0f9e8f;--teal-deep:#0b7d70;--teal-mist:#e4f8f3;--coral:#f2721c;--coral-deep:#d65f10;--coral-soft:#fff1e6;--watch:#c07807;--watch-soft:#fbf1dd;--shadow:0 14px 34px -22px rgba(9,42,38,.5);color:var(--ink);font-family:"DM Sans",system-ui,sans-serif;line-height:1.5}
@media (prefers-color-scheme:dark){.rpt:not([data-theme="light"]){--bg:#0a1513;--surface:#111f1c;--surface-2:#172925;--ink:#e9f2f0;--ink-soft:#adc3be;--muted:#7a938e;--line:#213330;--teal:#2dd4bf;--teal-deep:#5eead4;--teal-mist:rgba(45,212,191,.12);--coral:#fb923c;--coral-deep:#fdba74;--coral-soft:rgba(251,146,60,.13);--watch:#f0b429;--watch-soft:rgba(240,180,41,.12);--shadow:0 16px 40px -24px rgba(0,0,0,.7)}}
.rpt *{box-sizing:border-box}
.rpt .wrap{max-width:900px;margin:0 auto;padding-inline:20px}
.rpt h1,.rpt h2,.rpt h3{font-family:"Playfair Display",Georgia,serif;text-wrap:balance;margin:0}
.rpt .num{font-variant-numeric:tabular-nums}
.rpt .title{padding-block:30px 8px}
.rpt .eyebrow{font-size:.72rem;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--coral-deep)}
.rpt .title h1{font-size:clamp(2.1rem,5.4vw,3rem);font-weight:800;line-height:1.03;margin-top:8px}
.rpt .title .sub{color:var(--ink-soft);font-size:1.05rem;margin-top:8px}
.rpt section{padding-block:24px}
.rpt .sec-h{display:flex;align-items:baseline;gap:12px;margin-bottom:16px}
.rpt .sec-h h2{font-size:1.5rem;font-weight:700}
.rpt .sec-h .tag{font-size:.72rem;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.rpt .card{background:var(--surface);border:1px solid var(--line);border-radius:18px;box-shadow:var(--shadow)}
.rpt .pos{display:grid;grid-template-columns:auto 1fr;gap:26px;align-items:center;padding:26px 28px}
.rpt .pos .big{text-align:center;padding-right:26px;border-right:1px solid var(--line)}
.rpt .pos .big .stars{font-size:3.4rem;font-weight:800;font-family:"Playfair Display",serif;line-height:1;color:var(--teal-deep)}
.rpt .pos .big .stars small{font-size:1.3rem;color:var(--muted);font-weight:400}
.rpt .pos .big .rank{margin-top:8px;font-size:.82rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--coral-deep)}
.rpt .pos .say{font-size:1.06rem;color:var(--ink-soft)}
.rpt .pos .say b{color:var(--ink)}
.rpt .pill{display:inline-flex;align-items:center;gap:7px;font-size:.78rem;font-weight:700;padding:5px 11px;border-radius:999px;margin-top:12px;background:var(--watch-soft);color:var(--watch)}
.rpt .pill .dot{width:7px;height:7px;border-radius:50%;background:currentColor}
.rpt .move{position:relative;overflow:hidden;padding:24px 26px;border:1px solid var(--coral);background:linear-gradient(160deg,var(--coral-soft),var(--surface) 70%)}
.rpt .move .lbl{font-size:.72rem;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--coral-deep)}
.rpt .move h3{font-size:1.5rem;font-weight:800;margin-top:10px}
.rpt .move p{color:var(--ink-soft);margin:10px 0 0;max-width:62ch}
.rpt .why{margin-top:16px;display:flex;flex-wrap:wrap;gap:10px}
.rpt .stat{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:10px 14px}
.rpt .stat .v{font-size:1.35rem;font-weight:800;font-family:"Playfair Display",serif;line-height:1}
.rpt .stat .k{font-size:.76rem;color:var(--muted);margin-top:3px}
.rpt .stat.hot .v{color:var(--coral-deep)}
.rpt .rows{display:flex;flex-direction:column;gap:2px;padding:8px}
.rpt .row{display:grid;grid-template-columns:1fr 130px auto;align-items:center;gap:14px;padding:12px 16px;border-radius:12px}
.rpt .row.you{background:var(--teal-mist)}
.rpt .row .nm{font-weight:600;display:flex;align-items:center;gap:8px;min-width:0}
.rpt .row .nm .you-tag{font-size:.64rem;font-weight:800;letter-spacing:.06em;color:#fff;background:var(--teal-deep);padding:2px 6px;border-radius:5px;text-transform:uppercase;flex:none}
.rpt .row .nm span.t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rpt .bar{height:9px;border-radius:6px;background:var(--surface-2);overflow:hidden}
.rpt .bar>i{display:block;height:100%;border-radius:6px;background:var(--muted)}
.rpt .row.you .bar>i{background:linear-gradient(90deg,var(--teal),var(--teal-deep))}
.rpt .row .rt{font-weight:800;font-family:"Playfair Display",serif;font-size:1.15rem;text-align:right;white-space:nowrap}
.rpt .row .rv{font-size:.8rem;color:var(--muted);text-align:right;white-space:nowrap}
.rpt .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}
.rpt .pcard{padding:18px;border:1px solid var(--line);border-radius:16px;background:var(--surface)}
.rpt .pcard .rv{font-weight:700;font-size:.95rem;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.rpt .pcard .rv .em{font-size:1.1rem}
.rpt .pcard .agg{color:var(--coral-deep);font-weight:700;font-size:.72rem}
.rpt .plist{list-style:none;margin:12px 0 0;padding:0;display:flex;flex-direction:column;gap:7px}
.rpt .plist li{display:flex;justify-content:space-between;gap:10px;font-size:.92rem;border-top:1px dashed var(--line);padding-top:7px}
.rpt .plist li:first-child{border-top:0;padding-top:0}
.rpt .plist li .p{font-weight:700;color:var(--teal-deep);white-space:nowrap;font-variant-numeric:tabular-nums}
.rpt .plist li .p.free{color:var(--coral-deep)}
.rpt .moves{display:flex;flex-direction:column;padding:6px 8px}
.rpt .mrow{display:grid;grid-template-columns:1fr auto auto;align-items:center;gap:14px;padding:14px 16px}
.rpt .mrow+.mrow{border-top:1px solid var(--line)}
.rpt .mrow .mi{font-weight:600;min-width:0}
.rpt .mrow .mi small{display:block;color:var(--muted);font-weight:500;font-size:.8rem;margin-top:2px}
.rpt .mrow .pp{font-variant-numeric:tabular-nums;font-weight:700;color:var(--ink);white-space:nowrap}
.rpt .mrow .pp .old{color:var(--muted);text-decoration:line-through;font-weight:500;margin-right:7px}
.rpt .badge{font-size:.82rem;font-weight:800;padding:4px 11px;border-radius:999px;white-space:nowrap}
.rpt .badge.cut{background:var(--coral-soft);color:var(--coral-deep)}
.rpt .badge.hike{background:var(--teal-mist);color:var(--teal-deep)}
.rpt .two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.rpt .lovebox,.rpt .watchbox{padding:20px}
.rpt .lovebox h3,.rpt .watchbox h3{font-size:1.05rem;font-weight:700}
.rpt .chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.rpt .chip{font-size:.85rem;font-weight:600;padding:6px 12px;border-radius:999px;background:var(--teal-mist);color:var(--teal-deep)}
.rpt .watchbox{border-color:color-mix(in srgb,var(--watch) 40%,var(--line))}
.rpt .gripe{margin-top:14px}
.rpt .gripe .th{font-weight:600;font-size:.94rem}
.rpt .gripe .fx{font-size:.86rem;color:var(--ink-soft);margin-top:3px;padding-left:16px}
.rpt .pulse{padding:20px 22px;display:flex;gap:16px;align-items:flex-start}
.rpt .pulse .em{font-size:1.7rem;flex:none}
.rpt .pulse p{margin:0;color:var(--ink-soft)}
.rpt .pulse b{color:var(--ink)}
.rpt .cal{display:flex;flex-direction:column;gap:10px}
.rpt .ev{display:grid;grid-template-columns:120px 1fr;gap:14px;padding:16px 18px;border:1px solid var(--line);border-radius:14px;background:var(--surface)}
.rpt .ev .when{font-size:.78rem;font-weight:700;color:var(--coral-deep);text-transform:uppercase;letter-spacing:.04em}
.rpt .ev h3{font-size:1.05rem;font-weight:700}
.rpt .ev p{margin:5px 0 0;font-size:.9rem;color:var(--ink-soft)}
.rpt .ev.next{border-color:var(--coral);background:linear-gradient(150deg,var(--coral-soft),var(--surface) 60%)}
.rpt .claim{margin:8px 0 6px;padding:28px;text-align:center;border:1px solid var(--teal);background:linear-gradient(160deg,var(--teal-mist),var(--surface) 75%)}
.rpt .claim h2{font-size:1.6rem;font-weight:800}
.rpt .claim p{color:var(--ink-soft);margin:10px auto 18px;max-width:52ch}
.rpt .cta{display:inline-flex;align-items:center;gap:8px;background:var(--teal-deep);color:#fff;font-weight:700;font-size:1rem;padding:13px 26px;border-radius:999px;text-decoration:none}
.rpt .claim .fine{font-size:.8rem;color:var(--muted);margin-top:14px}
.rpt .prov{border-top:1px solid var(--line);margin-top:14px;padding:20px;font-size:.8rem;color:var(--muted)}
.rpt .prov .note{border-left:3px solid var(--line);padding-left:12px;line-height:1.55;margin-top:8px}
@media (max-width:620px){.rpt .pos{grid-template-columns:1fr;text-align:center}.rpt .pos .big{border-right:0;border-bottom:1px solid var(--line);padding:0 0 18px}.rpt .two{grid-template-columns:1fr}.rpt .row{grid-template-columns:1fr auto;gap:6px 12px}.rpt .row .barwrap{grid-column:1/-1;order:3}.rpt .ev{grid-template-columns:1fr}.rpt .mrow{grid-template-columns:1fr auto}}
`;

const barPct = (rating: number | null) => (rating == null ? 0 : Math.max(8, Math.round((rating / 5) * 100)));

export function PublicReport({ data, claimHref }: { data: ReportData; claimHref: string }) {
  const p = data.position;
  return (
    <div className="rpt">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />
      <main className="wrap">
        <div className="title">
          <div className="eyebrow">Your local market</div>
          <h1>{data.businessName}</h1>
          <div className="sub">{data.subline}</div>
        </div>

        {/* POSITION */}
        <section aria-label="Market position">
          <div className="card pos">
            <div className="big">
              <div className="stars num">{p.rating ?? "—"}<small>★</small></div>
              {p.rank != null && p.total != null && <div className="rank">#{p.rank} of {p.total}{p.rank === 1 ? " · highest rated" : ""}</div>}
            </div>
            <div className="say">
              {p.say}
              {p.health && p.health !== "strong" && (
                <div><span className="pill"><span className="dot" />Health: {p.health === "at_risk" ? "at risk" : "watch"}</span></div>
              )}
            </div>
          </div>
        </section>

        {/* THE MOVE */}
        {data.move && (
          <section aria-label="Your move this week">
            <div className="card move">
              <div className="lbl">▲ Your move this week</div>
              <h3>{data.move.title}</h3>
              {data.move.detail && <p>{data.move.detail}</p>}
              {data.move.stats.length > 0 && (
                <div className="why">
                  {data.move.stats.map((s, i) => (
                    <div key={i} className={`stat${s.hot ? " hot" : ""}`}><div className="v num">{s.v}</div><div className="k">{s.k}</div></div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {/* STANDINGS */}
        {data.standings.length > 0 && (
          <section aria-label="Rating standings">
            <div className="sec-h"><h2>Where you stand</h2><span className="tag">rating · google</span></div>
            <div className="card">
              <div className="rows">
                {data.standings.map((s, i) => (
                  <div key={i} className={`row${s.isYou ? " you" : ""}`}>
                    <div className="nm">{s.isYou && <span className="you-tag">You</span>}<span className="t">{s.name}</span></div>
                    <div className="barwrap"><div className="bar"><i style={{ width: `${barPct(s.rating)}%` }} /></div></div>
                    <div><div className="rt num">{s.rating ?? "—"}★</div>{s.reviews != null && <div className="rv num">{s.reviews.toLocaleString()} reviews</div>}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* THE BOARD */}
        {data.board.cards.length > 0 && (
          <section aria-label="What rivals are charging">
            <div className="sec-h"><h2>{data.board.title}</h2><span className="tag">their flyers</span></div>
            {data.board.intro && <div className="card pulse" style={{ marginBottom: 16 }}><span className="em">🥬</span><p>{data.board.intro}</p></div>}
            <div className="grid">
              {data.board.cards.map((c, i) => (
                <div key={i} className="pcard">
                  <div className="rv"><span className="em">🛒</span>{c.rival}{c.aggressive && <span className="agg">· MOST AGGRESSIVE</span>}</div>
                  <ul className="plist">
                    {c.items.map((it, j) => (
                      <li key={j}><span>{it.label}</span><span className={`p${it.free ? " free" : ""}`}>{it.price}</span></li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* PRICE MOVES */}
        {data.moves && (
          <section aria-label="Rival price moves">
            <div className="sec-h"><h2>Rival price moves this week</h2><span className="tag">week-over-week</span></div>
            {data.moves.intro && <div className="card pulse" style={{ marginBottom: 16 }}><span className="em">📉</span><p>{data.moves.intro}</p></div>}
            <div className="card">
              <div className="moves">
                {data.moves.rows.map((m, i) => (
                  <div key={i} className="mrow">
                    <div className="mi">{m.rival.split(/[·—-]/)[0].trim()} {m.direction === "cut" ? "cut" : "raised"} {m.item}<small>{m.unit === "ea" ? "" : `per ${m.unit} · `}vs last week</small></div>
                    <div className="pp"><span className="old num">{m.fromPrice}</span><span className="num">{m.toPrice}</span></div>
                    <div className={`badge ${m.direction}`}>{m.direction === "cut" ? "▼" : "▲"} {Math.abs(m.deltaPct)}%</div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* REVIEWS */}
        {data.reviews && (data.reviews.love.length > 0 || data.reviews.watch.length > 0) && (
          <section aria-label="What customers say">
            <div className="sec-h"><h2>What your customers say</h2><span className="tag">your google reviews</span></div>
            <div className="two">
              {data.reviews.love.length > 0 && (
                <div className="card lovebox">
                  <h3>💚 They love</h3>
                  <div className="chips">{data.reviews.love.map((l, i) => <span key={i} className="chip">{l}</span>)}</div>
                </div>
              )}
              {data.reviews.watch.length > 0 && (
                <div className="card watchbox">
                  <h3>⚠ Watch &amp; fix</h3>
                  {data.reviews.watch.map((w, i) => (
                    <div key={i} className="gripe"><div className="th">• {w.theme}</div>{w.fix && <div className="fx">{w.fix}</div>}</div>
                  ))}
                </div>
              )}
            </div>
          </section>
        )}

        {/* PULSE */}
        {data.pulse && (
          <section aria-label="What is driving the market">
            <div className="sec-h"><h2>What's driving the market now</h2><span className="tag">social · engagement</span></div>
            <div className="card pulse"><span className="em">🎉</span><p>{data.pulse}</p></div>
          </section>
        )}

        {/* CALENDAR */}
        {data.calendar.length > 0 && (
          <section aria-label="What is coming up">
            <div className="sec-h"><h2>What's coming — plan ahead</h2><span className="tag">your market calendar</span></div>
            <div className="cal">
              {data.calendar.map((e, i) => (
                <div key={i} className={`ev${e.next ? " next" : ""}`}>
                  <div className="when">{e.when}</div>
                  <div><h3>{e.title}</h3><p>{e.detail}</p></div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* CLAIM */}
        <section aria-label="Claim your dashboard">
          <div className="card claim">
            <h2>This is your market — watched live.</h2>
            <p>Claim your free dashboard and Ask Rani keeps watching this market for you: weekly updates, and an alert the moment a rival cuts a price.</p>
            <a className="cta" href={claimHref}>Claim your dashboard — 15 days free →</a>
            <div className="fine">No credit card. Free for 15 days, then a free weekly plan — cancel anytime.</div>
          </div>
        </section>

        <div className="prov">
          <div>Collected {data.dateLabel} · Ratings &amp; reviews: Google · Prices &amp; promos: rivals' Instagram</div>
          <div className="note">Every figure traces to collected evidence. Your own shelf prices aren't posted publicly, so this shows rivals' promoted prices — not a side-by-side. Ask Rani keeps watching this market and flags only what changes.</div>
        </div>
      </main>
    </div>
  );
}
