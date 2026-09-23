"use client";
// Dashboard — the first screen after sign-in, shaped by role.
//   Citizens: network stats, highest-priority hazards, docs library.
//   Administrators: work-queue KPIs, needs-assignment triage, recent completions.
import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { useApp } from "@/lib/rg/store";
import { api } from "@/lib/rg/api";
import { BAND_META, CLASS_META } from "@/lib/rg/constants";
import { CountUp, SeverityDots, usePrefersReducedMotion } from "@/components/rg/primitives";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { MapResponse, WorkOrderDTO } from "@/lib/rg/types";
import {
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  HardHat,
  Loader2,
  Map as MapIcon,
  ShieldCheck,
  ShieldEllipsis,
  Siren,
} from "lucide-react";

function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/* ------------------------------------------------------------------ */
/* Administrator dashboard                                             */
/* ------------------------------------------------------------------ */
function AdminDashboard() {
  const { user, setView } = useApp();
  const reduced = !usePrefersReducedMotion();

  const mapQ = useQuery({
    queryKey: ["admin-dashboard-map"],
    queryFn: () => api<MapResponse>("/api/map?limit=500"),
    staleTime: 30_000,
  });
  const ordersQ = useQuery({
    queryKey: ["admin-dashboard"],
    queryFn: () => api<{ items: WorkOrderDTO[] }>("/api/work-orders"),
    staleTime: 15_000,
  });

  const orders = ordersQ.data?.items ?? [];
  const byStatus = (s: WorkOrderDTO["status"]) => orders.filter((o) => o.status === s);
  const inStatuses = (list: WorkOrderDTO["status"][]) => orders.filter((o) => list.includes(o.status));
  const queueIds = new Set(orders.map((o) => o.hazardReportId).filter(Boolean) as string[]);
  const openOrders = new Set(orders.filter((o) => o.status === "OPEN").map((o) => o.hazardReportId).filter(Boolean) as string[]);
  const unassigned = (mapQ.data?.hazards ?? [])
    .filter((h) => h.status !== "REJECTED" && h.status !== "MERGED" && (!queueIds.has(h.id) && !h.workOrderStatus || openOrders.has(h.id)))
    .sort((a, b) => (b.priority?.score ?? 0) - (a.priority?.score ?? 0));
  const inFlight = byStatus("ASSIGNED").length + byStatus("IN_PROGRESS").length;
  const criticalWaiting = unassigned.filter((h) => h.priority?.band === "CRITICAL" || h.priority?.band === "HIGH").length;
  const awaitingVerification = inStatuses(["COMPLETED", "VERIFICATION_PENDING"]).length;

  const kpis = [
    { label: "Needs assignment", value: unassigned.length, sub: "reports + open orders", color: "#655D73" },
    { label: "Active work orders", value: inFlight, sub: "assigned + in progress", color: "#6A00F4" },
    { label: "Awaiting verification", value: awaitingVerification, sub: "evidence under your review", color: "#B45309" },
    { label: "Problems resolved", value: inStatuses(["VERIFIED", "CLOSED"]).length, sub: "verified & closed by you", color: "#168266" },
  ];

  const recentDone = [...inStatuses(["VERIFIED", "CLOSED"])].slice(0, 5);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:py-10">
      {/* greeting */}
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            {greeting()}{user ? `, ${user.name.split(" ")[0]}` : ""}.
          </h1>
          {user && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#6A00F4] px-3 py-1 text-xs font-bold text-white">
              <ShieldEllipsis className="size-3.5" aria-hidden /> Administrator
            </span>
          )}
        </div>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          This is your ops desk — triage the queue, assign crews and close out repairs from the Work Management board.
        </p>
      </motion.div>

      {/* KPIs */}
      <section aria-label="Operations statistics" className="mt-8 rounded-2xl border border-border bg-card/60 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">Pothole work — right now</h2>
          <div className="flex flex-wrap gap-2">
            {awaitingVerification > 0 && (
              <Button size="sm" className="bg-[#B45309] hover:bg-[#93440a]" onClick={() => setView("verify")}>
                <ShieldCheck className="size-4" aria-hidden /> Verify {awaitingVerification === 1 ? "1 resolution" : `${awaitingVerification} resolutions`}
              </Button>
            )}
            <Button size="sm" className="bg-[#6A00F4] hover:bg-[#5a00d1]" onClick={() => setView("work")}>
              <ClipboardList className="size-4" aria-hidden /> Open Work Management
            </Button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {(mapQ.isLoading || ordersQ.isLoading)
            ? kpis.map((s) => (
                <div key={s.label} className="border-l-2 border-[#6A00F4]/25 pl-4">
                  <Skeleton className="h-9 w-20" />
                  <Skeleton className="mt-2 h-4 w-36" />
                </div>
              ))
            : kpis.map((s, i) => (
                <motion.div
                  key={s.label}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: reduced ? 0 : 0.05 * i }}
                  className="border-l-2 pl-4"
                  style={{ borderColor: `${s.color}40` }}
                >
                  <p className="font-display text-3xl font-semibold" style={{ color: s.color }}>
                    <CountUp to={s.value} />
                  </p>
                  <p className="mt-1 text-sm font-medium">{s.label}</p>
                  <p className="text-[11px] text-muted-foreground">{s.sub}</p>
                </motion.div>
              ))}
        </div>
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        {/* needs assignment */}
        <section aria-label="Hazards needing assignment" className="rounded-2xl border border-border bg-card p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-lg font-semibold">Needs assignment</h2>
            <span className="text-xs text-muted-foreground">sorted by priority score</span>
          </div>
          {(mapQ.isLoading || ordersQ.isLoading) ? (
            <div className="mt-4 space-y-2.5">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
            </div>
          ) : unassigned.length === 0 ? (
            <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
              Queue is clear — every reported hazard has a work order.
            </p>
          ) : (
            <ul className="mt-4 max-h-96 space-y-2.5 overflow-y-auto pr-1 scrollbar-slim">
              {unassigned.slice(0, 8).map((h) => {
                const cls = CLASS_META[h.hazardClass];
                const band = h.priority ? BAND_META[h.priority.band] : null;
                return (
                  <li key={h.id}>
                    <button
                      onClick={() => setView("work")}
                      className="flex w-full items-center gap-3 rounded-xl border border-border bg-background px-3.5 py-3 text-left transition-colors hover:border-[#6A00F4]/40 hover:bg-secondary/60"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold text-white" style={{ background: cls.color }} aria-hidden>
                        {cls.short.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold">{h.roadName ?? h.address ?? h.referenceCode}</span>
                          <span className="shrink-0 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{h.referenceCode}</span>
                        </span>
                        <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                          {cls.label} · {h.ward ?? "—"} <SeverityDots severity={h.severity} />
                        </span>
                      </span>
                      {band && (
                        <span className="shrink-0 text-right">
                          <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${band.chip}`}>{band.label}</span>
                          <span className="block font-display text-base font-semibold">
                            {h.priority?.score}<span className="text-[10px] font-normal text-muted-foreground">/100</span>
                          </span>
                        </span>
                      )}
                      <span className="hidden shrink-0 items-center gap-1 rounded-lg bg-[#6A00F4] px-2.5 py-1.5 text-[11px] font-bold text-white sm:flex">
                        <HardHat className="size-3.5" aria-hidden /> Assign
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* recently resolved problems + library */}
        <section aria-label="Recently resolved problems" className="space-y-4">
          <div className="rounded-2xl border border-border bg-card p-5">
            <h2 className="flex items-center gap-2 font-display text-base font-semibold">
              <CheckCircle2 className="size-4 text-[#168266]" aria-hidden /> Recently resolved problems
            </h2>
            {ordersQ.isLoading ? (
              <Skeleton className="mt-3 h-16 w-full rounded-xl" />
            ) : recentDone.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No problems resolved yet — verify a submitted repair in Resolution Verification and it lands here.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {recentDone.map((o) => (
                  <li key={o.id} className="rounded-lg border border-border bg-background px-3 py-2">
                    <p className="truncate text-sm font-medium">{o.hazard?.roadName ?? o.hazard?.address ?? o.title}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {o.code} · {o.assignedTo ? `crew ${o.assignedTo}` : "crew n/a"} · {o.verifiedAt ? `verified ${new Date(o.verifiedAt).toLocaleDateString()}` : o.updates[0]?.createdAt ? new Date(o.updates[0].createdAt).toLocaleDateString() : "recently"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button
            onClick={() => setView("docs")}
            className="group flex w-full items-start gap-4 rounded-2xl border border-border bg-card p-5 text-left shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_16px_36px_-18px_rgba(106,0,244,0.3)]"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#6A00F4]/10 text-[#6A00F4] transition-colors group-hover:bg-[#6A00F4] group-hover:text-white">
              <BookOpen className="size-5" aria-hidden />
            </span>
            <span>
              <span className="flex items-center gap-1.5 font-display text-base font-semibold">
                Documentation hub <ArrowRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
              </span>
              <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
                System & model cards, admin and user guides, API reference with the full OpenAPI spec.
              </span>
            </span>
          </button>

          <Card className="border-[#FFD6A5] bg-[#FFD6A5]/25">
            <CardContent className="p-5">
              <p className="text-sm font-semibold text-[#4a2c05]">Priority formula, in plain sight</p>
              <p className="mt-1.5 text-xs leading-relaxed text-[#4a2c05]/85">
                32% severity · 24% cluster density · 18% road criticality · 14% recurrence · 12% unresolved age — every band on the queue is traceable factor by factor.
              </p>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Citizen dashboard                                                   */
/* ------------------------------------------------------------------ */
function CitizenDashboard() {
  const { user, setView } = useApp();
  const reduced = !usePrefersReducedMotion();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["app-home-map"],
    queryFn: () => api<MapResponse>("/api/map?limit=500"),
    staleTime: 30_000,
  });

  const hazards = data?.hazards ?? [];
  const active = hazards.filter((h) => h.status !== "REJECTED" && h.status !== "MERGED");
  const urgent = active.filter((h) => h.priority?.band === "CRITICAL" || h.priority?.band === "HIGH");
  const resolved = hazards.filter((h) => h.workOrderStatus === "VERIFIED" || h.workOrderStatus === "CLOSED").length;
  const clusters = data?.clusters ?? [];
  const topHazards = [...active]
    .filter((h) => h.priority)
    .sort((a, b) => (b.priority?.score ?? 0) - (a.priority?.score ?? 0))
    .slice(0, 6);

  const stats = [
    { value: active.length, label: "Active hazards tracked", sub: `${hazards.length} total reports` },
    { value: urgent.length, label: "Critical & high priority", sub: "within the 60–100 bands" },
    { value: clusters.length, label: "Spatial clusters", sub: "DBSCAN · 60 m radius" },
    { value: resolved, label: "Problems resolved", sub: "verified by the administrator" },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:py-10">
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            {greeting()}{user ? `, ${user.name.split(" ")[0]}` : ""}.
          </h1>
          {user && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FFD6A5] px-3 py-1 text-xs font-bold text-[#4a2c05]">
              <Siren className="size-3.5" aria-hidden /> Citizen
            </span>
          )}
        </div>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          Every feature of HazardLensAI is unlocked. Scan a road, report a hazard or explore the live map — your reports are tracked from submission to repair.
        </p>
      </motion.div>

      <section aria-label="Network statistics" className="mt-8 rounded-2xl border border-border bg-card/60 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">The network — right now</h2>
          <span className="text-xs text-muted-foreground">
            {data ? `synced ${new Date(data.computedAt).toLocaleTimeString()}` : "syncing…"}
          </span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {isLoading
            ? stats.map((s) => (
                <div key={s.label} className="border-l-2 border-[#6A00F4]/25 pl-4">
                  <Skeleton className="h-9 w-20" />
                  <Skeleton className="mt-2 h-4 w-36" />
                </div>
              ))
            : stats.map((s, i) => (
                <motion.div
                  key={s.label}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: reduced ? 0 : 0.05 * i }}
                  className="border-l-2 border-[#6A00F4]/25 pl-4"
                >
                  <p className="font-display text-3xl font-semibold">
                    <CountUp to={s.value} />
                  </p>
                  <p className="mt-1 text-sm font-medium">{s.label}</p>
                  <p className="text-[11px] text-muted-foreground">{s.sub}</p>
                </motion.div>
              ))}
        </div>
        {isError && (
          <div className="mt-4 flex items-center justify-between rounded-lg border border-[#C83E4D]/30 bg-[#C83E4D]/5 px-4 py-2.5 text-sm">
            <span className="text-[#C83E4D]">Live stats could not be loaded.</span>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>Retry</Button>
          </div>
        )}
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <section aria-label="Highest priority hazards" className="rounded-2xl border border-border bg-card p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-lg font-semibold">Highest priority right now</h2>
            <Button size="sm" variant="outline" className="border-border" onClick={() => setView("map")}>
              <MapIcon className="size-4" aria-hidden /> Open live map
            </Button>
          </div>

          {isLoading ? (
            <div className="mt-4 space-y-2.5">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14 w-full rounded-xl" />
              ))}
            </div>
          ) : topHazards.length === 0 ? (
            <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
              No scored hazards yet — the queue fills as reports are reviewed.
            </p>
          ) : (
            <ul className="mt-4 max-h-96 space-y-2.5 overflow-y-auto pr-1 scrollbar-slim">
              {topHazards.map((h) => {
                const cls = CLASS_META[h.hazardClass];
                const band = h.priority ? BAND_META[h.priority.band] : null;
                return (
                  <li key={h.id}>
                    <button
                      onClick={() => setView("map")}
                      className="flex w-full items-center gap-3 rounded-xl border border-border bg-background px-3.5 py-3 text-left transition-colors hover:border-[#6A00F4]/40 hover:bg-secondary/60"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold text-white" style={{ background: cls.color }} aria-hidden>
                        {cls.short.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold">{h.roadName ?? h.address ?? h.referenceCode}</span>
                          <span className="shrink-0 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{h.referenceCode}</span>
                        </span>
                        <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                          {cls.label} · {h.ward ?? "—"} <SeverityDots severity={h.severity} />
                          {h.workOrderStatus && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-900">
                              <Loader2 className={h.workOrderStatus === "IN_PROGRESS" ? "size-3 animate-spin" : "hidden size-3"} aria-hidden />
                              {h.workOrderStatus === "COMPLETED" ? "repaired" : h.workOrderStatus === "IN_PROGRESS" ? "repair in progress" : h.workOrderStatus === "ASSIGNED" ? "crew assigned" : "in queue"}
                            </span>
                          )}
                        </span>
                      </span>
                      {band && (
                        <span className="shrink-0 text-right">
                          <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${band.chip}`}>{band.label}</span>
                          <span className="block font-display text-base font-semibold">
                            {h.priority?.score}<span className="text-[10px] font-normal text-muted-foreground">/100</span>
                          </span>
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label="Workspace library" className="space-y-4">
          <button
            onClick={() => setView("docs")}
            className="group flex w-full items-start gap-4 rounded-2xl border border-border bg-card p-5 text-left shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_16px_36px_-18px_rgba(106,0,244,0.3)]"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#6A00F4]/10 text-[#6A00F4] transition-colors group-hover:bg-[#6A00F4] group-hover:text-white">
              <BookOpen className="size-5" aria-hidden />
            </span>
            <span>
              <span className="flex items-center gap-1.5 font-display text-base font-semibold">
                Documentation hub <ArrowRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
              </span>
              <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
                System & model cards, admin and user guides, API reference with the full OpenAPI spec.
              </span>
            </span>
          </button>

          <Card className="border-[#FFD6A5] bg-[#FFD6A5]/25">
            <CardContent className="p-5">
              <p className="text-sm font-semibold text-[#4a2c05]">Priority formula, in plain sight</p>
              <p className="mt-1.5 text-xs leading-relaxed text-[#4a2c05]/85">
                32% severity · 24% cluster density · 18% road criticality · 14% recurrence · 12% unresolved age — every band on the list is traceable factor by factor.
              </p>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}

export function Dashboard() {
  const user = useApp((s) => s.user);
  switch (user?.role) {
    case "ADMIN":
      return <AdminDashboard />;
    case "AUTHORITY":
      return <AuthorityDashboard />;
    case "FIELD_WORKER":
      return <FieldWorkerDashboard />;
    default:
      return <CitizenDashboard />;
  }
}

/* ------------------------------------------------------------------ */
/* Authority dashboard — verification desk                             */
/* ------------------------------------------------------------------ */
function AuthorityDashboard() {
  const { user, setView } = useApp();
  const reduced = !usePrefersReducedMotion();

  const mapQ = useQuery({
    queryKey: ["admin-dashboard-map"],
    queryFn: () => api<MapResponse>("/api/map?limit=500"),
    staleTime: 30_000,
  });
  const ordersQ = useQuery({
    queryKey: ["admin-dashboard"],
    queryFn: () => api<{ items: WorkOrderDTO[] }>("/api/work-orders"),
    staleTime: 15_000,
  });

  const hazards = mapQ.data?.hazards ?? [];
  const orders = ordersQ.data?.items ?? [];
  const incoming = hazards
    .filter((h) => ["REPORTED", "AI_VERIFIED", "PENDING_REVIEW"].includes(h.status))
    .sort((a, b) => (b.priority?.score ?? 0) - (a.priority?.score ?? 0));
  const flagged = hazards.filter((h) => h.status === "FLAGGED").length;
  const awaiting = orders.filter((o) => o.status === "COMPLETED" || o.status === "VERIFICATION_PENDING");
  const inFlight = orders.filter((o) => o.status === "ASSIGNED" || o.status === "IN_PROGRESS");

  const kpis = [
    { label: "Awaiting verification", value: incoming.length, sub: "reports to verify / reject / merge", color: "#6A00F4" },
    { label: "Flagged", value: flagged, sub: "escalated for manual inspection", color: "#B45309" },
    { label: "Repairs in flight", value: inFlight.length, sub: "assigned + in progress", color: "#D97706" },
    { label: "Evidence to review", value: awaiting.length, sub: "before/after submitted", color: "#168266" },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:py-10">
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            {greeting()}{user ? `, ${user.name.split(" ")[0]}` : ""}.
          </h1>
          {user && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#168266] px-3 py-1 text-xs font-bold text-white">
              <ShieldCheck className="size-3.5" aria-hidden /> Authority
            </span>
          )}
        </div>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          Your verification desk — confirm incoming hazards, merge duplicates and approve completed repairs. Every action is audit-logged.
        </p>
      </motion.div>

      <section aria-label="Verification statistics" className="mt-8 rounded-2xl border border-border bg-card/60 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">The queue — right now</h2>
          <div className="flex gap-2">
            <Button size="sm" className="bg-[#6A00F4] hover:bg-[#5a00d1]" onClick={() => setView("queue")}>
              <ShieldCheck className="size-4" aria-hidden /> Hazard Queue
            </Button>
            <Button size="sm" variant="outline" className="border-border" onClick={() => setView("work")}>
              <ClipboardList className="size-4" aria-hidden /> Work Orders
            </Button>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {(mapQ.isLoading || ordersQ.isLoading)
            ? kpis.map((s) => (
                <div key={s.label} className="border-l-2 border-[#6A00F4]/25 pl-4">
                  <Skeleton className="h-9 w-20" />
                  <Skeleton className="mt-2 h-4 w-36" />
                </div>
              ))
            : kpis.map((s, i) => (
                <motion.div
                  key={s.label}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: reduced ? 0 : 0.05 * i }}
                  className="border-l-2 pl-4"
                  style={{ borderColor: `${s.color}40` }}
                >
                  <p className="font-display text-3xl font-semibold" style={{ color: s.color }}>
                    <CountUp to={s.value} />
                  </p>
                  <p className="mt-1 text-sm font-medium">{s.label}</p>
                  <p className="text-[11px] text-muted-foreground">{s.sub}</p>
                </motion.div>
              ))}
        </div>
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <section aria-label="Hazards awaiting verification" className="rounded-2xl border border-border bg-card p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-display text-lg font-semibold">Awaiting verification</h2>
            <span className="text-xs text-muted-foreground">sorted by risk score</span>
          </div>
          {mapQ.isLoading ? (
            <div className="mt-4 space-y-2.5">
              {[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}
            </div>
          ) : incoming.length === 0 ? (
            <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
              Queue is clear — every report has been verified.
            </p>
          ) : (
            <ul className="mt-4 max-h-96 space-y-2.5 overflow-y-auto pr-1 scrollbar-slim">
              {incoming.slice(0, 8).map((h) => {
                const cls = CLASS_META[h.hazardClass];
                return (
                  <li key={h.id}>
                    <button
                      onClick={() => setView("queue")}
                      className="flex w-full items-center gap-3 rounded-xl border border-border bg-background px-3.5 py-3 text-left transition-colors hover:border-[#6A00F4]/40 hover:bg-secondary/60"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg text-[10px] font-bold text-white" style={{ background: cls.color }} aria-hidden>
                        {cls.short.slice(0, 2).toUpperCase()}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="truncate text-sm font-semibold">{h.roadName ?? h.address ?? h.referenceCode}</span>
                          <span className="shrink-0 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">{h.referenceCode}</span>
                        </span>
                        <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                          {cls.label} · {h.ward ?? "—"} <SeverityDots severity={h.severity} />
                          {h.reportCount > 1 && <span className="font-semibold text-[#0f5c49]">· {h.reportCount} reports</span>}
                        </span>
                      </span>
                      {h.priority && (
                        <span className="shrink-0 text-right">
                          <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${BAND_META[h.priority.band].chip}`}>{BAND_META[h.priority.band].label}</span>
                          <span className="block font-display text-base font-semibold">
                            {Math.round(h.priority.score)}<span className="text-[10px] font-normal text-muted-foreground">/100</span>
                          </span>
                        </span>
                      )}
                      <span className="hidden shrink-0 items-center gap-1 rounded-lg bg-[#6A00F4] px-2.5 py-1.5 text-[11px] font-bold text-white sm:flex">
                        <ShieldCheck className="size-3.5" aria-hidden /> Verify
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section aria-label="Recent completions" className="space-y-4">
          <div className="rounded-2xl border border-border bg-card p-5">
            <h2 className="flex items-center gap-2 font-display text-base font-semibold">
              <CheckCircle2 className="size-4 text-[#168266]" aria-hidden /> Evidence awaiting review
            </h2>
            {ordersQ.isLoading ? (
              <Skeleton className="mt-3 h-16 w-full rounded-xl" />
            ) : awaiting.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No repair evidence to verify right now.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {awaiting.slice(0, 5).map((o) => (
                  <li key={o.id} className="rounded-lg border border-border bg-background px-3 py-2">
                    <p className="truncate text-sm font-medium">{o.hazard?.roadName ?? o.hazard?.address ?? o.title}</p>
                    <p className="text-[11px] text-muted-foreground">
                      {o.code} · {o.assignedTo ? `crew ${o.assignedTo}` : "crew n/a"} · {o.status === "COMPLETED" ? "completed" : "verification pending"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <button
            onClick={() => setView("docs")}
            className="group flex w-full items-start gap-4 rounded-2xl border border-border bg-card p-5 text-left shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_16px_36px_-18px_rgba(106,0,244,0.3)]"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[#6A00F4]/10 text-[#6A00F4] transition-colors group-hover:bg-[#6A00F4] group-hover:text-white">
              <BookOpen className="size-5" aria-hidden />
            </span>
            <span>
              <span className="flex items-center gap-1.5 font-display text-base font-semibold">
                Documentation hub <ArrowRight className="size-3.5 text-muted-foreground transition-transform group-hover:translate-x-0.5" aria-hidden />
              </span>
              <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
                Verification lifecycle, risk engine transparency and the full API reference.
              </span>
            </span>
          </button>

          <Card className="border-[#FFD6A5] bg-[#FFD6A5]/25">
            <CardContent className="p-5">
              <p className="text-sm font-semibold text-[#4a2c05]">Risk formula, in plain sight</p>
              <p className="mt-1.5 text-xs leading-relaxed text-[#4a2c05]/85">
                32% severity · 24% density · 18% road criticality · 14% recurrence · 12% unresolved age — every score is traceable factor by factor.
              </p>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Field-worker dashboard — my assignments                             */
/* ------------------------------------------------------------------ */
function FieldWorkerDashboard() {
  const { user, setView } = useApp();
  const reduced = !usePrefersReducedMotion();

  const ordersQ = useQuery({
    queryKey: ["admin-dashboard"],
    queryFn: () => api<{ items: WorkOrderDTO[] }>("/api/work-orders"),
    staleTime: 15_000,
  });

  const orders = ordersQ.data?.items ?? [];
  const notStarted = orders.filter((o) => o.status === "ASSIGNED");
  const active = orders.filter((o) => o.status === "IN_PROGRESS");
  const awaiting = orders.filter((o) => o.status === "COMPLETED" || o.status === "VERIFICATION_PENDING");
  const done = orders.filter((o) => o.status === "VERIFIED" || o.status === "CLOSED");

  const kpis = [
    { label: "Not started", value: notStarted.length, sub: "waiting for you", color: "#655D73" },
    { label: "In progress", value: active.length, sub: "your active repairs", color: "#D97706" },
    { label: "Evidence pending", value: awaiting.length, sub: "submitted for verification", color: "#B45309" },
    { label: "Verified", value: done.length, sub: "approved resolutions", color: "#168266" },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:py-10">
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
            {greeting()}{user ? `, ${user.name.split(" ")[0]}` : ""}.
          </h1>
          {user && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[#D97706] px-3 py-1 text-xs font-bold text-white">
              <HardHat className="size-3.5" aria-hidden /> Field worker
            </span>
          )}
        </div>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
          Your repair assignments — start work on site, upload before/after evidence and submit for the authority&apos;s verification.
        </p>
      </motion.div>

      <section aria-label="Assignment statistics" className="mt-8 rounded-2xl border border-border bg-card/60 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">My assignments</h2>
          <Button size="sm" className="bg-[#6A00F4] hover:bg-[#5a00d1]" onClick={() => setView("work")}>
            <ClipboardList className="size-4" aria-hidden /> Open My Assignments
          </Button>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {ordersQ.isLoading
            ? kpis.map((s) => (
                <div key={s.label} className="border-l-2 border-[#6A00F4]/25 pl-4">
                  <Skeleton className="h-9 w-20" />
                  <Skeleton className="mt-2 h-4 w-36" />
                </div>
              ))
            : kpis.map((s, i) => (
                <motion.div
                  key={s.label}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.4, delay: reduced ? 0 : 0.05 * i }}
                  className="border-l-2 pl-4"
                  style={{ borderColor: `${s.color}40` }}
                >
                  <p className="font-display text-3xl font-semibold" style={{ color: s.color }}>
                    <CountUp to={s.value} />
                  </p>
                  <p className="mt-1 text-sm font-medium">{s.label}</p>
                  <p className="text-[11px] text-muted-foreground">{s.sub}</p>
                </motion.div>
              ))}
        </div>
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.5fr_1fr]">
        <section aria-label="Next up" className="rounded-2xl border border-border bg-card p-5 sm:p-6">
          <h2 className="font-display text-lg font-semibold">Next up</h2>
          {ordersQ.isLoading ? (
            <div className="mt-4 space-y-2.5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full rounded-xl" />)}</div>
          ) : notStarted.length === 0 && active.length === 0 ? (
            <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
              No active assignments — new work orders will appear here with full location details.
            </p>
          ) : (
            <ul className="mt-4 max-h-96 space-y-2.5 overflow-y-auto pr-1 scrollbar-slim">
              {[...active, ...notStarted].slice(0, 8).map((o) => (
                <li key={o.id}>
                  <button
                    onClick={() => setView("work")}
                    className="flex w-full items-center gap-3 rounded-xl border border-border bg-background px-3.5 py-3 text-left transition-colors hover:border-[#6A00F4]/40 hover:bg-secondary/60"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#6A00F4]/10 text-[10px] font-bold text-[#6A00F4]" aria-hidden>
                      {o.code.replace("WO-", "")}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{o.hazard?.roadName ?? o.hazard?.address ?? o.title}</span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {o.hazard ? `${CLASS_META[o.hazard.hazardClass].label} · ${o.hazard.ward ?? "—"}` : "location details inside"}
                      </span>
                    </span>
                    <span className="shrink-0 rounded-full border border-border bg-card px-2 py-0.5 text-[10px] font-bold text-muted-foreground">
                      {o.status === "IN_PROGRESS" ? "in progress" : "not started"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="space-y-4">
          <div className="rounded-2xl border border-border bg-card p-5">
            <h2 className="flex items-center gap-2 font-display text-base font-semibold">
              <CheckCircle2 className="size-4 text-[#168266]" aria-hidden /> Recently verified
            </h2>
            {done.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">Repairs you complete and get verified will land here.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {done.slice(0, 5).map((o) => (
                  <li key={o.id} className="rounded-lg border border-border bg-background px-3 py-2">
                    <p className="truncate text-sm font-medium">{o.hazard?.roadName ?? o.hazard?.address ?? o.title}</p>
                    <p className="text-[11px] text-muted-foreground">{o.code} · verified {o.verifiedAt ? new Date(o.verifiedAt).toLocaleDateString() : "recently"}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Card className="border-[#FFD6A5] bg-[#FFD6A5]/25">
            <CardContent className="p-5">
              <p className="text-sm font-semibold text-[#4a2c05]">Evidence matters</p>
              <p className="mt-1.5 text-xs leading-relaxed text-[#4a2c05]/85">
                Upload the before photo when you arrive and the after photo when the repair is done — the authority verifies resolutions against them.
              </p>
            </CardContent>
          </Card>
        </section>
      </div>
    </div>
  );
}
