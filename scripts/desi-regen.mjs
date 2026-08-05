import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
const env=Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")).map(l=>{const i=l.indexOf("=");return[l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const SB=env.NEXT_PUBLIC_SUPABASE_URL,REF=new URL(SB).host.split(".")[0];
const admin=createClient(SB,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const anon=createClient(SB,env.NEXT_PUBLIC_SUPABASE_ANON_KEY,{auth:{persistSession:false}});
const BASE="https://insights.askrani.ai",WS="e64c2219-0314-4595-8e7e-005d742415dc",EMAIL="annen315+desicircle@gmail.com";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const link=await admin.auth.admin.generateLink({type:"magiclink",email:EMAIL});
const ver=await anon.auth.verifyOtp({type:"email",email:EMAIL,token:link.data.properties.email_otp});
const s=ver.data.session;
let cookie=`sb-${REF}-auth-token=base64-`+Buffer.from(JSON.stringify({access_token:s.access_token,refresh_token:s.refresh_token,expires_at:s.expires_at,expires_in:s.expires_in,token_type:"bearer",user:s.user})).toString("base64");
await fetch(BASE+"/api/workspace/active",{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify({workspaceId:WS})}).then(r=>{const c=r.headers.get("set-cookie");if(c){const m=c.match(/ar_active_ws=[^;]+/);if(m)cookie+="; "+m[0];}});
const get=p=>fetch(BASE+p,{headers:{cookie}});
const goals=async()=>(await admin.from("workspace").select("goals").eq("id",WS).maybeSingle()).data.goals||{};
const clear=async(k)=>{const g=await goals();await admin.from("workspace").update({goals:{...g,[k]:null}}).eq("id",WS);};

// briefing: retry until summary present
for(let i=0;i<5;i++){ const b=await get("/api/briefing").then(r=>r.json()).catch(()=>({})); if(b?.summary){console.log("briefing ok");break;} console.log("briefing retry",i+1); await clear("briefing"); await sleep(6000); }
// edge: retry until real (not the "Collect your market" fallback)
for(let i=0;i<5;i++){ const e=await get("/api/intel").then(r=>r.json()).catch(()=>({})); if(e?.headline&&!/Collect your market|Connect an AI key/.test(e.headline)){console.log("edge ok");break;} console.log("edge retry",i+1); await clear("edge"); await sleep(8000); }
// trends+news via /around: retry until trends present
for(let i=0;i<5;i++){ await get("/around"); await sleep(2500); const lt=(await goals()).localTrends; if(lt&&lt.trends?.length){console.log("trends ok");break;} console.log("trends retry",i+1); await clear("localTrends"); await sleep(6000); }

// ---- print all four surfaces ----
const g=await goals();
const {data:eids}=await admin.from("competitor_edge").select("competitor_id").eq("workspace_id",WS);
console.log("\n================ DESI CIRCLE — FOUR SURFACES ================");
console.log("\n[1] THIS WEEK");
if(g.briefing?.headline){console.log("  Briefing:",g.briefing.headline);console.log("   ",(g.briefing.summary||"").slice(0,300));}
if(g.edge?.headline){console.log("  Edge:",g.edge.headline);for(const m of (g.edge.competitorMoves||[]).slice(0,3)){console.log("    • "+m.competitor+":",(m.move||"").slice(0,110));if(m.leverage)console.log("        move:",m.leverage.slice(0,110));}}

console.log("\n[2] COMPETITORS (per-rival: offers · reviews)");
for(const id of (eids||[]).map(e=>e.competitor_id)){
  const {data:b}=await admin.from("business").select("canonical_name").eq("id",id).maybeSingle();
  const off=await admin.from("offer").select("id",{count:"exact",head:true}).eq("business_id",id);
  const rev=await admin.from("content_item").select("id",{count:"exact",head:true}).eq("business_id",id).in("platform",["google","yelp"]);
  console.log(`    ${b?.canonical_name}: ${off.count??0} offers · ${rev.count??0} reviews`);
}

console.log("\n[3] CHANGES (recent rival moves)");
const {data:ev}=await admin.from("market_event").select("event_type,summary,business:business_id(canonical_name)").eq("workspace_id",WS).order("time_start",{ascending:false}).limit(7);
for(const e of ev||[]) console.log("    •",e.business?.canonical_name,"—",(e.summary||String(e.event_type)).slice(0,80));

console.log("\n[4] TRENDING NEAR YOU");
if(g.localTrends?.summary)console.log("   ",g.localTrends.summary.slice(0,220));
for(const t of (g.localTrends?.trends||[]).slice(0,5)){console.log(`    • [${t.momentum}] ${t.topic}`);console.log("        why:",(t.evidence||"").slice(0,110));}
if(g.newsDigest?.items?.length)console.log("    + Around-me news items:",g.newsDigest.items.length);
process.exit(0);
