"use client";
// Public hazard map: filters, cluster map, split list, detail drawer with explainable priority.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/rg/api";
import { useApp } from "@/lib/rg/store";
import { dynamicImport } from "@/lib/rg/lazy";
import { ACTIONABLE_STATUSES, BAND_META, CLASS_META, HAZARD_CLASSES, SEVERITY_BANDS, STATUS_META } from "@/lib/rg/constants";
import type { HazardClass, MapResponse, PriorityBand, ReportStatus, SeverityBand } from "@/lib/rg/types";
import { BandBadge, ClassChip, EmptyState, SeverityDots } from "@/components/rg/primitives";
import { HazardDetailSheet } from "@/components/rg/hazard-detail";
import { fmtRelative } from "@/lib/rg/format";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Filter, Flame, MapPin, RotateCcw, X } from "lucide-react";
import { cn } from "@/lib/utils";

const LeafletMap = dynamicImport(() => import("@/components/rg/leaflet-map"));

const DEFAULT_FILTERS = {
  classes: [] as HazardClass[],
  severityMin: 1,
  severityMax: 5,
  statuses: [...ACTIONABLE_STATUSES] as ReportStatus[],
  bands: [] as PriorityBand[],
  from: "",
  to: "",
};

function buildQuery(f: typeof DEFAULT_FILTERS): string {
  const sp = new URLSearchParams();
  sp.set("limit", "500");
  if (f.classes.length) sp.set("classes", f.classes.join(","));
  if (f.severityMin > 1) sp.set("severityMin", String(f.severityMin));
  if (f.severityMax < 5) sp.set("severityMax", String(f.severityMax));
  if (f.statuses.length && f.statuses.length !== DEFAULT_FILTERS.statuses.length) sp.set("statuses", f.statuses.join(","));
  if (f.bands.length) sp.set("bands", f.bands.join(","));
  if (f.from) sp.set("from", f.from);
  if (f.to) sp.set("to", f.to);
  return sp.toString();
}

