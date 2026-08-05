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

// wait for collection (cron drains)
const deadline=Date.now()+8.5*60*1000;
while(Date.now()<deadline){
  const st=await get(`/api/collect/status?workspaceId=${WS}`).then(r=>r.json()).catch(()=>({jobs:[]}));
  const jobs=st.jobs??[]; const active=jobs.filter(j=>["pending","running"].includes(j.status)).length;
  const done=jobs.filter(j=>["done","error"].includes(j.status)).length;
  console.log(`[collect] ${done}/${jobs.length} done, ${active} active`);
  if(jobs.length&&active===0) break;
  await sleep(30000);
}

// trigger generation of all four surfaces
console.log("\ngenerating surfaces…");
for(const p of ["/","/around","/competitors","/feed","/api/briefing","/api/intel"]) { await get(p); }
await sleep(3000);

// data counts
const {data:eids}=await admin.from("competitor_edge").select("competitor_id").eq("workspace_id",WS);
const {data:tw}=await admin.from("workspace").select("target_business_id,goals").eq("id",WS).maybeSingle();
const biz=[tw.target_business_id,...(eids||[]).map(e=>e.competitor_id)];
const cnt=async(t,f)=>{const{count}=await f(admin.from(t).select("id",{count:"exact",head:true}));return count??0;};
console.log("\n=== DATA ===");
console.log("ratings/reviews:",await cnt("content_item",q=>q.in("business_id",biz).in("platform",["google","yelp"])),
  "· offers:",await cnt("offer",q=>q.in("business_id",biz)),
  "· social:",await cnt("content_item",q=>q.in("business_id",biz).in("platform",["instagram","facebook","tiktok","youtube"])),
  "· events:",await cnt("market_event",q=>q.eq("workspace_id",WS)));

const g=tw.goals||{};
console.log("\n=== 1) THIS WEEK ===");
if(g.briefing?.headline) console.log("Briefing:",g.briefing.headline,"\n ",(g.briefing.summary||"").slice(0,240));
if(g.edge?.headline){console.log("Edge:",g.edge.headline);for(const m of (g.edge.competitorMoves||[]).slice(0,2))console.log("  •",m.competitor+":",(m.move||"").slice(0,90));}
console.log("\n=== 4) TRENDING/AROUND ===");
if(g.localTrends?.trends?.length){for(const t of g.localTrends.trends.slice(0,4))console.log(`  • [${t.momentum}] ${t.topic}`);}else console.log("  (trends:",g.localTrends?.empty?"thin":"pending",")");
if(g.newsDigest?.items?.length) console.log("  news items:",g.newsDigest.items.length);

// competitor cards summary
const {competitorCards}=await import("../src/lib/competitors.ts").catch(()=>({}));
console.log("\n=== 2) COMPETITORS (offers/rating per rival) ===");
for(const id of (eids||[]).map(e=>e.competitor_id)){
  const {data:b}=await admin.from("business").select("canonical_name").eq("id",id).maybeSingle();
  const off=await cnt("offer",q=>q.eq("business_id",id));
  const rev=await cnt("content_item",q=>q.eq("business_id",id).in("platform",["google","yelp"]));
  console.log(`  ${b?.canonical_name}: ${off} offers, ${rev} rating/review items`);
}
console.log("\n=== 3) CHANGES ===");
const {data:ev}=await admin.from("market_event").select("event_type,summary,business:business_id(canonical_name)").eq("workspace_id",WS).order("time_start",{ascending:false}).limit(6);
for(const e of ev||[]) console.log("  •",e.business?.canonical_name,"—",String(e.event_type),"·",(e.summary||"").slice(0,70));
process.exit(0);
