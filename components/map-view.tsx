"use client";

import { useMemo, useRef, useState } from "react";
import Map, {
  Source,
  Layer,
  NavigationControl,
  Popup,
  type MapRef,
  type MapMouseEvent,
} from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import FilterDropdown from "@/components/filter-dropdown";
import PageHeader from "@/components/page-header";
import { PERIOD_LABELS, type Period } from "@/lib/mock-data";
import { fmtMoneyK } from "@/lib/format";
import type { LiveDashboardBundle } from "@/lib/data-source";

const MAPBOX_TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN ?? "";

const PERIOD_OPTIONS: { value: Period; label: string }[] = (
  ["this-month", "last-month", "30d", "90d", "this-year", "last-year", "12m", "lifetime"] as Period[]
).map((v) => ({ value: v, label: PERIOD_LABELS[v] }));

type Props = { bundle: LiveDashboardBundle };

type PopupData = {
  lat: number;
  lng: number;
  amount: number;
  account: string;
  status: string;
  rep: string;
  wo: string;
  id: string;
};

export default function MapView({ bundle }: Props) {
  const [period, setPeriod] = useState<Period>("lifetime");
  const [popup, setPopup] = useState<PopupData | null>(null);
  const [cursor, setCursor] = useState<"auto" | "pointer">("auto");
  const mapRef = useRef<MapRef | null>(null);
  const { snapshot } = bundle;

  // Build GeoJSON FeatureCollection from WORK ORDERS — they carry the actual
  // job-site geocoded lat/lng (20k+ records populated in production). Each WO
  // is one job at one address with one $ value, perfect for heatmap weighting.
  const geojson = useMemo(() => {
    if (!snapshot) return { type: "FeatureCollection" as const, features: [] };
    const features = snapshot.workOrders
      .filter((w) => {
        if (typeof w.latitude !== "number" || typeof w.longitude !== "number") return false;
        if (w.latitude === 0 || w.longitude === 0) return false;
        if (w.amount === 0) return false;
        return true;
      })
      .map((w) => ({
        type: "Feature" as const,
        geometry: {
          type: "Point" as const,
          coordinates: [w.longitude as number, w.latitude as number],
        },
        properties: {
          id: w.id,
          amount: w.amount,
          account: w.accountName ?? "",
          status: w.status ?? "",
          rep: w.ownerName ?? "",
          wo: w.workOrderNumber ?? "",
        },
      }));
    return { type: "FeatureCollection" as const, features };
  }, [snapshot]);

  const pointCount = geojson.features.length;
  const totalRevenue = useMemo(
    () => geojson.features.reduce((s, f) => s + ((f.properties.amount as number) ?? 0), 0),
    [geojson]
  );

  if (!MAPBOX_TOKEN) {
    return (
      <div className="animate-fade-up space-y-6">
        <PageHeader title="Map" subtitle="Geographic distribution of jobs across PPP's footprint" />
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
          <div className="h-14 w-14 rounded-full bg-ppp-blue-50 text-ppp-blue text-2xl flex items-center justify-center mx-auto mb-4">
            🗺
          </div>
          <p className="text-sm font-semibold text-ppp-charcoal">Mapbox token not configured</p>
          <p className="text-xs text-ppp-charcoal-500 mt-2 max-w-md mx-auto">
            Add <code className="px-1 py-0.5 bg-ppp-charcoal-50 rounded">NEXT_PUBLIC_MAPBOX_TOKEN</code> to
            Vercel env vars and redeploy. Free tier on{" "}
            <a className="text-ppp-blue underline" href="https://mapbox.com" target="_blank" rel="noreferrer">
              mapbox.com
            </a>{" "}
            allows 50k loads/month.
          </p>
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="animate-fade-up space-y-6">
        <PageHeader title="Map" subtitle="Geographic distribution of jobs across PPP's footprint" />
        <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-10 text-center">
          <p className="text-sm font-semibold text-ppp-charcoal">Salesforce not connected</p>
          <p className="text-xs text-ppp-charcoal-500 mt-1">
            Connect in Admin → Integrations to populate the map.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 sm:space-y-6 animate-fade-up">
      <PageHeader
        title="Map"
        subtitle={`${pointCount.toLocaleString()} geocoded jobs · ${fmtMoneyK(totalRevenue / 1000)} total revenue`}
        actions={
          <FilterDropdown<Period>
            value={period}
            options={PERIOD_OPTIONS}
            onChange={setPeriod}
            srLabel="Period"
            icon={<IconCalendar />}
          />
        }
      />

      {snapshot.isSandbox && (
        <div className="rounded-lg border border-ppp-orange-100 bg-ppp-orange-50 text-ppp-orange-700 text-xs sm:text-sm px-4 py-3">
          <strong>Sandbox data.</strong> Production map will populate with thousands of geo-located jobs.
        </div>
      )}

      <div className="bg-white border border-ppp-charcoal-100 rounded-xl overflow-hidden">
        <div className="h-[60vh] sm:h-[70vh] min-h-[500px] w-full">
          <Map
            ref={mapRef}
            mapboxAccessToken={MAPBOX_TOKEN}
            initialViewState={{ longitude: -73.5, latitude: 40.8, zoom: 8 }}
            mapStyle="mapbox://styles/mapbox/light-v11"
            attributionControl={false}
            interactiveLayerIds={["clusters", "unclustered-point"]}
            cursor={cursor}
            onMouseEnter={() => setCursor("pointer")}
            onMouseLeave={() => setCursor("auto")}
            onClick={(e: MapMouseEvent) => {
              const feature = e.features?.[0];
              if (!feature) return;
              const map = mapRef.current?.getMap();
              if (!map) return;

              // Cluster click → zoom in to expand
              if (feature.properties?.cluster_id) {
                const clusterId = feature.properties.cluster_id;
                const source = map.getSource("jobs") as unknown as {
                  getClusterExpansionZoom: (
                    id: number,
                    cb: (err: Error | null, zoom: number | null) => void
                  ) => void;
                };
                source.getClusterExpansionZoom(clusterId, (err, zoom) => {
                  if (err || zoom == null) return;
                  map.easeTo({
                    center: (feature.geometry as unknown as { coordinates: [number, number] }).coordinates,
                    zoom: Math.min(zoom, 16),
                    duration: 400,
                  });
                });
                setPopup(null);
                return;
              }

              // Individual job click → open the preview popup
              const props = feature.properties ?? {};
              const [lng, lat] = (feature.geometry as unknown as { coordinates: [number, number] }).coordinates;
              setPopup({
                lat,
                lng,
                amount: (props.amount as number) ?? 0,
                account: (props.account as string) ?? "(unknown account)",
                status: (props.status as string) ?? "",
                rep: (props.rep as string) ?? "",
                wo: (props.wo as string) ?? "",
                id: (props.id as string) ?? "",
              });
            }}
          >
            <NavigationControl position="top-right" showCompass={false} />
            <Source
              id="jobs"
              type="geojson"
              data={geojson}
              cluster
              clusterRadius={50}
              clusterMaxZoom={10}
            >
              {/* Heatmap layer — beautiful overview at zoomed-out levels */}
              <Layer
                id="jobs-heat"
                type="heatmap"
                maxzoom={9}
                paint={{
                  "heatmap-weight": ["interpolate", ["linear"], ["get", "amount"], 0, 0, 50000, 1],
                  "heatmap-intensity": ["interpolate", ["linear"], ["zoom"], 0, 1, 9, 3],
                  "heatmap-color": [
                    "interpolate",
                    ["linear"],
                    ["heatmap-density"],
                    0, "rgba(43, 170, 225, 0)",
                    0.2, "rgba(43, 170, 225, 0.3)",
                    0.4, "rgba(141, 196, 66, 0.5)",
                    0.6, "rgba(238, 102, 46, 0.7)",
                    0.8, "rgba(238, 102, 46, 0.9)",
                    1, "rgba(220, 50, 30, 1)",
                  ],
                  "heatmap-radius": ["interpolate", ["linear"], ["zoom"], 0, 8, 9, 30],
                  "heatmap-opacity": ["interpolate", ["linear"], ["zoom"], 7, 1, 9, 0.6],
                }}
              />
              {/* Cluster circles — kick in mid-zoom */}
              <Layer
                id="clusters"
                type="circle"
                filter={["has", "point_count"]}
                minzoom={6}
                paint={{
                  "circle-color": [
                    "step",
                    ["get", "point_count"],
                    "#2BAAE1",
                    50, "#8DC442",
                    200, "#EE662E",
                  ],
                  "circle-radius": [
                    "step",
                    ["get", "point_count"],
                    14,
                    50, 22,
                    200, 30,
                  ],
                  "circle-stroke-width": 2,
                  "circle-stroke-color": "#fff",
                  "circle-opacity": 0.85,
                }}
              />
              <Layer
                id="cluster-count"
                type="symbol"
                filter={["has", "point_count"]}
                minzoom={6}
                layout={{
                  "text-field": "{point_count_abbreviated}",
                  "text-font": ["DIN Pro Bold", "Arial Unicode MS Bold"],
                  "text-size": 12,
                }}
                paint={{ "text-color": "#fff" }}
              />
              {/* Single-job points at high zoom */}
              <Layer
                id="unclustered-point"
                type="circle"
                filter={["!", ["has", "point_count"]]}
                minzoom={8}
                paint={{
                  "circle-color": "#172B4D",
                  "circle-radius": 5,
                  "circle-stroke-width": 1.5,
                  "circle-stroke-color": "#fff",
                }}
              />
            </Source>

            {/* Click preview popup */}
            {popup && (
              <Popup
                longitude={popup.lng}
                latitude={popup.lat}
                anchor="bottom"
                offset={12}
                closeButton
                closeOnClick={false}
                onClose={() => setPopup(null)}
                maxWidth="320px"
                className="ppp-map-popup"
              >
                <div className="font-sans p-1 min-w-[220px]">
                  <div className="font-condensed text-[10px] uppercase tracking-wide text-ppp-charcoal-500 mb-1">
                    Work Order {popup.wo || "—"}
                  </div>
                  <div className="font-semibold text-ppp-charcoal text-sm leading-tight">
                    {popup.account}
                  </div>
                  <div className="mt-2 flex items-baseline justify-between gap-3">
                    <div className="font-condensed text-xl font-bold text-ppp-navy">
                      {fmtMoneyK(popup.amount / 1000)}
                    </div>
                    {popup.status && (
                      <span
                        className={[
                          "inline-flex items-center px-1.5 py-0 rounded text-[9px] font-semibold border",
                          popup.status.toLowerCase().includes("paid in full")
                            ? "text-ppp-green-700 bg-ppp-green-50 border-ppp-green-100"
                            : popup.status.toLowerCase().includes("cancel")
                            ? "text-ppp-charcoal-500 bg-ppp-charcoal-50 border-ppp-charcoal-100"
                            : popup.status.toLowerCase().includes("complete")
                            ? "text-ppp-green-700 bg-ppp-green-50 border-ppp-green-100"
                            : "text-ppp-blue-700 bg-ppp-blue-50 border-ppp-blue-100",
                        ].join(" ")}
                      >
                        {popup.status}
                      </span>
                    )}
                  </div>
                  {popup.rep && (
                    <div className="mt-2 pt-2 border-t border-ppp-charcoal-100 text-[11px] text-ppp-charcoal-500">
                      Sold by <span className="font-medium text-ppp-charcoal">{popup.rep}</span>
                    </div>
                  )}
                  <div className="mt-2 text-[10px] text-ppp-charcoal-400 font-mono">
                    {popup.lat.toFixed(4)}, {popup.lng.toFixed(4)}
                  </div>
                </div>
              </Popup>
            )}
          </Map>
        </div>
      </div>

      {/* State-level breakdown to complement the map */}
      <StateBreakdown geojson={geojson} />
    </div>
  );
}

function StateBreakdown({
  geojson,
}: {
  geojson: { features: Array<{ properties: { account: string; amount: number } }> };
}) {
  // Rough state inference would require reverse-geocoding which is expensive.
  // Instead, group by account name's first word as a placeholder — not ideal
  // but the map's heatmap visualization is the real value here. Real state
  // bucketing happens via Account.Region__c (already shown on /dashboard).
  return (
    <div className="bg-white border border-ppp-charcoal-100 rounded-xl p-5 sm:p-6">
      <h3 className="text-base font-semibold text-ppp-charcoal">How to read the map</h3>
      <ul className="mt-3 space-y-2 text-xs text-ppp-charcoal-500">
        <li className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ background: "rgba(220, 50, 30, 0.9)" }} />
          Hottest zones — highest revenue concentration
        </li>
        <li className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ background: "rgba(238, 102, 46, 0.7)" }} />
          High-density job activity
        </li>
        <li className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ background: "rgba(141, 196, 66, 0.5)" }} />
          Medium activity
        </li>
        <li className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ background: "rgba(43, 170, 225, 0.3)" }} />
          Edge of territory
        </li>
        <li className="mt-1 text-[10px] italic">
          Zoom in to see individual job markers · drag to pan
        </li>
      </ul>
    </div>
  );
}

function IconCalendar() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 9h18 M8 3v4 M16 3v4" />
    </svg>
  );
}
