"use server";

/**
 * Turning a service on or off for one workspace.
 *
 * Writes an exception row only where the workspace DIFFERS from the default,
 * and deletes the row when it agrees again. That is what keeps "the global
 * list means everywhere" true: a workspace carrying a full copy of the
 * defaults would stop tracking changes to them, which is the exact bug the
 * prose fields had.
 */
import { messagingDb } from "./db";
import { assertMessagingAccess } from "./auth";

export async function setWorkspaceService(input: {
  workspaceId: string;
  serviceKey: string;
  covered: boolean;
}): Promise<{ ok: true; isException: boolean } | { ok: false; error: string }> {
  const userId = await assertMessagingAccess();
  const sb = messagingDb();

  const { data: svc, error: svcErr } = await sb
    .from("sms_services").select("covered_by_default").eq("key", input.serviceKey).maybeSingle();
  if (svcErr) return { ok: false, error: svcErr.message };
  if (!svc) return { ok: false, error: "That service does not exist." };

  // Agreeing with the default means having no row, not having a row that
  // happens to match. Otherwise the workspace is frozen at today's answer.
  if (svc.covered_by_default === input.covered) {
    const { error } = await sb.from("sms_workspace_services").delete()
      .eq("workspace_id", input.workspaceId).eq("service_key", input.serviceKey);
    if (error) return { ok: false, error: error.message };
    return { ok: true, isException: false };
  }

  const { error } = await sb.from("sms_workspace_services").upsert({
    workspace_id: input.workspaceId,
    service_key: input.serviceKey,
    covered: input.covered,
    updated_by: userId,
    updated_at: new Date().toISOString(),
  }, { onConflict: "workspace_id,service_key" });
  if (error) return { ok: false, error: error.message };
  return { ok: true, isException: true };
}

/** Put a workspace back on the default for everything. */
export async function clearWorkspaceServices(workspaceId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await assertMessagingAccess();
  const sb = messagingDb();
  const { error } = await sb.from("sms_workspace_services").delete().eq("workspace_id", workspaceId);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
