"use client";
// AnalyticsView — production analytics for AUTHORITY/ADMIN: real aggregates from
// /api/analytics (class distribution, risk bands, severity over time, ward hotspots,
// detection confidence). No fabricated numbers — empty states when there is no data yet.
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/rg/api";
import { BAND_META, CLASS_META } from "@/lib/rg/constants";
import type { AnalyticsDTO } from "@/lib/rg/types";
import { EmptyState, ClassChip } from "@/components/rg/primitives";
import { CardSkeleton } from "@/components/rg/primitives";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Activity, BarChart3, Gauge, Layers } from "lucide-react";

const BAND_COLORS: Record<string, string> = {
  CRITICAL: BAND_META.CRITICAL.color,
  HIGH: BAND_META.HIGH.color,
  MODERATE: BAND_META.MODERATE.color,
  LOW: BAND_META.LOW.color,
};

export function AnalyticsView() {
  const q = useQuery({
    queryKey: ["analytics"],
    queryFn: () => api<AnalyticsDTO>("/api/analytics"),
    staleTime: 30_000,
  });

  const data = q.data;

  if (q.isLoading) {
    return (
      <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-10 sm:px-6">
        <CardSkeleton lines={2} />
        <div className="grid gap-4 md:grid-cols-2">{[0, 1, 2, 3].map((i) => <div key={i} className="h-64 animate-pulse rounded-2xl bg-secondary/50" />)}</div>
      </div>
    );
  }

  if (q.isError || !data) {
    return (
      <div className="mx-auto w-full max-w-7xl px-4 py-16 sm:px-6">
        <EmptyState title="Analytics unavailable" hint="The analytics service could not be reached. Retry shortly." icon={<BarChart3 className="size-5" aria-hidden />} />
      </div>
    );
  }

  const kpis = [
    { label: "Actionable hazards", value: data.totals.hazards, icon: Layers, color: "#6A00F4" },
    { label: "Pending verification", value: data.totals.pendingReview, icon: Activity, color: "#D97706" },
    { label: "Critical risk", value: data.totals.critical, icon: Gauge, color: "#C83E4D" },
    { label: "Avg risk score", value: Math.round(data.totals.avgPriority), icon: BarChart3, color: "#168266" },
    { label: "Repairs resolved", value: data.totals.resolved, icon: Activity, color: "#0f5c49" },
    { label: "Clusters", value: data.totals.clusters, icon: Layers, color: "#8B3DFF" },
  ];

  const hasData = data.totals.hazards > 0;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:py-10">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#6A00F4]">Management</p>
        <h1 className="mt-2 font-display text-4xl tracking-tight">Analytics</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          Live aggregates over every stored hazard, detection and work order — the same numbers the risk engine and dashboards use.
        </p>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-2xl border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{k.label}</p>
              <k.icon className="size-4" style={{ color: k.color }} aria-hidden />
            </div>
            <p className="mt-1.5 font-display text-2xl font-semibold tabular-nums" style={{ color: k.color }}>{k.value}</p>
          </div>
        ))}
      </div>

      {!hasData ? (
        <div className="mt-8">
          <EmptyState title="No hazard data yet" hint="Analytics populate automatically as reports, detections and work orders accumulate." />
        </div>
      ) : (
        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          {/* by class */}
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="font-display text-lg font-semibold">Hazards by class</h2>
            <div className="mt-4 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.byClass.filter((c) => c.count > 0)} margin={{ top: 4, right: 8, left: -20, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E8E2EF" />
                  <XAxis dataKey="hazardClass" tickFormatter={(v: string) => CLASS_META[v as keyof typeof CLASS_META]?.short ?? v} tick={{ fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                  <RTooltip formatter={(v) => [v, "reports"]} labelFormatter={(v) => CLASS_META[v as keyof typeof CLASS_META]?.label ?? String(v)} />
                  <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                    {data.byClass.filter((c) => c.count > 0).map((c) => (
                      <Cell key={c.hazardClass} fill={CLASS_META[c.hazardClass]?.color ?? "#6A00F4"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* risk bands */}
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="font-display text-lg font-semibold">Risk score bands</h2>
            <div className="mt-4 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data.priorityBands.filter((b) => b.count > 0)}
                    dataKey="count"
                    nameKey="band"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={3}
                  >
                    {data.priorityBands.filter((b) => b.count > 0).map((b) => (
                      <Cell key={b.band} fill={BAND_COLORS[b.band]} />
                    ))}
                  </Pie>
                  <Legend formatter={(v) => BAND_META[v as keyof typeof BAND_META]?.label ?? String(v)} />
                  <RTooltip formatter={(v, name) => [v, BAND_META[name as keyof typeof BAND_META]?.label ?? String(name)]} />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* severity over time */}
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="font-display text-lg font-semibold">Reports & severity over time</h2>
            <div className="mt-4 h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.severityOverTime} margin={{ top: 4, right: 8, left: -20, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#E8E2EF" />
                  <XAxis dataKey="week" tick={{ fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} />
                  <YAxis yAxisId="l" allowDecimals={false} tick={{ fontSize: 11 }} />
                  <YAxis yAxisId="r" orientation="right" domain={[1, 5]} tick={{ fontSize: 11 }} />
                  <RTooltip />
                  <Line yAxisId="l" type="monotone" dataKey="count" stroke="#6A00F4" strokeWidth={2} dot={false} name="reports" />
                  <Line yAxisId="r" type="monotone" dataKey="avgSeverity" stroke="#D97706" strokeWidth={2} dot={false} name="avg severity" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* wards */}
          <section className="rounded-2xl border border-border bg-card p-5">
            <h2 className="font-display text-lg font-semibold">Ward hotspots</h2>
            <div className="mt-3 max-h-64 overflow-y-auto scrollbar-slim">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="py-2 font-semibold">Ward</th>
                    <th className="py-2 font-semibold">Reports</th>
                    <th className="py-2 font-semibold">Avg risk</th>
                    <th className="py-2 font-semibold">Critical</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {data.wards.map((w) => (
                    <tr key={w.ward}>
                      <td className="py-2 font-medium">{w.ward}</td>
                      <td className="py-2 tabular-nums">{w.count}</td>
                      <td className="py-2 tabular-nums">{Math.round(w.avgPriority)}</td>
                      <td className="py-2 tabular-nums">{w.critical}</td>
                    </tr>
                  ))}
                  {data.wards.length === 0 && (
                    <tr><td colSpan={4} className="py-6 text-center text-muted-foreground">No ward data yet</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {/* detection confidence */}
          <section className="rounded-2xl border border-border bg-card p-5 lg:col-span-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-lg font-semibold">Detection engine</h2>
              <span className="rounded-full bg-secondary px-2.5 py-0.5 text-[11px] font-medium text-secondary-foreground">
                engine: {data.confidence.engine} · model {data.confidence.modelVersion}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="rounded-xl bg-secondary/50 p-3 text-center">
                <p className="font-display text-2xl font-semibold tabular-nums">{(data.confidence.overallMean * 100).toFixed(1)}%</p>
                <p className="text-[11px] text-muted-foreground">mean confidence</p>
              </div>
              <div className="rounded-xl bg-secondary/50 p-3 text-center">
                <p className="font-display text-2xl font-semibold tabular-nums">{(data.confidence.overallMedian * 100).toFixed(1)}%</p>
                <p className="text-[11px] text-muted-foreground">median confidence</p>
              </div>
              <div className="rounded-xl bg-secondary/50 p-3 text-center">
                <p className="font-display text-2xl font-semibold tabular-nums">{data.confidence.p95LatencyMs} ms</p>
                <p className="text-[11px] text-muted-foreground">p95 latency</p>
              </div>
              <div className="rounded-xl bg-secondary/50 p-3 text-center">
                <p className="font-display text-2xl font-semibold tabular-nums">{data.confidence.byClass.reduce((a, b) => a + b.count, 0)}</p>
                <p className="text-[11px] text-muted-foreground">detections</p>
              </div>
            </div>
            <div className="mt-4 space-y-1.5">
              {data.confidence.byClass.filter((c) => c.count > 0).map((c) => (
                <div key={c.hazardClass} className="flex items-center gap-3 text-xs">
                  <span className="w-40 shrink-0"><ClassChip cls={c.hazardClass} /></span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
                    <span className="block h-full rounded-full bg-[#6A00F4]" style={{ width: `${c.meanConfidence * 100}%` }} />
                  </span>
                  <span className="w-12 text-right font-bold tabular-nums">{(c.meanConfidence * 100).toFixed(0)}%</span>
                  <span className="w-10 text-right text-muted-foreground">{c.count}×</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
