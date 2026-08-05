import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
const env = Object.fromEntries(fs.readFileSync(".env.local","utf8").split("\n").filter(l=>l.includes("=")).map(l=>{const i=l.indexOf("=");return[l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const SB=env.NEXT_PUBLIC_SUPABASE_URL, REF=new URL(SB).host.split(".")[0];
const admin=createClient(SB,env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
const anon=createClient(SB,env.NEXT_PUBLIC_SUPABASE_ANON_KEY,{auth:{persistSession:false}});
const BASE="https://insights.askrani.ai", EMAIL="annen315+desicircle@gmail.com";

const link=await admin.auth.admin.generateLink({type:"magiclink",email:EMAIL});
const ver=await anon.auth.verifyOtp({type:"email",email:EMAIL,token:link.data.properties.email_otp});
const s=ver.data.session, uid=s.user.id;
const cookie=`sb-${REF}-auth-token=base64-`+Buffer.from(JSON.stringify({access_token:s.access_token,refresh_token:s.refresh_token,expires_at:s.expires_at,expires_in:s.expires_in,token_type:"bearer",user:s.user})).toString("base64");
const call=(p,b)=>fetch(BASE+p,{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify(b)}).then(async r=>({status:r.status,json:await r.json().catch(()=>({}))}));

// 1) find Desi Circle
const search=await call("/api/discover/search",{query:"Desi Circle Cedar Park TX"});
console.log("search results:");
for(const r of (search.json.results??[]).slice(0,6)) console.log("  ",r.detectedVertical,"|",r.name,"|",r.address??"");
const pick=(search.json.results??[]).find(r=>/desi\s*circle/i.test(r.name)) ?? (search.json.results??[])[0];
if(!pick){console.log("Desi Circle not found");process.exit(1);}
console.log("\npicked:",pick.name,"| vertical:",pick.detectedVertical,"| subtype:",pick.subtype);

// 2) create workspace (auto competitors)
const created=await call("/api/workspace/create",{candidate:pick,vertical:pick.detectedVertical||"restaurant"});
console.log("create:",created.status,"vertical:",created.json.vertical,"subtype:",created.json.subtype);
console.log("auto competitors ("+(created.json.competitors??[]).length+"):");
for(const c of created.json.competitors??[]) console.log("   -",c.name, c.distanceKm!=null?`(${c.distanceKm}km)`:"");

const {data:mem}=await admin.from("org_membership").select("organization_id").eq("user_id",uid).maybeSingle();
const orgId=mem.organization_id;
const {data:ws}=await admin.from("workspace").select("id,name,target_business_id").eq("organization_id",orgId).order("created_at",{ascending:false}).limit(1).maybeSingle();

// 3) ensure similar-cuisine rivals: if <5 competitors, search & add nearby Indian restaurants
let {data:edges}=await admin.from("competitor_edge").select("id,competitor_id").eq("workspace_id",ws.id);
if((edges?.length??0) < 5){
  const add=await call("/api/discover/search",{query:"indian restaurant Cedar Park TX"});
  const targetName=pick.name.toLowerCase();
  const cands=(add.json.results??[]).filter(r=>r.name.toLowerCase()!==targetName).slice(0,6);
  for(const c of cands){ await call("/api/competitors/add",{workspaceId:ws.id,candidate:c}); }
  ({data:edges}=await admin.from("competitor_edge").select("id,competitor_id").eq("workspace_id",ws.id));
  console.log("added similar-cuisine rivals; total now:",edges?.length);
}

// 4) grant credits + trim to target + top 6
await admin.from("organization").update({settings:{...(await admin.from("organization").select("settings").eq("id",orgId).maybeSingle()).data?.settings, billing:{plan:"free",planCredits:0,topupCredits:6000,trialGranted:true,status:"active",totalSpent:0,totalCostUsd:0,ledger:[]}}}).eq("id",orgId);
const {data:ranked}=await admin.from("competitor_edge").select("id").eq("workspace_id",ws.id).order("score",{ascending:false});
const keep=new Set((ranked??[]).slice(0,6).map(e=>e.id));
const drop=(ranked??[]).filter(e=>!keep.has(e.id)).map(e=>e.id);
if(drop.length) await admin.from("competitor_edge").delete().in("id",drop);
console.log("credits granted; competitors kept:",keep.size,"dropped:",drop.length);

// 5) start collection
const start=await call("/api/collect/start",{workspaceId:ws.id});
console.log("collect/start:",start.status,JSON.stringify(start.json).slice(0,100));
console.log("\nWORKSPACE:",ws.name,ws.id,"| ORG:",orgId);
process.exit(0);