export function MapView() {
  const { setView, user } = useApp();
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [heat, setHeat] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [mobileFilters, setMobileFilters] = useState(false);
  const query = useMemo(() => buildQuery(filters), [filters]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["map", query],
    queryFn: () => api<MapResponse>(`/api/map?${query}`),
    staleTime: 30_000,
  });

  const hazards = data?.hazards ?? [];
  const clusters = data?.clusters ?? [];
  // memoized so LeafletMap's auto-fit effect only fires when the underlying data changes
  const mapHazards = useMemo(
    () =>
      hazards.map((h) => ({ id: h.id, lat: h.lat, lng: h.lng, hazardClass: h.hazardClass, severity: h.severity, band: h.priority?.band ?? null, referenceCode: h.referenceCode })),
    [hazards]
  );
  const sorted = useMemo(
    () => [...hazards].sort((a, b) => (b.priority?.score ?? 0) - (a.priority?.score ?? 0)),
    [hazards]
  );
  const active = selected ? hazards.find((h) => h.id === selected || h.clusterId === selected) ?? null : null;

  const toggleClass = (c: HazardClass) =>
    setFilters((f) => ({ ...f, classes: f.classes.includes(c) ? f.classes.filter((x) => x !== c) : [...f.classes, c] }));
  const toggleBand = (b: PriorityBand) =>
    setFilters((f) => ({ ...f, bands: f.bands.includes(b) ? f.bands.filter((x) => x !== b) : [...f.bands, b] }));
  const toggleStatus = (s: ReportStatus) =>
    setFilters((f) => ({
      ...f,
      statuses: f.statuses.includes(s) ? f.statuses.filter((x) => x !== s) : [...f.statuses, s],
    }));

  const filtersPanel = (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="inline-flex items-center gap-2 text-sm font-bold uppercase tracking-[0.16em] text-muted-foreground">
          <Filter className="size-4" aria-hidden /> Filters
        </h2>
        <button
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-[#6A00F4]"
          onClick={() => setFilters(DEFAULT_FILTERS)}
        >
          <RotateCcw className="size-3" aria-hidden /> Reset
        </button>
      </div>

      <div>
        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Hazard class</Label>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {HAZARD_CLASSES.map((c) => (
            <button
              key={c}
              onClick={() => toggleClass(c)}
              aria-pressed={filters.classes.includes(c)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                filters.classes.includes(c)
                  ? CLASS_META[c].chip
                  : "border-border bg-card text-muted-foreground hover:border-[#6A00F4]/40"
              )}
            >
              {CLASS_META[c].short}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Min severity (1–5)</Label>
          <Select value={String(filters.severityMin)} onValueChange={(v) => setFilters((f) => ({ ...f, severityMin: Number(v) }))}>
            <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
            <SelectContent>{[1, 2, 3, 4, 5].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Max severity</Label>
          <Select value={String(filters.severityMax)} onValueChange={(v) => setFilters((f) => ({ ...f, severityMax: Number(v) }))}>
            <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
            <SelectContent>{[1, 2, 3, 4, 5].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Lifecycle status</Label>
        <div className="mt-2 grid grid-cols-1 gap-1.5">
          {ACTIONABLE_STATUSES.map((s) => (
            <label key={s} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={filters.statuses.includes(s)}
                onChange={() => toggleStatus(s)}
                className="size-4 rounded border-input accent-[#6A00F4]"
              />
              {STATUS_META[s].label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Priority band</Label>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(Object.keys(BAND_META) as PriorityBand[]).map((b) => (
            <button
              key={b}
              onClick={() => toggleBand(b)}
              aria-pressed={filters.bands.includes(b)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors",
                filters.bands.includes(b) ? BAND_META[b].chip : "border-border bg-card text-muted-foreground hover:border-[#6A00F4]/40"
              )}
            >
              {BAND_META[b].label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">From</Label>
          <Input type="date" className="mt-1.5" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} />
        </div>
        <div>
          <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">To</Label>
          <Input type="date" className="mt-1.5" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} />
        </div>
      </div>

      <Separator />
      <div className="flex items-center justify-between">
        <label htmlFor="heat-toggle" className="inline-flex items-center gap-2 text-sm font-medium">
          <Flame className="size-4 text-[#D97706]" aria-hidden /> Heat map
        </label>
        <Switch id="heat-toggle" checked={heat} onCheckedChange={setHeat} />
      </div>

      <div>
        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Legend</Label>
        <div className="mt-2 space-y-1.5">
          {(Object.keys(BAND_META) as PriorityBand[]).map((b) => (
            <div key={b} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="size-3 rounded-full border-2 border-white shadow" style={{ background: BAND_META[b].color }} />
              {BAND_META[b].label} — {BAND_META[b].action}
            </div>
          ))}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex size-4 items-center justify-center rounded-full bg-[#6A00F4] text-[9px] font-bold text-white">n</span>
            cluster bubble (count = grouped reports)
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-4xl tracking-tight">Live hazard map</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {isLoading ? "Loading hazards…" : `${hazards.length} hazards · ${clusters.length} clusters · updated ${data ? fmtRelative(data.computedAt) : "—"}`}
          </p>
        </div>
        <Button variant="outline" className="border-border lg:hidden" onClick={() => setMobileFilters((v) => !v)}>
          <Filter className="size-4" aria-hidden /> {mobileFilters ? "Hide" : "Show"} filters
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[300px_1fr]">
        <aside className={cn("space-y-6", mobileFilters ? "block" : "hidden lg:block")}>
          <div className="rounded-2xl border border-border bg-card p-5">{filtersPanel}</div>
        </aside>

        <div className="space-y-4">
          <div className="h-[62vh] min-h-[420px] overflow-hidden rounded-2xl border border-border bg-card shadow-sm lg:h-[72vh]">
            {isError ? (
              <EmptyState title="Map data unavailable" hint="The service could not load hazard data. Retry shortly." />
            ) : isLoading ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Rendering map…</div>
            ) : (
              <LeafletMap
                hazards={mapHazards}
                clusters={clusters}
                heat={heat}
                selectedId={selected}
                onSelect={setSelected}
                className="h-full w-full"
              />
            )}
          </div>

          <div className="rounded-2xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Priority-ordered list</h2>
              <span className="text-xs text-muted-foreground">{sorted.length} items</span>
            </div>
            <ScrollArea className="h-64 scrollbar-slim">
              <ul className="divide-y divide-border">
                {sorted.slice(0, 60).map((h) => (
                  <li key={h.id}>
                    <button
                      onClick={() => setSelected(h.id)}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary",
                        selected === h.id && "bg-[#6A00F4]/[0.06]"
                      )}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold tracking-wide text-[#6A00F4]">{h.referenceCode}</span>
                          <ClassChip cls={h.hazardClass} />
                        </div>
                        <p className="mt-1 truncate text-xs text-muted-foreground">
                          {h.ward ?? "Unknown ward"} · {fmtRelative(h.createdAt)}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3">
                        <SeverityDots severity={h.severity} />
                        {h.priority && <span className="text-sm font-bold tabular-nums" style={{ color: BAND_META[h.priority.band].color }}>{Math.round(h.priority.score)}</span>}
                      </div>
                    </button>
                  </li>
                ))}
                {sorted.length === 0 && !isLoading && (
                  <li className="p-6">
                    <EmptyState title="No hazards match these filters" hint="Try widening severity or clearing the class selection." />
                  </li>
                )}
              </ul>
            </ScrollArea>
          </div>
        </div>
      </div>

      {/* -------- detail drawer (shared explainable panel) -------- */}
      <HazardDetailSheet
        hazard={active}
        onClose={() => setSelected(null)}
        actions={
          active && active.status !== "VERIFIED" ? (
            <Button className="w-full bg-[#6A00F4] hover:bg-[#5a00d1]" onClick={() => setView("report")}>
              Spotted it too? Add a report
            </Button>
          ) : null
        }
      />
    </div>
  );
}

export function MapViewToggler() {
  return <X className="size-4" aria-hidden />;
}
