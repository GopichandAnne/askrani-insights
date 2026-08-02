import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
const raw=readFileSync(".env.local","utf8");const env={};
for (const l of raw.split(/\r?\n/)){const m=l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);if(!m)continue;let v=m[2];if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);if(!(m[1] in process.env))process.env[m[1]]=v;}
const svc=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const EMAIL=(process.env.SUPER_ADMIN_EMAILS||"annen315@gmail.com").split(",")[0].trim();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const tick=async()=>{const c=new AbortController();const t=setTimeout(()=>c.abort(),200000);try{await fetch("https://insights.askrani.ai/api/worker/tick",{headers:{"x-vercel-cron":"1"},signal:c.signal});}catch{}finally{clearTimeout(t);}};
async function main(){
  const {data:us}=await svc.auth.admin.listUsers();
  const uid=us.users.find(x=>x.email===EMAIL).id;
  const {data:mem}=await svc.from("org_membership").select("organization_id").eq("user_id",uid).limit(1).maybeSingle();
  const orgId=mem.organization_id;
  const {data:ws}=await svc.from("workspace").select("id").eq("organization_id",orgId);
  const wsIds=ws.map(w=>w.id);
  const counts=async()=>{const {data}=await svc.from("collection_job").select("status").in("workspace_id",wsIds);const c={};for(const j of data||[])c[j.status]=(c[j.status]||0)+1;return c;};
  for(let i=0;i<3;i++){const c=await counts();const active=(c.pending||0)+(c.running||0);console.log(`check ${i}:`,JSON.stringify(c));if(active===0)break;await tick();await sleep(3000);}
  const {data:org}=await svc.from("organization").select("settings").eq("id",orgId).maybeSingle();
  const b=org.settings.billing;
  const debits=(b.ledger||[]).filter(e=>e.reason==="collection_debit");
  console.log("\n===== FINAL BURN =====");
  console.log("job status:",JSON.stringify(await counts()));
  console.log("balance:",b.planCredits+b.topupCredits,"| totalSpent:",b.totalSpent,"credits | totalCostUsd: $"+b.totalCostUsd);
  console.log("collection debits:",debits.length,"| avg credits/collection:",debits.length?(debits.reduce((a,e)=>a-e.delta,0)/debits.length).toFixed(2):0,"| avg $/collection: $"+(debits.length?(debits.reduce((a,e)=>a+(e.costUsd||0),0)/debits.length).toFixed(4):0));
}
main().then(()=>process.exit(0),(e)=>{console.error(e.message);process.exit(1)});
