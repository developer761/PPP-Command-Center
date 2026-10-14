/**
 * Decision 2, answered by experiment: write Status__c = 'Approved' on a change
 * order and see whether it STICKS and whether the rollup moves.
 *
 * If a flow rewrites it to Approved-Auto, Katie's answer is Approved-Auto. If it
 * holds and TotalChangeOrder__c moves, 'Approved' is correct and she has nothing
 * to decide. Sandbox only — guarded.
 */
import { readFileSync } from "node:fs";
import jsforce from "jsforce";
const APPLY = process.argv.includes("--apply");
const E=(p)=>Object.fromEntries(readFileSync(p,"utf8").split("\n").filter((l)=>l.includes("=")&&!l.trim().startsWith("#")).map((l)=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,"")];}));
const H="/Users/karanmalhotra/Desktop/PPP/ppp-command-center";
const env=E(`${H}/.env.local`), sbEnv=E(`${H}/../ppp-cc-paytest/.env.local`);
const { createClient } = await import("@supabase/supabase-js");
const supa=createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY,{auth:{persistSession:false}});
const { data:cred } = await supa.from("system_credentials").select("key,value").in("key",["sandbox_sf_refresh_token","sandbox_sf_instance_url"]);
const C=Object.fromEntries(cred.map((r)=>[r.key,r.value]));
const conn=new jsforce.Connection({oauth2:{loginUrl:sbEnv.SF_SANDBOX_LOGIN_URL||"https://test.salesforce.com",clientId:sbEnv.SF_SANDBOX_CONSUMER_KEY,clientSecret:sbEnv.SF_SANDBOX_CONSUMER_SECRET},instanceUrl:C.sandbox_sf_instance_url,refreshToken:C.sandbox_sf_refresh_token});
const t=await conn.oauth2.refreshToken(C.sandbox_sf_refresh_token); conn.accessToken=t.access_token; if(t.instance_url)conn.instanceUrl=t.instance_url;
if(!String(conn.instanceUrl).includes(".sandbox.")) { console.error("🔴 not a sandbox — refusing"); process.exit(1); }
const q=async(s)=>{const o=[];let x=await conn.query(s);o.push(...x.records);while(!x.done){x=await conn.queryMore(x.nextRecordsUrl);o.push(...x.records);}return o;};
const m=(n)=>`$${Number(n??0).toLocaleString("en-US",{minimumFractionDigits:2})}`;

const [opp] = await q(`SELECT Id FROM Opportunity WHERE Name LIKE 'CCC-STAGE0%' ORDER BY CreatedDate DESC LIMIT 1`);
if (!opp) { console.error("no Stage 0 opportunity — run tomco-writeback-stage0.mjs --apply first"); process.exit(1); }
const [wo] = await q(`SELECT Id, WorkOrderNumber, TotalChangeOrder__c, Quoted_Subtotal_with_Change_Order__c FROM WorkOrder WHERE Opportunity__c='${opp.Id}' LIMIT 1`);
if (!wo) { console.error("no work order on it"); process.exit(1); }

const AMT = 1111.11;
console.log(`\n══ CHANGE ORDER PROBE · ${conn.instanceUrl}`);
console.log(`   work order ${wo.WorkOrderNumber}  rollup before ${m(wo.TotalChangeOrder__c)}  subtotal+CO before ${m(wo.Quoted_Subtotal_with_Change_Order__c)}`);
console.log(`   will create ChangeOrder__c  CostChange__c=${m(AMT)}  Status__c='Approved'  ReasonForChange__c='Scope change'`);
if (!APPLY) { console.log(`\n(dry run — nothing written. --apply to run)\n`); process.exit(0); }

const res = await conn.sobject("ChangeOrder__c").create({
  WorkOrder__c: wo.Id,
  CostChange__c: AMT,
  Status__c: "Approved",
  ReasonForChange__c: "Scope change",
  Notes__c: "CCC-STAGE0 change-order probe",
});
if (!res.success) { console.error(res); process.exit(1); }
console.log(`\n   created ${res.id}`);
await new Promise((r)=>setTimeout(r, 10000));

const [co] = await q(`SELECT Id, Name, CostChange__c, Status__c, ReasonForChange__c FROM ChangeOrder__c WHERE Id='${res.id}'`);
const [wo2] = await q(`SELECT Id, TotalChangeOrder__c, Quoted_Subtotal_with_Change_Order__c FROM WorkOrder WHERE Id='${wo.Id}'`);
const [opp2] = await q(`SELECT Id, QuotedSubtotalWithChangeOrder__c, Quote_Subtotal__c FROM Opportunity WHERE Id='${opp.Id}'`);

console.log(`\n══ RESULT ══\n`);
const held = co?.Status__c === "Approved";
console.log(`   ${held?"✅":"🔴"} Status__c we wrote 'Approved' → reads '${co?.Status__c}'${held?"":"  ← A FLOW REWROTE IT"}`);
console.log(`      ReasonForChange__c                  '${co?.ReasonForChange__c}'`);
console.log(`      ${co?.Name}  ${m(co?.CostChange__c)}`);
const moved = Math.round(Number(wo2?.TotalChangeOrder__c??0)*100) === Math.round(AMT*100);
console.log(`\n   ${moved?"✅":"🔴"} WorkOrder.TotalChangeOrder__c  ${m(wo.TotalChangeOrder__c)} → ${m(wo2?.TotalChangeOrder__c)}`);
console.log(`      WorkOrder subtotal+CO          ${m(wo.Quoted_Subtotal_with_Change_Order__c)} → ${m(wo2?.Quoted_Subtotal_with_Change_Order__c)}`);
console.log(`      Opportunity CO-inclusive       ${m(opp2?.QuotedSubtotalWithChangeOrder__c)}   (base ${m(opp2?.Quote_Subtotal__c)})`);

console.log(`\n── what this settles ──`);
if (held && moved) {
  console.log(`   'Approved' is correct and it counts. Decision 2 needs nothing from Katie.`);
} else if (!held) {
  console.log(`   A flow owns Status__c — it rewrote our value to '${co?.Status__c}'.`);
  console.log(`   So write THAT, or let the flow set it. Decision 2 answered by the org.`);
} else {
  console.log(`   Status held but the rollup did NOT move — so 'Approved' alone does not`);
  console.log(`   count toward the total, and Katie's answer matters. Ask her.`);
}
console.log(`\n   ChangeOrder__c is not deletable by this user — the probe row stays.\n`);
