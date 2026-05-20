import Link from "next/link";
import PageHeader from "@/components/page-header";
import {
  getStoredSalesforceCredentials,
  isSalesforceConfigured,
  pingSalesforce,
} from "@/lib/salesforce/client";

type SearchParams = Promise<{ sf_connected?: string; sf_error?: string }>;

const ERROR_COPY: Record<string, string> = {
  no_code: "Salesforce didn't return an authorization code. Please try again.",
  access_denied: "You denied Salesforce permission. Click 'Connect Salesforce' to try again.",
};

function pretty(reason: string | undefined) {
  if (!reason) return null;
  return ERROR_COPY[reason] ?? `Salesforce connection failed: ${reason}`;
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const justConnected = sp.sf_connected === "1";
  const errorMessage = pretty(sp.sf_error);

  // Defensive: if SF OAuth env vars aren't deployed yet, show a clean "not configured"
  // state instead of crashing. Page must render even before Vercel env vars are set.
  const sfConfigured = isSalesforceConfigured();

  // Try a live ping to confirm credentials work, not just that they exist.
  let liveStatus:
    | { ok: true; userInfo: { id: string; organizationId: string; url: string } }
    | { ok: false; reason: string }
    | { ok: false; reason: "not_connected" } = { ok: false, reason: "not_connected" };

  let creds: Awaited<ReturnType<typeof getStoredSalesforceCredentials>> = null;
  try {
    creds = await getStoredSalesforceCredentials();
    if (creds && sfConfigured) {
      liveStatus = await pingSalesforce();
    }
  } catch (err) {
    // e.g. Supabase env vars missing or system_credentials table not yet created.
    // Fall through to the not-configured render path instead of 500-ing.
    liveStatus = {
      ok: false,
      reason: err instanceof Error ? err.message : "unknown_error",
    };
  }

  const isConnected = liveStatus.ok === true;

  return (
    <div className="space-y-6 sm:space-y-8 animate-fade-up">
      <PageHeader
        title="Integrations"
        subtitle="External systems Command Center talks to."
      />

      {justConnected && isConnected && (
        <div className="rounded-lg border border-ppp-green-100 bg-ppp-green-50 text-ppp-green-700 text-sm px-4 py-3">
          <strong>Salesforce connected.</strong> Refresh token saved. Command Center can now read from PPP's Salesforce.
        </div>
      )}

      {errorMessage && (
        <div className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 text-ppp-orange-700 text-sm px-4 py-3">
          {errorMessage}
        </div>
      )}

      <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span
                className={[
                  "inline-block h-2 w-2 rounded-full",
                  isConnected
                    ? "bg-ppp-green animate-pulse"
                    : sfConfigured
                    ? "bg-ppp-orange"
                    : "bg-ppp-charcoal-200",
                ].join(" ")}
              />
              <h3 className="font-condensed text-base font-bold text-ppp-navy uppercase tracking-wide">
                Salesforce
              </h3>
            </div>
            <p className="text-xs text-ppp-charcoal-500">
              {sfConfigured ? (
                <>
                  OAuth 2.0 Connected App ·{" "}
                  {process.env.SF_LOGIN_URL?.includes("test.salesforce.com") ? "sandbox" : "production"}
                </>
              ) : (
                "Salesforce env vars not deployed yet — add them in Vercel + redeploy"
              )}
            </p>
          </div>

          {sfConfigured ? (
            isConnected ? (
              <Link
                href="/api/auth/salesforce/login"
                className="text-xs font-medium px-3 py-1.5 rounded-lg border border-ppp-charcoal-100 text-ppp-charcoal hover:border-ppp-blue-200 hover:text-ppp-blue-700 hover:bg-ppp-blue-50/40 transition-colors"
              >
                Reconnect
              </Link>
            ) : (
              <Link
                href="/api/auth/salesforce/login"
                className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-ppp-blue text-white hover:bg-ppp-blue-600 transition-colors shadow-sm shadow-ppp-blue/30"
              >
                Connect Salesforce
              </Link>
            )
          ) : (
            <span
              className="text-xs font-medium px-3 py-1.5 rounded-lg bg-ppp-charcoal-50 text-ppp-charcoal-500 border border-ppp-charcoal-100"
              title="Add SF_LOGIN_URL, SF_CONSUMER_KEY, SF_CONSUMER_SECRET in Vercel"
            >
              Awaiting env vars
            </span>
          )}
        </div>

        {isConnected && liveStatus.ok && (
          <dl className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="text-ppp-charcoal-500 uppercase tracking-wide font-semibold">Connected at</dt>
              <dd className="mt-0.5 text-ppp-charcoal font-medium">
                {creds?.connectedAt ? new Date(creds.connectedAt).toLocaleString() : "—"}
              </dd>
            </div>
            <div>
              <dt className="text-ppp-charcoal-500 uppercase tracking-wide font-semibold">Authenticated user</dt>
              <dd className="mt-0.5 text-ppp-charcoal font-mono break-all">
                {liveStatus.userInfo.id}
              </dd>
            </div>
            <div>
              <dt className="text-ppp-charcoal-500 uppercase tracking-wide font-semibold">Org ID</dt>
              <dd className="mt-0.5 text-ppp-charcoal font-mono break-all">
                {liveStatus.userInfo.organizationId}
              </dd>
            </div>
            <div>
              <dt className="text-ppp-charcoal-500 uppercase tracking-wide font-semibold">Instance URL</dt>
              <dd className="mt-0.5 text-ppp-charcoal font-mono break-all">
                {creds?.instanceUrl}
              </dd>
            </div>
          </dl>
        )}

        {!isConnected && !liveStatus.ok && liveStatus.reason !== "not_connected" && (
          <div className="mt-4 text-xs text-ppp-orange-700 bg-ppp-orange-50 border border-ppp-orange-100 rounded-md px-3 py-2">
            <strong>Connected, but ping failed:</strong> {liveStatus.reason}
          </div>
        )}
      </div>
    </div>
  );
}
