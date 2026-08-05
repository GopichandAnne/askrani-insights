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

// finish collection
const deadline=Date.now()+8*60*1000;
while(Date.now()<deadline){
  const st=await get(`/api/collect/status?workspaceId=${WS}`).then(r=>r.json()).catch(()=>({jobs:[]}));
  const jobs=st.jobs??[]; const active=jobs.filter(j=>["pending","running"].includes(j.status)).length;
  console.log(`[collect] ${jobs.filter(j=>["done","error"].includes(j.status)).length}/${jobs.length} done, ${active} active`);
  if(jobs.length&&active===0) break;
  await sleep(30000);
}

// current business set (target + current competitors)
const {data:eids}=await admin.from("competitor_edge").select("competitor_id").eq("workspace_id",WS);
const {data:tw0}=await admin.from("workspace").select("target_business_id,goals").eq("id",WS).maybeSingle();
const biz=[tw0.target_business_id,...(eids||[]).map(e=>e.competitor_id)];

// clean stale events (from removed competitors like Blue Corn / Dog Haus)
const {data:allEv}=await admin.from("market_event").select("id,business_id").eq("workspace_id",WS);
const stale=(allEv||[]).filter(e=>!biz.includes(e.business_id)).map(e=>e.id);
if(stale.length) await admin.from("market_event").delete().in("id",stale);
console.log("cleaned stale events:",stale.length);

// force fresh briefing / edge / trends / news
await admin.from("workspace").update({goals:{...(tw0.goals||{}),briefing:null,edge:null,localTrends:null,newsDigest:null}}).eq("id",WS);
console.log("generating surfaces (fresh)…");
await get("/api/briefing").then(r=>r.json()).catch(()=>({}));
await get("/api/intel").then(r=>r.json()).catch(()=>({}));
// /around triggers trends + news; retry once if trends pending
for(let i=0;i<2;i++){ await get("/around"); await sleep(2000);
  const lt=(await admin.from("workspace").select("goals").eq("id",WS).maybeSingle()).data.goals?.localTrends;
  if(lt&&lt.trends?.length) break; }
await sleep(2000);

const g=(await admin.from("workspace").select("goals").eq("id",WS).maybeSingle()).data.goals||{};
console.log("\n================ FOUR SURFACES ================");
console.log("\n[1] THIS WEEK");
if(g.briefing?.headline){console.log("  Briefing:",g.briefing.headline);console.log("   ",(g.briefing.summary||"").slice(0,260));}
else console.log("  Briefing: (pending)");
if(g.edge?.headline){console.log("  Edge:",g.edge.headline);for(const m of (g.edge.competitorMoves||[]).slice(0,3))console.log("    •",m.competitor+":",(m.move||"").slice(0,100));}

console.log("\n[2] COMPETITORS (per-rival)");
for(const id of (eids||[]).map(e=>e.competitor_id)){
  const {data:b}=await admin.from("business").select("canonical_name").eq("id",id).maybeSingle();
  const off=await admin.from("offer").select("id",{count:"exact",head:true}).eq("business_id",id);
  const rev=await admin.from("content_item").select("id",{count:"exact",head:true}).eq("business_id",id).in("platform",["google","yelp"]);
  console.log(`    ${b?.canonical_name}: ${off.count??0} offers · ${rev.count??0} review items`);
}

console.log("\n[3] CHANGES (recent)");
const {data:ev}=await admin.from("market_event").select("event_type,summary,business:business_id(canonical_name)").eq("workspace_id",WS).order("time_start",{ascending:false}).limit(6);
if(!ev?.length) console.log("    (none yet — events appear on re-collection diffs)");
for(const e of ev||[]) console.log("    •",e.business?.canonical_name,"—",String(e.event_type),"·",(e.summary||"").slice(0,70));

console.log("\n[4] AROUND ME / TRENDING NEAR YOU");
if(g.localTrends?.trends?.length){if(g.localTrends.summary)console.log("   ",g.localTrends.summary.slice(0,200));for(const t of g.localTrends.trends.slice(0,5))console.log(`    • [${t.momentum}] ${t.topic}`);}
else console.log("    trends:",g.localTrends?.empty?"thin data":"pending");
if(g.newsDigest?.items?.length) console.log("    news/openings/trends items:",g.newsDigest.items.length);
process.exit(0);
