// DBSCAN over geographic points (Haversine metric). Matches the reference implementation in
// backend/app/services/clustering.py, which optionally delegates to PostGIS-assisted neighbor
// prefiltering for very large datasets. Complexity here is O(n²) — appropriate for city-scale
// demo workloads (thousands of points).
import { haversineM, type LatLng } from "./geo";

export type ClusterLabel = number; // -1 = noise

export function dbscan(
  points: LatLng[],
  epsM = 60,
  minPts = 3
): ClusterLabel[] {
  const n = points.length;
  const labels: ClusterLabel[] = new Array(n).fill(-2); // -2 unvisited, -1 noise
  if (n === 0) return labels;

  const neighbors: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    neighbors[i] = [];
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (haversineM(points[i], points[j]) <= epsM) neighbors[i].push(j);
    }
  }

  let c = 0;
  for (let i = 0; i < n; i++) {
    if (labels[i] !== -2) continue;
    if (neighbors[i].length + 1 < minPts) {
      labels[i] = -1;
      continue;
    }
    labels[i] = c;
    const queue = [...neighbors[i]];
    const seen = new Set<number>(queue);
    while (queue.length > 0) {
      const j = queue.shift()!;
      if (labels[j] === -1) labels[j] = c; // noise → border point
      if (labels[j] !== -2) continue;
      labels[j] = c;
      if (neighbors[j].length + 1 >= minPts) {
        for (const k of neighbors[j]) {
          if (!seen.has(k)) {
            seen.add(k);
            queue.push(k);
          }
        }
      }
    }
    c++;
  }
  return labels;
}

export interface ClusterSummary {
  memberIndexes: number[];
  centerLat: number;
  centerLng: number;
  radiusM: number;
}

export function summarizeClusters(points: LatLng[], labels: ClusterLabel[]): ClusterSummary[] {
  const out: ClusterSummary[] = [];
  const byCluster = new Map<number, number[]>();
  labels.forEach((l, i) => {
    if (l >= 0) {
      if (!byCluster.has(l)) byCluster.set(l, []);
      byCluster.get(l)!.push(i);
    }
  });
  for (const [, idxs] of byCluster) {
    const centerLat = idxs.reduce((s, i) => s + points[i].lat, 0) / idxs.length;
    const centerLng = idxs.reduce((s, i) => s + points[i].lng, 0) / idxs.length;
    const radiusM = Math.max(
      ...idxs.map((i) => haversineM({ lat: centerLat, lng: centerLng }, points[i]))
    );
    out.push({ memberIndexes: idxs, centerLat, centerLng, radiusM });
  }
  return out;
}
