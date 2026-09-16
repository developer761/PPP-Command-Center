"use server";

/**
 * Enrolment and exits, as server actions a signed-in person can call.
 *
 * The work lives in enrol-core.ts so the tick can run it without a user. These
 * check the caller first, the same as every messaging action
 * (server-action-auth.test.ts), and then do exactly what the tick does.
 */
import { messagingDb } from "./db";
import { assertMessagingAccess } from "./auth";
import { enrolLeadWith, sweepExitsWith, type EnrolResult } from "./enrol-core";
import type { LeadRecord } from "./rules";

export async function enrolLead(input: {
  workspaceId: string;
  customerPhone: string;
  customerName?: string | null;
  customerEmail?: string | null;
  sfLeadId?: string | null;
  record: LeadRecord;
  leadCreatedAt?: string | null;
}): Promise<EnrolResult> {
  await assertMessagingAccess();
  return enrolLeadWith(messagingDb(), {
    ...input,
    leadCreatedAt: input.leadCreatedAt ? new Date(input.leadCreatedAt) : null,
  });
}

export async function sweepExits(input: {
  records: Record<string, LeadRecord>;
}): Promise<{ ended: number; reasons: Record<string, string> }> {
  await assertMessagingAccess();
  return sweepExitsWith(messagingDb(), input);
}
