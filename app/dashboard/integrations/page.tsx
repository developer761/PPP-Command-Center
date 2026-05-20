import Link from "next/link";
import PageHeader from "@/components/page-header";
import {
  getStoredSalesforceCredentials,
  isSalesforceConfigured,
  pingSalesforce,
} from "@/lib/salesforce/client";
import { describeKeySObjects } from "@/lib/salesforce/queries";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ sf_connected?: string; sf_error?: string; sf_cache_cleared?: string }>;

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
  const cacheCleared = sp.sf_cache_cleared === "1";
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

  // Run schema inspection when connected so we can see what custom fields PPP actually has.
  // Useful when dashboard numbers look wrong — verifies field API names.
  let schema: Awaited<ReturnType<typeof describeKeySObjects>> | null = null;
  if (isConnected) {
    try {
      schema = await describeKeySObjects();
    } catch {
      // non-fatal; render rest of page without inspector
    }
  }

  return (
    <div className="space-y-6 sm:space-y-8 animate-fade-up">
      <PageHeader
        title="Integrations"
        subtitle="External systems Command Center talks to."
      />

      {justConnected && isConnected && (
        <div className="rounded-lg border border-ppp-green-100 bg-ppp-green-50 text-ppp-green-700 text-sm px-4 py-3">
          <strong>Salesforce connected.</strong> Refresh token saved. Command Center can now read from PPP&apos;s Salesforce.
        </div>
      )}

      {cacheCleared && (
        <div className="rounded-lg border border-ppp-blue-100 bg-ppp-blue-50 text-ppp-blue-700 text-sm px-4 py-3">
          <strong>Cache cleared.</strong> Next page load will re-fetch live from Salesforce.
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
              <div className="flex items-center gap-2">
                <form action="/api/admin/sf-refresh-cache" method="POST">
                  <button
                    type="submit"
                    className="text-xs font-medium px-3 py-1.5 rounded-lg border border-ppp-charcoal-100 text-ppp-charcoal hover:border-ppp-blue-200 hover:text-ppp-blue-700 hover:bg-ppp-blue-50/40 transition-colors"
                    title="Bust the 5-min snapshot cache and re-fetch from Salesforce"
                  >
                    Refresh data
                  </button>
                </form>
                <Link
                  href="/api/auth/salesforce/login"
                  className="text-xs font-medium px-3 py-1.5 rounded-lg border border-ppp-charcoal-100 text-ppp-charcoal hover:border-ppp-blue-200 hover:text-ppp-blue-700 hover:bg-ppp-blue-50/40 transition-colors"
                >
                  Reconnect
                </Link>
              </div>
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

      {/* ─── Schema Inspector ─── */}
      {schema && (
        <details className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
          <summary className="cursor-pointer px-5 sm:px-6 py-4 hover:bg-ppp-charcoal-50/50 transition-colors">
            <span className="font-condensed text-base font-bold text-ppp-navy uppercase tracking-wide">
              Schema Inspector
            </span>
            <span className="ml-2 text-xs text-ppp-charcoal-500">
              · Click to see PPP&apos;s actual custom fields per object
            </span>
          </summary>
          <div className="border-t border-ppp-charcoal-100 divide-y divide-ppp-charcoal-100">
            {schema.map((obj) => (
              <div key={obj.object} className="px-5 sm:px-6 py-4">
                <div className="flex items-baseline justify-between gap-3 mb-2">
                  <h4 className="font-semibold text-ppp-navy">{obj.object}</h4>
                  <span className="text-xs text-ppp-charcoal-500">
                    {obj.error
                      ? `error: ${obj.error}`
                      : `${obj.totalRecords.toLocaleString()} record${obj.totalRecords === 1 ? "" : "s"} · ${obj.customFields.length} custom field${obj.customFields.length === 1 ? "" : "s"}`}
                  </span>
                </div>
                {obj.customFields.length > 0 && (
                  <>
                    {obj.object === "Opportunity" && obj.customFields.some((f) => typeof f.sumLast730 === "number") && (
                      <div className="mb-3 -mx-1 px-3 py-2 bg-ppp-blue-50 border border-ppp-blue-100 rounded text-[11px] sm:text-xs">
                        <div className="font-semibold text-ppp-navy mb-1">
                          Revenue field probe (SUM across all Opportunities, last 730 days)
                        </div>
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3 gap-y-0.5 font-mono">
                          {obj.customFields
                            .filter((f) => typeof f.sumLast730 === "number" && (f.sumLast730 ?? 0) > 0)
                            .sort((a, b) => (b.sumLast730 ?? 0) - (a.sumLast730 ?? 0))
                            .map((f) => (
                              <div key={f.name} className="flex justify-between gap-2">
                                <span className="truncate text-ppp-charcoal">{f.name}</span>
                                <span className="text-ppp-navy font-semibold tabular-nums whitespace-nowrap">
                                  ${(f.sumLast730 ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}
                                </span>
                              </div>
                            ))}
                        </div>
                        <div className="mt-1 text-[10px] text-ppp-charcoal-500 italic">
                          The field with ~$1.26M is PPP&apos;s revenue field (per their report).
                        </div>
                      </div>
                    )}
                    <div className="text-[11px] sm:text-xs grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-3 gap-y-1 font-mono">
                      {obj.customFields.map((f) => {
                        const sampleVal = obj.sampleRecord?.[f.name];
                        const hasValue =
                          sampleVal !== null && sampleVal !== undefined && sampleVal !== "";
                        return (
                          <div
                            key={f.name}
                            className={`truncate ${hasValue ? "text-ppp-charcoal" : "text-ppp-charcoal-200"}`}
                            title={`${f.label} (${f.type})${hasValue ? ` — sample: ${String(sampleVal).slice(0, 80)}` : " — empty in sample record"}`}
                          >
                            {f.name}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
