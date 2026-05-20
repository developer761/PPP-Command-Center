import "server-only";

import jsforce, { Connection } from "jsforce";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";

/**
 * Salesforce OAuth + REST client utilities.
 *
 * Pattern: OAuth 2.0 Web Server Flow with a service-account user.
 *   1. Admin (Karan) visits /api/auth/salesforce/login → bounced to SF
 *   2. SF auth screen → admin signs in as the service-account user PPP provisioned
 *   3. SF redirects to /api/auth/salesforce/callback w/ auth code
 *   4. callback exchanges code for {access_token, refresh_token, instance_url}
 *   5. refresh_token + instance_url stored in Supabase system_credentials table
 *   6. Every SF query mints a fresh access_token from the refresh_token
 *
 * The Consumer Secret + the refresh_token never leave the server. The browser
 * never sees either. The refresh_token is in a Supabase table that only
 * service-role access can read (RLS denies everything else).
 */

/** Throw if Supabase service-role env vars are missing. Required for ANY credential storage operation. */
function assertSupabaseEnv() {
  for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SECRET_KEY"] as const) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }
}

/** Throw if Salesforce OAuth env vars are missing. Required for the dance + queries. */
function assertSalesforceOAuthEnv() {
  for (const key of ["SF_LOGIN_URL", "SF_CONSUMER_KEY", "SF_CONSUMER_SECRET"] as const) {
    if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
  }
}

/** Returns true if all SF OAuth env vars are present without throwing. */
export function isSalesforceConfigured(): boolean {
  return Boolean(
    process.env.SF_LOGIN_URL &&
      process.env.SF_CONSUMER_KEY &&
      process.env.SF_CONSUMER_SECRET
  );
}

/** Server-only Supabase client w/ service role. Used to read/write system_credentials. */
function getSupabaseServiceClient() {
  assertSupabaseEnv();
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SECRET_KEY!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
}

/** Build the Salesforce authorization URL the admin must visit to start the OAuth dance.
 *
 * Scopes we request:
 *   - api: REST API access (required for SOQL queries)
 *   - refresh_token: long-lived refresh token so we don't re-auth every couple hours
 *
 * We deliberately do NOT request `openid` because the Connected App may not have
 * the OpenID Connect scope enabled, and we can fetch user identity via the API
 * after authentication anyway.
 */
export function getSalesforceAuthorizationUrl(redirectUri: string): string {
  assertSalesforceOAuthEnv();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: process.env.SF_CONSUMER_KEY!,
    redirect_uri: redirectUri,
    scope: "api refresh_token",
    prompt: "consent",
  });
  return `${process.env.SF_LOGIN_URL}/services/oauth2/authorize?${params.toString()}`;
}

/** Exchange an OAuth authorization code for tokens. Called from the callback route. */
export async function exchangeCodeForTokens(code: string, redirectUri: string) {
  assertSalesforceOAuthEnv();
  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: process.env.SF_CONSUMER_KEY!,
    client_secret: process.env.SF_CONSUMER_SECRET!,
    redirect_uri: redirectUri,
  });

  const res = await fetch(`${process.env.SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Salesforce token exchange failed (${res.status}): ${errorBody}`);
  }

  return (await res.json()) as {
    access_token: string;
    refresh_token: string;
    instance_url: string;
    id: string;
    token_type: string;
    issued_at: string;
    signature: string;
  };
}

/** Persist the refresh_token + instance_url in the system_credentials table. */
export async function storeSalesforceCredentials({
  refreshToken,
  instanceUrl,
  storedBy,
}: {
  refreshToken: string;
  instanceUrl: string;
  storedBy: string;
}) {
  const sb = getSupabaseServiceClient();

  const writes = [
    { key: "sf_refresh_token", value: refreshToken },
    { key: "sf_instance_url", value: instanceUrl },
    { key: "sf_connected_at", value: new Date().toISOString() },
  ];

  for (const row of writes) {
    const { error } = await sb
      .from("system_credentials")
      .upsert({ ...row, updated_by: storedBy }, { onConflict: "key" });
    if (error) throw new Error(`Failed to store ${row.key}: ${error.message}`);
  }
}

/** Read the stored Salesforce credentials. Returns null if the OAuth dance hasn't been run yet. */
export async function getStoredSalesforceCredentials(): Promise<
  { refreshToken: string; instanceUrl: string; connectedAt: string } | null
> {
  const sb = getSupabaseServiceClient();
  const { data, error } = await sb
    .from("system_credentials")
    .select("key, value")
    .in("key", ["sf_refresh_token", "sf_instance_url", "sf_connected_at"]);

  if (error) throw new Error(`Failed to read SF credentials: ${error.message}`);
  if (!data) return null;

  const map = Object.fromEntries(data.map((r) => [r.key, r.value]));
  if (!map.sf_refresh_token || !map.sf_instance_url) return null;

  return {
    refreshToken: map.sf_refresh_token,
    instanceUrl: map.sf_instance_url,
    connectedAt: map.sf_connected_at ?? "",
  };
}

/**
 * Returns a configured jsforce Connection ready to run SOQL queries.
 *
 * The connection auto-refreshes its access_token using the stored refresh_token,
 * so callers never need to think about token expiration.
 *
 * Throws if the OAuth dance hasn't been completed yet — the caller should catch
 * and surface a "Salesforce not connected — visit /api/auth/salesforce/login"
 * message in the UI.
 */
export async function getSalesforceClient(): Promise<Connection> {
  assertSupabaseEnv();
  assertSalesforceOAuthEnv();
  const creds = await getStoredSalesforceCredentials();
  if (!creds) {
    throw new Error(
      "Salesforce is not connected yet. An admin must complete the OAuth dance at /api/auth/salesforce/login."
    );
  }

  const conn = new jsforce.Connection({
    oauth2: {
      loginUrl: process.env.SF_LOGIN_URL!,
      clientId: process.env.SF_CONSUMER_KEY!,
      clientSecret: process.env.SF_CONSUMER_SECRET!,
    },
    instanceUrl: creds.instanceUrl,
    refreshToken: creds.refreshToken,
  });

  return conn;
}

/** Quick health-check: returns true if SF is connected and a token refresh succeeded. */
export async function pingSalesforce(): Promise<
  | { ok: true; userInfo: { id: string; organizationId: string; url: string } }
  | { ok: false; reason: string }
> {
  try {
    const conn = await getSalesforceClient();
    const identity = await conn.identity();
    return {
      ok: true,
      userInfo: {
        id: identity.user_id,
        organizationId: identity.organization_id,
        url: identity.urls?.profile ?? "",
      },
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "Unknown error pinging Salesforce",
    };
  }
}
