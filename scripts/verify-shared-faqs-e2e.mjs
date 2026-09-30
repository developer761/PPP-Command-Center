/**
 * Does a SHARED standing answer actually reach a workspace's prompt?
 *
 * Unit tests prove the precedence rule against a stubbed client. They cannot
 * prove that a NULL workspace_id survives PostgREST's `.or()`, that the
 * partial unique index behaves, or that the answer comes out the far end in
 * the text the model is handed. That whole chain — table, loader, prompt — is
 * what this walks, against the real database.
 *
 * Writes real rows and deletes them in a finally block, the same shape
 * verify-workspace-config-e2e.mjs uses.
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { loadWorkspaceFaqs, loadSharedFaqs, clearWorkspaceFaqCache } from "../lib/messaging/workspace-faq-db.ts";
import { faqsForPrompt } from "../lib/messaging/workspace-faq.ts";
import { checkFaq } from "../lib/messaging/workspace-faq.ts";

const env = Object.fromEntries(readFileSync(new URL("../.env.local", import.meta.url), "utf8").split("\n")
  .filter(l=>l.includes("=")&&!l.startsWith("#"))
  .map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,"")];}));
for (const [k,v] of Object.entries(env)) process.env[k] ??= v;

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SECRET_KEY, { auth:{persistSession:false} });
let pass=0, fail=0;
const ok=(l,c,x="")=>{ c?(pass++,console.log(`  ✓  ${l}`)):(fail++,console.log(`  ✗  ${l}  ${x}`)); };

const made = [];
const mk = async (workspace_id, question, answer) => {
  const { data, error } = await sb.from("sms_workspace_faqs")
    .insert({ workspace_id, question, answer, is_active:true }).select("id").single();
  if (error) throw new Error(`${question}: ${error.message}`);
  made.push(data.id); return data.id;
};

try {
  const { data: ws } = await sb.from("sms_sub_accounts").select("id,name").limit(2);
  const [A, B] = ws;
  console.log(`\nworkspaces: ${A.name} / ${B.name}\n`);

  await mk(null,  "Are you insured?",          "Yes, fully licensed and insured.");
  await mk(null,  "What is your warranty?",    "Two years on labor.");
  await mk(A.id,  "what is your warranty?",    "Three years in this region.");

  clearWorkspaceFaqCache();
  const a = await loadWorkspaceFaqs(sb, A.id);
  const b = await loadWorkspaceFaqs(sb, B.id);
  const shared = await loadSharedFaqs(sb);

  const ans = (rows,q) => rows.find(r=>r.question.toLowerCase()===q)?.answer;

  ok("a shared answer reaches a workspace that has none of its own",
     ans(b,"what is your warranty?") === "Two years on labor.", ans(b,"what is your warranty?"));
  ok("the workspace's OWN answer wins where it has one",
     ans(a,"what is your warranty?") === "Three years in this region.", ans(a,"what is your warranty?"));
  ok("overriding one question does not remove the other shared answer",
     ans(a,"are you insured?") === "Yes, fully licensed and insured.");
  ok("no duplicate warranty answer in the prompt for the overriding workspace",
     a.filter(r=>/warranty/i.test(r.question)).length === 1,
     `got ${a.filter(r=>/warranty/i.test(r.question)).length}`);
  ok("the sandbox's no-workspace state sees the shared tier",
     shared.length === 2, `got ${shared.length}`);

  const prompt = faqsForPrompt(a);
  ok("the answer actually reaches the built prompt text",
     prompt.includes("Three years in this region.") && !prompt.includes("Two years on labor."));

  const why = (f) => checkFaq(f).map(p => p.why).join(" ");
  ok("a location-bound question is refused from the shared tier",
     /depends on where/i.test(why({ question:"Where are you located?", answer:"Pasadena.", shared:true })));
  ok("a location-bound ANSWER is refused even when the question looks global",
     /"County"/.test(why({ question:"Do you offer free estimates?",
                           answer:"Yes, anywhere in Nassau County.", shared:true })));
  ok("a genuinely global question is NOT refused",
     checkFaq({ question:"Do you use water-based or oil-based paint?",
                answer:"Both, depending on the surface.", shared:true }).length === 0);
  ok("the same location-bound question is still fine for ONE workspace",
     checkFaq({ question:"Where are you located?", answer:"Pasadena.", shared:false }).length === 0);
} catch (e) {
  fail++; console.log("  ✗  threw:", e.message);
} finally {
  for (const id of made) await sb.from("sms_workspace_faqs").delete().eq("id", id);
  const { data: left } = await sb.from("sms_workspace_faqs").select("id");
  console.log(`\ncleaned up ${made.length} rows — ${left.length} remaining in table`);
  console.log(`${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}
