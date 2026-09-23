// /api/geocode — forward (q) and reverse (lat/lng) geocoding proxy.
// Uses OpenStreetMap Nominatim with a proper User-Agent, 3.5s timeout, graceful offline fallback.
// Responses are cached in-memory for 24h (bounded).
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const cache = new Map<string, { at: number; data: unknown }>();
const TTL = 24 * 3600_000;

function cacheGet(key: string): unknown | null {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  cache.delete(key);
  return null;
}

async function nominatim(path: string, params: Record<string, string>): Promise<unknown | null> {
  const url = new URL(`https://nominatim.openstreetmap.org/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "HazardLensAI/1.0 (civic road-maintenance demo)", Accept: "application/json" },
      signal: AbortSignal.timeout(3500),
    });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const q = sp.get("q");
  const lat = sp.get("lat");
  const lng = sp.get("lng");

  if (q) {
    const key = `f:${q.toLowerCase()}`;
    const cached = cacheGet(key);
    if (cached) return NextResponse.json({ results: cached });
    const data = (await nominatim("search", { q, format: "jsonv2", limit: "5", addressdetails: "1" })) as
      | { lat: string; lon: string; display_name: string; type?: string }[]
      | null;
    const results = (data ?? []).map((r) => ({
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      label: r.display_name,
    }));
    cache.set(key, { at: Date.now(), data: results });
    return NextResponse.json({ results, offline: data === null });
  }

  if (lat && lng) {
    const la = Number(lat);
    const lo = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(lo)) {
      return NextResponse.json({ error: "lat and lng must be numbers" }, { status: 400 });
    }
    const key = `r:${la.toFixed(5)},${lo.toFixed(5)}`;
    const cached = cacheGet(key);
    if (cached) return NextResponse.json({ address: cached });
    const data = (await nominatim("reverse", { lat: String(la), lon: String(lo), format: "jsonv2", zoom: "17" })) as
      | { display_name?: string; address?: Record<string, string> }
      | null;
    const address = {
      label: data?.display_name ?? null,
      suburb: data?.address?.suburb ?? data?.address?.neighbourhood ?? null,
      road: data?.address?.road ?? null,
    };
    cache.set(key, { at: Date.now(), data: address });
    return NextResponse.json({ address, offline: data === null });
  }

  return NextResponse.json({ error: "Provide ?q= (search) or ?lat=&lng= (reverse)" }, { status: 400 });
}
