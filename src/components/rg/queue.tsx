"use client";
// HazardQueue — the authority verification panel.
// Incoming hazards (REPORTED / AI_VERIFIED / PENDING_REVIEW / FLAGGED) with their AI
// confidence, risk score, severity band, community report count and duplicate candidates.
// Actions: Verify · Reject · Merge · Escalate — every action is backend-audited.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, mediaUrl } from "@/lib/rg/api";
import { useApp } from "@/lib/rg/store";
import { CLASS_META, STATUS_META } from "@/lib/rg/constants";
import type { DuplicateCandidateDTO, HazardDTO, MapResponse } from "@/lib/rg/types";
import { ClassChip, EmptyState, SeverityDots, StatusChip } from "@/components/rg/primitives";
import { AiConfidenceChip, HazardDetailSheet, RiskChip } from "@/components/rg/hazard-detail";
import { fmtDate, fmtRelative } from "@/lib/rg/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  CheckCircle2,
  GitMerge,
  Loader2,
  Search,
  ShieldCheck,
  Siren,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

type QueueAction = "verify" | "reject" | "escalate" | "merge";

const QUEUE_STATUSES = ["REPORTED", "AI_VERIFIED", "PENDING_REVIEW", "FLAGGED"];

export function HazardQueue() {
  const { user } = useApp();
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [tab, setTab] = useState<"incoming" | "flagged">("incoming");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [action, setAction] = useState<QueueAction | null>(null);
  const [note, setNote] = useState("");
  const [mergeTarget, setMergeTarget] = useState<DuplicateCandidateDTO | null>(null);

  const mapQ = useQuery({
    queryKey: ["queue-map"],
    queryFn: () => api<MapResponse>("/api/map?limit=500"),
    staleTime: 15_000,
  });

  const hazards = mapQ.data?.hazards ?? [];
  const incoming = useMemo(
    () =>
      hazards
        .filter((h) => ["REPORTED", "AI_VERIFIED", "PENDING_REVIEW"].includes(h.status))
        .sort((a, b) => (b.priority?.score ?? 0) - (a.priority?.score ?? 0)),
    [hazards]
  );
  const flagged = useMemo(() => hazards.filter((h) => h.status === "FLAGGED"), [hazards]);
  const pool = tab === "incoming" ? incoming : flagged;
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return pool;
    return pool.filter((h) =>
      [h.referenceCode, h.roadName, h.address, h.ward, h.hazardClass].some((v) => v?.toLowerCase().includes(q))
    );
  }, [pool, search]);

  const selected = selectedId ? hazards.find((h) => h.id === selectedId) ?? null : null;

  const dupQ = useQuery({
    queryKey: ["dup-candidates", selectedId],
    queryFn: () => api<{ candidates: DuplicateCandidateDTO[]; thresholdPct: number }>(`/api/hazards/${selectedId}/duplicates`),
    enabled: Boolean(selectedId),
    staleTime: 10_000,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["queue-map"] });
    void qc.invalidateQueries({ queryKey: ["work-map"] });
    void qc.invalidateQueries({ queryKey: ["dup-candidates"] });
    void qc.invalidateQueries({ queryKey: ["admin-dashboard-map"] });
  };

  const act = useMutation({
    mutationFn: (payload: { action: QueueAction; note?: string; mergeIntoId?: string }) =>
      api<{ hazard: HazardDTO }>(`/api/hazards/${selectedId}/verify`, { json: payload }),
    onSuccess: (_r, payload) => {
      const labels: Record<QueueAction, string> = {
        verify: "Hazard verified",
        reject: "Hazard rejected",
        escalate: "Escalated for field inspection",
        merge: "Merged into the canonical hazard",
      };
      toast.success(labels[payload.action]);
      setAction(null);
      setNote("");
      setMergeTarget(null);
      if (payload.action !== "verify") setSelectedId(null);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Action failed"),
  });

  const busy = act.isPending;

  const openAction = (a: QueueAction) => {
    if (a === "merge" && (dupQ.data?.candidates?.length ?? 0) === 0) {
      toast.info("No duplicate candidates", { description: "No similar hazards were found within the configured radius and window." });
      return;
    }
    setAction(a);
  };

  const detailActions = user && (
    <div className="grid grid-cols-2 gap-2">
      <Button className="bg-[#168266] hover:bg-[#0f5c49]" disabled={busy} onClick={() => openAction("verify")}>
        <CheckCircle2 className="size-4" aria-hidden /> Verify
      </Button>
      <Button variant="outline" className="border-[#C83E4D]/40 text-[#C83E4D] hover:bg-[#C83E4D]/10" disabled={busy} onClick={() => openAction("reject")}>
        <XCircle className="size-4" aria-hidden /> Reject
      </Button>
      <Button variant="outline" className="border-border" disabled={busy} onClick={() => openAction("merge")}>
        <GitMerge className="size-4" aria-hidden /> Merge duplicate
      </Button>
      <Button variant="outline" className="border-[#D97706]/40 text-[#B45309] hover:bg-[#D97706]/10" disabled={busy} onClick={() => openAction("escalate")}>
        <TriangleAlert className="size-4" aria-hidden /> Escalate
      </Button>
    </div>
  );

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#6A00F4]">Management</p>
          <h1 className="mt-2 font-display text-4xl tracking-tight">Hazard Queue</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            Verify incoming hazards, merge duplicates and escalate edge cases. Every action is logged to the audit trail with your identity.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: "Incoming", value: incoming.length, color: "#6A00F4" },
            { label: "Flagged", value: flagged.length, color: "#B45309" },
            { label: "With duplicates", value: incoming.filter((h) => h.reportCount > 1).length, color: "#168266" },
          ].map((k) => (
            <div key={k.label} className="rounded-xl border border-border bg-card px-4 py-3 text-center">
              <p className="font-display text-2xl font-semibold tabular-nums" style={{ color: k.color }}>{mapQ.isLoading ? "—" : k.value}</p>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{k.label}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input className="w-64 pl-9" placeholder="Search ref, road, ward…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search queue" />
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList className="h-9">
            <TabsTrigger value="incoming">Incoming</TabsTrigger>
            <TabsTrigger value="flagged">Flagged</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="mt-5 rounded-2xl border border-border bg-card">
        {mapQ.isLoading ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => <div key={i} className="h-16 animate-pulse rounded-xl bg-secondary/60" />)}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title={tab === "incoming" ? "The verification queue is clear" : "Nothing is flagged right now"}
              hint={tab === "incoming" ? "New reports land here the moment citizens submit them." : "Escalated hazards appear here for manual inspection."}
              icon={<ShieldCheck className="size-5" aria-hidden />}
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((h) => {
              const cls = CLASS_META[h.hazardClass];
              return (
                <li key={h.id}>
                  <button
                    onClick={() => setSelectedId(h.id)}
                    className={cn(
                      "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-secondary",
                      selectedId === h.id && "bg-[#6A00F4]/[0.06]"
                    )}
                  >
                    <span className="relative size-12 shrink-0 overflow-hidden rounded-lg border border-border bg-secondary">
                      {h.media[0] ? (
                        <img src={mediaUrl(h.media[0].id)} alt={`Evidence for ${h.referenceCode}`} className="size-full object-cover" loading="lazy" />
                      ) : (
                        <span className="flex size-full items-center justify-center text-[10px] font-bold text-white" style={{ background: cls.color }} aria-hidden>
                          {cls.short.slice(0, 2).toUpperCase()}
                        </span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px] font-semibold text-[#6A00F4]">{h.referenceCode}</span>
                        <StatusChip status={h.status} />
                        {h.reportCount > 1 && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-[#168266]/10 px-2 py-0.5 text-[10px] font-bold text-[#0f5c49]">
                            <Siren className="size-3" aria-hidden /> {h.reportCount} reports
                          </span>
                        )}
                      </span>
                      <span className="mt-0.5 block truncate text-sm font-semibold">{h.roadName ?? h.address ?? "Unnamed location"}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {h.ward ?? "—"} · {fmtRelative(h.createdAt)} <SeverityDots severity={h.severity} />
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <AiConfidenceChip hazard={h} />
                      <RiskChip hazard={h} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* -------- shared detail sheet with authority actions -------- */}
      <HazardDetailSheet hazard={selected} onClose={() => setSelectedId(null)} actions={detailActions} />

      {/* -------- action confirmation dialog -------- */}
      <Dialog open={Boolean(action)} onOpenChange={(o) => !o && setAction(null)}>
        <DialogContent className="max-w-lg">
          {action && selected && (
            <>
              <DialogHeader>
                <DialogTitle className="font-display text-2xl">
                  {action === "verify" && "Verify this hazard?"}
                  {action === "reject" && "Reject this hazard?"}
                  {action === "escalate" && "Escalate for field inspection?"}
                  {action === "merge" && "Merge duplicate report"}
                </DialogTitle>
              </DialogHeader>

              {action === "merge" ? (
                <div className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Choose the canonical hazard to merge <span className="font-bold text-foreground">{selected.referenceCode}</span> into.
                    The merged report is kept for the audit trail and raises the canonical hazard&apos;s community confidence.
                  </p>
                  <div className="max-h-64 space-y-2 overflow-y-auto scrollbar-slim">
                    {(dupQ.data?.candidates ?? []).map((c) => (
                      <button
                        key={c.hazardId}
                        onClick={() => setMergeTarget(c)}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 rounded-xl border p-3 text-left transition-colors",
                          mergeTarget?.hazardId === c.hazardId ? "border-[#6A00F4] bg-[#6A00F4]/[0.06]" : "border-border hover:bg-secondary"
                        )}
                      >
                        <span className="min-w-0">
                          <span className="block font-mono text-xs font-semibold text-[#6A00F4]">{c.referenceCode}</span>
                          <span className="block text-xs text-muted-foreground">
                            {c.distanceM} m away · {STATUS_META[c.status].label.toLowerCase()} · reported {fmtDate(c.createdAt)}
                          </span>
                        </span>
                        <span className="shrink-0 text-right">
                          <span className="block font-display text-lg font-bold">{c.similarityPct}%</span>
                          <span className="block text-[10px] text-muted-foreground">similarity</span>
                        </span>
                      </button>
                    ))}
                    {dupQ.isLoading && <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" aria-hidden /> Scanning nearby hazards…</p>}
                    {!dupQ.isLoading && (dupQ.data?.candidates?.length ?? 0) === 0 && (
                      <p className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                        No candidates within the configured duplicate radius.
                      </p>
                    )}
                  </div>
                  <div>
                    <Label htmlFor="q-note-merge">Reviewer note (optional)</Label>
                    <Textarea id="q-note-merge" rows={2} className="mt-1.5" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why these are the same hazard…" />
                  </div>
                  <Button className="w-full bg-[#6A00F4] hover:bg-[#5a00d1]" disabled={busy || !mergeTarget} onClick={() => act.mutate({ action: "merge", mergeIntoId: mergeTarget?.hazardId, note: note.trim() || undefined })}>
                    {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <GitMerge className="size-4" aria-hidden />}
                    Merge with {mergeTarget?.referenceCode ?? "…"}
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {action === "reject" && (
                    <div className="rounded-xl border border-[#C83E4D]/30 bg-[#C83E4D]/[0.05] p-3 text-xs leading-relaxed text-[#C83E4D]">
                      Rejection removes the hazard from the live map and notifies the reporter. Please include a clear reason.
                    </div>
                  )}
                  <div>
                    <Label htmlFor="q-note">{action === "verify" ? "Verification note (optional)" : action === "reject" ? "Reason (required)" : "Escalation note (optional)"}</Label>
                    <Textarea id="q-note" rows={3} className="mt-1.5" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add context for the audit trail…" />
                  </div>
                  <Button
                    className={cn("w-full", action === "verify" && "bg-[#168266] hover:bg-[#0f5c49]", action === "reject" && "bg-[#C83E4D] hover:bg-[#a93344]", action === "escalate" && "bg-[#B45309] hover:bg-[#8a3f07]")}
                    disabled={busy || (action === "reject" && !note.trim())}
                    onClick={() => act.mutate({ action, note: note.trim() || undefined })}
                  >
                    {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                    Confirm {action}
                  </Button>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
