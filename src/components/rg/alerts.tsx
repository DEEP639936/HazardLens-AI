"use client";
// HazardAlerts — member-facing feed of active hazards ordered by risk score.
// Citizens browse what's dangerous around them; each card opens the shared explainable
// detail sheet (AI confidence / risk / severity / why-this-score / community reports).
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/rg/api";
import { useApp } from "@/lib/rg/store";
import { BAND_META, CLASS_META } from "@/lib/rg/constants";
import type { HazardClass, MapResponse, PriorityBand } from "@/lib/rg/types";
import { EmptyState, SeverityDots } from "@/components/rg/primitives";
import { AiConfidenceChip, HazardDetailSheet, RiskChip, SeverityBadge } from "@/components/rg/hazard-detail";
import { fmtRelative } from "@/lib/rg/format";
import { Button } from "@/components/ui/button";
import { ClassChip } from "@/components/rg/primitives";
import { Flame, MapPin, Siren } from "lucide-react";
import { cn } from "@/lib/utils";

export function HazardAlerts() {
  const { setView } = useApp();
  const [classFilter, setClassFilter] = useState<HazardClass | "all">("all");
  const [bandFilter, setBandFilter] = useState<PriorityBand | "all">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["alerts-map"],
    queryFn: () => api<MapResponse>("/api/map?limit=500"),
    staleTime: 30_000,
  });

  const hazards = data?.hazards ?? [];
  const filtered = useMemo(
    () =>
      hazards
        .filter((h) => (classFilter === "all" || h.hazardClass === classFilter) && (bandFilter === "all" || h.priority?.band === bandFilter))
        .sort((a, b) => (b.priority?.score ?? 0) - (a.priority?.score ?? 0)),
    [hazards, classFilter, bandFilter]
  );

  const criticalCount = hazards.filter((h) => h.priority?.band === "CRITICAL").length;
  const highCount = hazards.filter((h) => h.priority?.band === "HIGH").length;
  const selected = selectedId ? hazards.find((h) => h.id === selectedId) ?? null : null;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#6A00F4]">Explore</p>
          <h1 className="mt-2 font-display text-4xl tracking-tight">Hazard Alerts</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            Active hazards ranked by the risk engine. Critical and high-risk locations deserve extra caution — tap any card for the full picture.
          </p>
        </div>
        <div className="flex gap-2">
          <div className="rounded-xl border border-[#C83E4D]/30 bg-[#C83E4D]/[0.06] px-4 py-3 text-center">
            <p className="font-display text-2xl font-semibold tabular-nums text-[#C83E4D]">{isLoading ? "—" : criticalCount}</p>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Critical</p>
          </div>
          <div className="rounded-xl border border-[#D97706]/30 bg-[#D97706]/[0.06] px-4 py-3 text-center">
            <p className="font-display text-2xl font-semibold tabular-nums text-[#D97706]">{isLoading ? "—" : highCount}</p>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">High risk</p>
          </div>
        </div>
      </div>

      {/* filters */}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setClassFilter("all")}
          className={cn("rounded-full border px-3 py-1 text-xs font-medium transition-colors", classFilter === "all" ? "border-[#6A00F4] bg-[#6A00F4] text-white" : "border-border bg-card text-muted-foreground hover:border-[#6A00F4]/40")}
        >
          All types
        </button>
        {(Object.keys(CLASS_META) as HazardClass[]).map((c) => (
          <button
            key={c}
            onClick={() => setClassFilter(classFilter === c ? "all" : c)}
            aria-pressed={classFilter === c}
            className={cn("rounded-full border px-3 py-1 text-xs font-medium transition-colors", classFilter === c ? CLASS_META[c].chip : "border-border bg-card text-muted-foreground hover:border-[#6A00F4]/40")}
          >
            {CLASS_META[c].short}
          </button>
        ))}
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        <button
          onClick={() => setBandFilter("all")}
          className={cn("rounded-full border px-3 py-1 text-xs font-semibold transition-colors", bandFilter === "all" ? "border-[#6A00F4] bg-[#6A00F4] text-white" : "border-border bg-card text-muted-foreground")}
        >
          Any risk
        </button>
        {(Object.keys(BAND_META) as PriorityBand[]).map((b) => (
          <button
            key={b}
            onClick={() => setBandFilter(bandFilter === b ? "all" : b)}
            aria-pressed={bandFilter === b}
            className={cn("rounded-full border px-3 py-1 text-xs font-semibold transition-colors", bandFilter === b ? BAND_META[b].chip : "border-border bg-card text-muted-foreground")}
          >
            {BAND_META[b].label}
          </button>
        ))}
      </div>

      {isError ? (
        <div className="mt-6">
          <EmptyState title="Alerts could not be loaded" hint="The service is temporarily unavailable — try again shortly." icon={<Flame className="size-5" aria-hidden />} />
          <div className="mt-3 text-center">
            <Button variant="outline" className="border-border" onClick={() => void refetch()}>Retry</Button>
          </div>
        </div>
      ) : isLoading ? (
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-44 animate-pulse rounded-2xl bg-secondary/50" />)}
        </div>
      ) : filtered.length === 0 ? (
        <div className="mt-6">
          <EmptyState
            title="No hazards match these filters"
            hint="Try widening the risk band or clearing the type filter."
            icon={<Siren className="size-5" aria-hidden />}
          />
        </div>
      ) : (
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((h) => {
            const band = h.priority ? BAND_META[h.priority.band] : null;
            return (
              <button
                key={h.id}
                onClick={() => setSelectedId(h.id)}
                className="group flex flex-col rounded-2xl border border-border bg-card p-4 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-[#6A00F4]/40 hover:shadow-[0_14px_30px_-16px_rgba(106,0,244,0.4)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] font-semibold text-[#6A00F4]">{h.referenceCode}</span>
                  <RiskChip hazard={h} />
                </div>
                <p className="mt-1.5 truncate text-sm font-bold">{h.roadName ?? h.address ?? "Unnamed location"}</p>
                <p className="text-xs text-muted-foreground">{h.ward ?? "—"} · {fmtRelative(h.createdAt)}</p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <ClassChip cls={h.hazardClass} />
                  <SeverityBadge band={h.severityBand} />
                  <AiConfidenceChip hazard={h} />
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-border pt-2.5 text-xs">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <SeverityDots severity={h.severity} />
                    {h.reportCount > 1 && <span className="font-semibold text-[#0f5c49]">· {h.reportCount} reports</span>}
                  </span>
                  {band && (
                    <span className="inline-flex items-center gap-1 font-bold" style={{ color: band.color }}>
                      <MapPin className="size-3" aria-hidden /> {band.action}
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-6 text-center">
        <Button variant="outline" className="border-border" onClick={() => setView("map")}>
          <MapPin className="size-4" aria-hidden /> Open these on the live map
        </Button>
      </div>

      <HazardDetailSheet hazard={selected} onClose={() => setSelectedId(null)} />
    </div>
  );
}
