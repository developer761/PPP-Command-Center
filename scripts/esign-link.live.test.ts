/**
 * Issue one open signing link on a TEST proposal and print the local URL — for
 * eyeballing the signing page on a phone-width screen. Live DB; run like
 * scripts/esign.live.test.ts with ESIGN_LINK_PROPOSAL set.
 */
import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { createSignatureRequest } from "@/lib/commercial/esign/db";

it("issues a signing link", async () => {
  const proposalId = process.env.ESIGN_LINK_PROPOSAL;
  if (!proposalId) throw new Error("set ESIGN_LINK_PROPOSAL");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, { auth: { persistSession: false } });
  const { data } = await sb.from("profiles").select("user_id,email").eq("email", "developer@precisionpaintingplus.net").single();
  const dev = data as { user_id: string; email: string };
  const r = await createSignatureRequest({
    proposalId,
    signerEmail: "developer@precisionpaintingplus.net",
    signerName: "Maria Irigaray",
    requestedBy: { userId: dev.user_id, name: "Visual check", email: dev.email },
  });
  if (!r.ok) throw new Error(r.error);
  writeFileSync(process.env.ESIGN_LINK_OUT ?? "/tmp/esign-link.txt", `http://localhost:3000/sign/${r.token}\n`);
});
