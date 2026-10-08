import "server-only";

import jsforce, { type Connection } from "jsforce";
import { createClient as createSupabaseAdminClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSalesforceClient } from "@/lib/salesforce/client";

/**
 * Which Salesforce org the PAYMENTS code talks to — production, or a sandbox
 * for end-to-end testing — without touching the rest of the app.
 *
 * Why this is its own module and not a switch on lib/salesforce/client.ts:
 * that client holds ONE stored login (system_credentials sf_*), and the whole
 * Command Center — the dashboard Alex reads every morning, materials,
 * customers — runs on it. Pointing it at a sandbox would cut everyone off from
 * production data. So the sandbox gets its own stored login (sandbox_sf_* keys),
 * its own Connected App env vars, its own connect page
 * (/api/auth/salesforce-sandbox/login), and ONLY lib/salesforce/payments.ts
 * and the payments Salesforce writes use it.
 *
 *   PAYMENTS_SF_ORG=sandbox          payments code → sandbox (local testing only)
 *   SF_SANDBOX_LOGIN_URL             e.g. https://test.salesforce.com or
 *                                    https://precisionplus--dev.sandbox.my.salesforce.com
 *   SF_SANDBOX_CONSUMER_KEY / _SECRET  the sandbox's Connected App
 *
 * Refuses to run "sandbox" against an instance that isn't one: a test payment
 * written into production by a misconfiguration is the exact failure this
 * whole setup exists to prevent.
 */

export type PaymentsOrg = "production" | "sandbox";

export function paymentsOrgFromEnv(env: Record<string, string | undefined>): PaymentsOrg {
  return env.PAYMENTS_SF_ORG?.trim() === "sandbox" ? "sandbox" : "production";
}

export function paymentsOrg(): PaymentsOrg {
  return paymentsOrgFromEnv(process.env);
}

/** Does this instance URL belong to a sandbox? (My Domain sandboxes contain
 *  ".sandbox." ; legacy ones are cs##.salesforce.com or test.salesforce.com.) */
export function isSandboxInstanceUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.includes(".sandbox.") || host === "test.salesforce.com" || /^cs\d+\./.test(host);
  } catch {
    return false;
  }
}

const SANDBOX_KEYS = { refresh: "sandbox_sf_refresh_token", instance: "sandbox_sf_instance_url" } as const;

let _sb: SupabaseClient | null = null;
function db(): SupabaseClient {
  if (!_sb) {
    _sb = createSupabaseAdminClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _sb;
}

function sandboxOAuth() {
  const loginUrl = process.env.SF_SANDBOX_LOGIN_URL?.trim();
  const clientId = process.env.SF_SANDBOX_CONSUMER_KEY?.trim();
  const clientSecret = process.env.SF_SANDBOX_CONSUMER_SECRET?.trim();
  if (!loginUrl || !clientId || !clientSecret) {
    throw new Error("Sandbox Salesforce isn't configured: set SF_SANDBOX_LOGIN_URL, SF_SANDBOX_CONSUMER_KEY and SF_SANDBOX_CONSUMER_SECRET.");
  }
  if (!isSandboxInstanceUrl(loginUrl)) {
    throw new Error(`SF_SANDBOX_LOGIN_URL (${loginUrl}) is not a sandbox address — refusing.`);
  }
  return { loginUrl, clientId, clientSecret };
}

export function sandboxAuthorizationUrl(redirectUri: string): string {
  const o = sandboxOAuth();
  const p = new URLSearchParams({
    response_type: "code",
    client_id: o.clientId,
    redirect_uri: redirectUri,
    scope: "api refresh_token",
    prompt: "login consent",
  });
  return `${o.loginUrl}/services/oauth2/authorize?${p}`;
}

export async function connectSandbox(code: string, redirectUri: string, storedBy: string): Promise<string> {
  const o = sandboxOAuth();
  const res = await fetch(`${o.loginUrl}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: o.clientId,
      client_secret: o.clientSecret,
      redirect_uri: redirectUri,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Sandbox token exchange failed (${res.status}): ${await res.text()}`);
  const t = (await res.json()) as { refresh_token: string; instance_url: string };
  if (!isSandboxInstanceUrl(t.instance_url)) {
    throw new Error(`That login returned ${t.instance_url}, which is not a sandbox. Not stored.`);
  }
  for (const row of [
    { key: SANDBOX_KEYS.refresh, value: t.refresh_token },
    { key: SANDBOX_KEYS.instance, value: t.instance_url },
  ]) {
    const { error } = await db()
      .from("system_credentials")
      .upsert({ ...row, updated_by: storedBy }, { onConflict: "key" });
    if (error) throw new Error(`Couldn't store the sandbox login: ${error.message}`);
  }
  _sandboxConn = null;
  return t.instance_url;
}

let _sandboxConn: Connection | null = null;

async function getSandboxClient(): Promise<Connection> {
  if (_sandboxConn) return _sandboxConn;
  const o = sandboxOAuth();
  const { data, error } = await db().from("system_credentials").select("key, value").in("key", Object.values(SANDBOX_KEYS));
  if (error) throw new Error(`Couldn't read the sandbox login: ${error.message}`);
  const m = Object.fromEntries((data ?? []).map((r) => [r.key, r.value as string]));
  const instanceUrl = m[SANDBOX_KEYS.instance];
  const refreshToken = m[SANDBOX_KEYS.refresh];
  if (!instanceUrl || !refreshToken) {
    throw new Error("Sandbox Salesforce isn't connected yet — open /api/auth/salesforce-sandbox/login.");
  }
  if (!isSandboxInstanceUrl(instanceUrl)) throw new Error(`Stored sandbox instance ${instanceUrl} is not a sandbox — refusing.`);
  _sandboxConn = new jsforce.Connection({
    instanceUrl,
    refreshToken,
    oauth2: { loginUrl: o.loginUrl, clientId: o.clientId, clientSecret: o.clientSecret },
    version: "60.0",
  });
  return _sandboxConn;
}

/** The Salesforce connection the payments code should use. */
export async function getPaymentsSalesforceClient(): Promise<Connection> {
  return paymentsOrg() === "sandbox" ? getSandboxClient() : getSalesforceClient();
}

/** For a link back to a record in whichever org the payments code is on. */
export async function paymentsSalesforceBaseUrl(): Promise<string> {
  const conn = await getPaymentsSalesforceClient();
  return conn.instanceUrl.replace(/\/$/, "");
}
