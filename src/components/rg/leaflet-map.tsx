"use client";
// Leaflet map engine — loaded via next/dynamic (ssr:false) everywhere.
// Renders hazard dots, pulsing DBSCAN cluster bubbles, optional heat layer, and a pin picker.
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { MapContainer, TileLayer, CircleMarker, Marker, Tooltip, Circle, useMap, useMapEvents } from "react-leaflet";
import { useEffect, useMemo } from "react";
import { CLASS_META, BAND_META } from "@/lib/rg/constants";
import type { ClusterDTO, HazardClass, PriorityBand } from "@/lib/rg/types";

export interface MapHazardLite {
  id: string;
  lat: number;
  lng: number;
  hazardClass: HazardClass;
  severity: number;
  band: PriorityBand | null;
  referenceCode: string;
}

export interface LeafletMapProps {
  hazards: MapHazardLite[];
  clusters: ClusterDTO[];
  heat?: boolean;
  center?: [number, number];
  zoom?: number;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  pickMode?: boolean;
  pin?: { lat: number; lng: number } | null;
  onPin?: (p: { lat: number; lng: number }) => void;
  className?: string;
}

function bandColor(band: PriorityBand | null): string {
  return band ? BAND_META[band].color : "#655D73";
}

function FlyTo({ selectedId, hazards }: { selectedId?: string | null; hazards: MapHazardLite[] }) {
  const map = useMap();
  useEffect(() => {
    if (!selectedId) return;
    const h = hazards.find((x) => x.id === selectedId);
    if (h) map.flyTo([h.lat, h.lng], Math.max(map.getZoom(), 16), { duration: 0.7 });
  }, [selectedId, hazards, map]);
  return null;
}

/** Auto-fit the viewport around every hazard when the dataset changes — guarantees a
 *  freshly reported hazard is visible at its exact pin location, no matter where in
 *  the world it was placed. Callers must pass a memoized hazards array. */
function FitToHazards({ hazards }: { hazards: MapHazardLite[] }) {
  const map = useMap();
  useEffect(() => {
    if (hazards.length === 0) return;
    if (hazards.length === 1) {
      map.setView([hazards[0].lat, hazards[0].lng], Math.max(map.getZoom(), 15), { animate: true });
    } else {
      const bounds = L.latLngBounds(hazards.map((h) => [h.lat, h.lng] as [number, number]));
      map.flyToBounds(bounds, { padding: [56, 56], maxZoom: 17, duration: 0.6 });
    }
  }, [hazards, map]);
  return null;
}

function ClickHandler({ pickMode, onPin }: { pickMode?: boolean; onPin?: (p: { lat: number; lng: number }) => void }) {
  useMapEvents({
    click(e) {
      if (pickMode && onPin) onPin({ lat: e.latlng.lat, lng: e.latlng.lng });
    },
  });
  return null;
}

function InvalidateOnResize() {
  const map = useMap();
  useEffect(() => {
    const t = setTimeout(() => map.invalidateSize(), 120);
    const onResize = () => map.invalidateSize();
    window.addEventListener("resize", onResize);
    return () => {
      clearTimeout(t);
      window.removeEventListener("resize", onResize);
    };
  }, [map]);
  return null;
}

const pinIcon = L.divIcon({
  className: "",
  html: `<div style="transform:translate(-50%,-100%)"><svg width="30" height="38" viewBox="0 0 30 38" fill="none"><path d="M15 1C7.8 1 2 6.8 2 14c0 9.6 13 23 13 23s13-13.4 13-23C28 6.8 22.2 1 15 1z" fill="#6A00F4" stroke="white" stroke-width="2"/><circle cx="15" cy="14" r="5" fill="white"/></svg></div>`,
  iconSize: [0, 0],
});

export default function LeafletMap({
  hazards,
  clusters,
  heat = false,
  center = [12.9629, 77.6389],
  zoom = 11,
  selectedId,
  onSelect,
  pickMode = false,
  pin,
  onPin,
  className,
}: LeafletMapProps) {
  const maxCount = useMemo(() => Math.max(1, ...clusters.map((c) => c.hazardCount)), [clusters]);

  return (
    <MapContainer
      center={center}
      zoom={zoom}
      scrollWheelZoom
      className={className}
      style={{ width: "100%", height: "100%", zIndex: 0 }}
      attributionControl
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      <InvalidateOnResize />
      <FlyTo selectedId={selectedId} hazards={hazards} />
      {!pickMode && <FitToHazards hazards={hazards} />}
      <ClickHandler pickMode={pickMode} onPin={onPin} />

      {heat &&
        clusters.map((c) => (
          <Circle
            key={`heat-${c.id}`}
            center={[c.centerLat, c.centerLng]}
            radius={Math.max(80, c.radiusM * 2.2)}
            pathOptions={{ color: CLASS_META[(c.dominantClass as HazardClass) ?? "pothole"]?.color ?? "#6A00F4", fillColor: CLASS_META[(c.dominantClass as HazardClass) ?? "pothole"]?.color ?? "#6A00F4", fillOpacity: 0.18, weight: 0.5, opacity: 0.35 }}
          />
        ))}

      {clusters.map((c) => {
        const size = 34 + Math.round((c.hazardCount / maxCount) * 22);
        const color = CLASS_META[(c.dominantClass as HazardClass) ?? "pothole"]?.color ?? "#6A00F4";
        const icon = L.divIcon({
          className: "",
          html: `<div class="rg-cluster-marker rg-pulse-dot" style="width:${size}px;height:${size}px;background:${color};font-size:${size > 44 ? 15 : 13}px">${c.hazardCount}</div>`,
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        });
        return (
          <Marker
            key={c.id}
            position={[c.centerLat, c.centerLng]}
            icon={icon}
            eventHandlers={{ click: () => onSelect?.(c.id) }}
          >
            <Tooltip direction="top" offset={[0, -size / 2]}>
              <span className="text-xs font-semibold">{c.label}</span>
              <br />
              <span className="text-[11px]">
                {c.hazardCount} hazards · avg severity {c.avgSeverity.toFixed(1)} · r≈{Math.round(c.radiusM)}m
              </span>
            </Tooltip>
          </Marker>
        );
      })}

      {hazards.map((h) => (
        <CircleMarker
          key={h.id}
          center={[h.lat, h.lng]}
          radius={h.id === selectedId ? 9 : 6.5}
          pathOptions={{
            color: "#ffffff",
            weight: 2,
            fillColor: bandColor(h.band),
            fillOpacity: 0.92,
          }}
          eventHandlers={{ click: () => onSelect?.(h.id) }}
        >
          <Tooltip direction="top" offset={[0, -6]}>
            <span className="text-xs font-semibold">{h.referenceCode}</span>{" "}
            <span className="text-[11px]">
              · {CLASS_META[h.hazardClass]?.short} · sev {h.severity}/5
            </span>
          </Tooltip>
        </CircleMarker>
      ))}

      {pickMode && pin && (
        <Marker position={[pin.lat, pin.lng]} icon={pinIcon} />
      )}
    </MapContainer>
  );
}
