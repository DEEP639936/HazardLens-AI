// Geospatial utilities. In this demo deployment (SQLite) spatial predicates are computed in the
// application layer with the Haversine formula. The production FastAPI service performs the same
// queries in PostGIS (ST_DWithin / ST_Distance on geography(Point,4326) with a GiST index) —
// see backend/app/services/geo.py. Results are equivalent at city scale.

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6371000;

export function haversineM(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180 &&
    !(lat === 0 && lng === 0)
  );
}

/** Rough distance-based bounding box (used to prefilter PostGIS queries in production). */
export function bboxAround(center: LatLng, radiusM: number) {
  const latDelta = radiusM / 111320;
  const lngDelta = radiusM / (111320 * Math.max(0.1, Math.cos((center.lat * Math.PI) / 180)));
  return { minLat: center.lat - latDelta, maxLat: center.lat + latDelta, minLng: center.lng - lngDelta, maxLng: center.lng + lngDelta };
}

/** Bengaluru ward atlas (approximate centers, demo resolution). Production uses reverse-geocoded admin boundaries.
 *  Pins farther than 50 km from every ward are treated as outside the pilot area (no ward assigned). */
export const WARDS: { name: string; lat: number; lng: number }[] = [
  { name: "Central Business District", lat: 12.9757, lng: 77.6068 },
  { name: "Indiranagar", lat: 12.9719, lng: 77.6412 },
  { name: "Koramangala", lat: 12.9352, lng: 77.6245 },
  { name: "Marathahalli", lat: 12.9569, lng: 77.7011 },
  { name: "Whitefield", lat: 12.9698, lng: 77.75 },
  { name: "Hebbal", lat: 13.0358, lng: 77.597 },
  { name: "Jayanagar", lat: 12.9299, lng: 77.5826 },
  { name: "Yeshwanthpur", lat: 13.0284, lng: 77.5546 },
  { name: "BTM Layout", lat: 12.9166, lng: 77.6101 },
  { name: "HSR Layout", lat: 12.9116, lng: 77.6474 },
  { name: "Rajajinagar", lat: 12.9917, lng: 77.5551 },
  { name: "Basavanagudi", lat: 12.9426, lng: 77.5744 },
  { name: "Malleshwaram", lat: 13.0035, lng: 77.5696 },
  { name: "Electronic City", lat: 12.8452, lng: 77.6602 },
  { name: "Banashankari", lat: 12.925, lng: 77.5468 },
];

const WARD_MAX_DISTANCE_M = 50_000;

export function nearestWard(p: LatLng): string | null {
  let best = WARDS[0];
  let bestD = Infinity;
  for (const w of WARDS) {
    const d = haversineM(p, w);
    if (d < bestD) {
      bestD = d;
      best = w;
    }
  }
  return bestD <= WARD_MAX_DISTANCE_M ? best.name : null;
}

/** Infer a road-class criticality hint from road naming conventions (documented heuristic). */
export function inferRoadCriticality(roadName?: string | null, roadClass?: string | null): number {
  if (roadClass && roadClass in { highway: 1, arterial: 1, collector: 1, residential: 1 }) {
    const map: Record<string, number> = { highway: 1.0, arterial: 0.8, collector: 0.6, residential: 0.4 };
    return map[roadClass];
  }
  const n = (roadName || "").toLowerCase();
  if (/ring road|highway|nh-|national|expressway|flyover/.test(n)) return 1.0;
  if (/main road|100 feet|80 feet|arterial|road junction|hosur|sarjapur|airport|bellary|old airport/.test(n)) return 0.8;
  if (/street|cross|layout|block/.test(n)) return 0.5;
  return 0.5;
}
