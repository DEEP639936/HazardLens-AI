"use client";
// ResolutionVerification — ADMIN-only close-out console.
// Field crews / contractors submit before+after evidence; only the main administrator can:
//   1. inspect the before/after photo comparison side by side,
//   2. VERIFY the repair (approve → VERIFIED) and immediately CLOSE the problem,
//   3. REJECT the resolution with a mandatory reason (order returns to the crew for rework).
// Every decision is audit-logged server-side and the reporter is notified.
// The Dashboard "Problems resolved" KPI counts exactly what this view closes out.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, mediaUrl } from "@/lib/rg/api";
import { CLASS_META, WO_STATUS_META } from "@/lib/rg/constants";
import type { WorkOrderDTO } from "@/lib/rg/types";
import { ClassChip, EmptyState, SeverityDots, WoStatusChip } from "@/components/rg/primitives";
import { fmtDate, fmtRelative } from "@/lib/rg/format";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { CalendarClock, CheckCircle2, ClipboardCheck, FileWarning, Loader2, MapPin, Search, ShieldCheck, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Before / After evidence comparison                                  */
/* ------------------------------------------------------------------ */
function EvidenceCompare({ order }: { order: WorkOrderDTO }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <figure className="overflow-hidden rounded-xl border-2 border-[#655D73]/30">
        <div className="aspect-[4/3] bg-muted/40">
          {order.beforeMediaId ? (
            <a href={mediaUrl(order.beforeMediaId)} target="_blank" rel="noreferrer">
              <img src={mediaUrl(order.beforeMediaId)} alt="Before repair — hazard present" className="size-full object-cover" />
            </a>
          ) : (
            <div className="flex size-full items-center justify-center text-xs text-muted-foreground">No before photo</div>
          )}
        </div>
        <figcaption className="flex items-center justify-between border-t border-border bg-secondary/50 px-3 py-2 text-xs font-bold text-foreground">
          <span className="flex items-center gap-1.5"><FileWarning className="size-3.5 text-[#C83E4D]" aria-hidden /> BEFORE — the hazard</span>
          <span className="font-normal text-muted-foreground">{order.startedAt ? fmtDate(order.startedAt, true) : "—"}</span>
        </figcaption>
      </figure>
      <figure className="overflow-hidden rounded-xl border-2 border-[#168266]/40">
        <div className="aspect-[4/3] bg-muted/40">
          {order.afterMediaId ? (
            <a href={mediaUrl(order.afterMediaId)} target="_blank" rel="noreferrer">
              <img src={mediaUrl(order.afterMediaId)} alt="After repair — hazard resolved" className="size-full object-cover" />
            </a>
          ) : (
            <div className="flex size-full items-center justify-center text-xs text-muted-foreground">No after photo</div>
          )}
        </div>
        <figcaption className="flex items-center justify-between border-t border-border bg-[#168266]/10 px-3 py-2 text-xs font-bold text-[#0f5c49]">
          <span className="flex items-center gap-1.5"><CheckCircle2 className="size-3.5" aria-hidden /> AFTER — the repair</span>
          <span className="font-normal text-muted-foreground">{order.completedAt ? fmtDate(order.completedAt, true) : "—"}</span>
        </figcaption>
      </figure>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Verification detail dialog                                          */
/* ------------------------------------------------------------------ */
function VerificationDetail({
  order,
  onClose,
}: {
  order: WorkOrderDTO;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["verify-orders"] });
    void qc.invalidateQueries({ queryKey: ["work-orders"] });
    void qc.invalidateQueries({ queryKey: ["admin-dashboard"] });
    void qc.invalidateQueries({ queryKey: ["admin-dashboard-map"] });
    void qc.invalidateQueries({ queryKey: ["work-map"] });
  };

  /* approve → VERIFIED (verify API), then VERIFIED → CLOSED (guarded PATCH).
     Both hops are legal transitions and each is audited server-side. */
  const verifyAndClose = useMutation({
    mutationFn: async () => {
      await api<{ status: string }>(`/api/work-orders/${order.id}/verify`, { json: { decision: "approve" } });
      return api<{ status: string }>(`/api/work-orders/${order.id}`, { method: "PATCH", json: { status: "CLOSED", note: "Resolution verified by administrator — problem closed." } });
    },
    onSuccess: () => {
      toast.success("Problem verified & closed", { description: `${order.hazard?.referenceCode ?? order.code} is now counted under Problems resolved on the dashboard.` });
      invalidate();
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Verification failed"),
  });

  const reject = useMutation({
    mutationFn: () =>
      api<{ status: string }>(`/api/work-orders/${order.id}/verify`, { json: { decision: "reject", reason: rejectReason.trim() } }),
    onSuccess: () => {
      toast.success("Resolution rejected", { description: "The order returns to the crew for rework; reporter and crew were notified." });
      invalidate();
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Rejection failed"),
  });

  /* VERIFIED → CLOSE hop for orders that were approved but not yet closed. */
  const close = useMutation({
    mutationFn: () =>
      api<{ status: string }>(`/api/work-orders/${order.id}`, { method: "PATCH", json: { status: "CLOSED", note: "Work order closed by administrator." } }),
    onSuccess: () => {
      toast.success("Work order closed", { description: "The problem is now counted under Problems resolved on the dashboard." });
      invalidate();
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Close failed"),
  });

  const busy = verifyAndClose.isPending || reject.isPending || close.isPending;
  const pending = order.status === "VERIFICATION_PENDING";
  const verified = order.status === "VERIFIED";
  const cls = order.hazard?.hazardClass ? CLASS_META[order.hazard.hazardClass] : null;

  return (
    <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto scrollbar-slim">
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2 font-display text-2xl">
          {order.hazard?.referenceCode ?? order.code}
          <WoStatusChip status={order.status} />
        </DialogTitle>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>{order.code}</span>
          {order.hazard?.roadName || order.hazard?.address ? (
            <span className="inline-flex items-center gap-1"><MapPin className="size-3" aria-hidden />{order.hazard?.roadName ?? order.hazard?.address}</span>
          ) : null}
          {order.hazard?.ward ? <span>· {order.hazard.ward}</span> : null}
          {order.hazard?.reporter ? <span>· reported by {order.hazard.reporter}</span> : null}
        </p>
      </DialogHeader>

      {/* the core ask: side-by-side contractor evidence inspection */}
      <EvidenceCompare order={order} />

      <div className="flex flex-wrap items-center gap-2.5">
        {cls && <ClassChip cls={order.hazard!.hazardClass} size="md" />}
        {order.hazard && <SeverityDots severity={order.hazard.severity} />}
        {order.department && <span className="rounded-full bg-secondary px-2.5 py-0.5 text-[11px] font-semibold">{order.department}</span>}
        {order.assignedTeam && <span className="rounded-full bg-secondary px-2.5 py-0.5 text-[11px] font-semibold">{order.assignedTeam}</span>}
        {order.assignedTo && <span className="rounded-full bg-[#6A00F4]/10 px-2.5 py-0.5 text-[11px] font-semibold text-[#4d00b3]">crew: {order.assignedTo}</span>}
      </div>

      {order.resolutionNotes && (
        <p className="rounded-lg bg-secondary/60 p-3 text-sm leading-relaxed">
          <span className="font-semibold">Contractor resolution notes:</span> {order.resolutionNotes}
        </p>
      )}

      {pending && (
        <div className="rounded-xl border border-[#B45309]/30 bg-orange-50/60 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-[#7a3a05]">
            <ShieldCheck className="size-4" aria-hidden /> Compare the before/after photos, then decide.
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[#7a3a05]/80">
            Verifying closes this problem permanently — the hazard is marked resolved and counted on your dashboard. Rejecting sends the order back to the crew with your reason.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button className="bg-[#168266] hover:bg-[#0f5c49]" disabled={busy} onClick={() => verifyAndClose.mutate()}>
              {verifyAndClose.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CheckCircle2 className="size-4" aria-hidden />}
              Verify &amp; close problem
            </Button>
            <Button variant="outline" className="border-[#C83E4D]/40 text-[#C83E4D] hover:bg-[#C83E4D]/10" disabled={busy} onClick={() => setRejectOpen(true)}>
              <XCircle className="size-4" aria-hidden /> Reject resolution
            </Button>
          </div>
        </div>
      )}

      {verified && (
        <div className="rounded-xl border border-[#168266]/30 bg-emerald-50/60 p-4 text-sm text-[#0f5c49]">
          <p className="flex flex-wrap items-center gap-2 font-semibold">
            <CheckCircle2 className="size-4" aria-hidden /> Resolution verified{order.verifiedBy ? ` by ${order.verifiedBy}` : ""}{order.verifiedAt ? ` · ${fmtDate(order.verifiedAt, true)}` : ""}.
          </p>
          <div className="mt-2">
            <Button size="sm" className="bg-[#655D73] hover:bg-[#4d4759]" disabled={busy} onClick={() => close.mutate()}>
              {close.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null} Close work order
            </Button>
          </div>
        </div>
      )}

      {order.rejectReason && (
        <div className="rounded-xl border border-[#C83E4D]/30 bg-[#C83E4D]/[0.05] p-3 text-xs leading-relaxed text-[#C83E4D]">
          <strong>Previous rejection:</strong> {order.rejectReason}
        </div>
      )}

      {order.updates.length > 0 && (
        <div className="rounded-xl border border-border p-4">
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Work order timeline</p>
          <ol className="mt-3 space-y-2.5">
            {order.updates.map((u) => (
              <li key={u.id} className="flex gap-2.5 text-sm">
                <CalendarClock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  <span className="font-medium">
                    {u.fromStatus && u.toStatus && u.fromStatus !== u.toStatus
                      ? `${WO_STATUS_META[u.fromStatus as keyof typeof WO_STATUS_META]?.label ?? u.fromStatus} → ${WO_STATUS_META[u.toStatus as keyof typeof WO_STATUS_META]?.label ?? u.toStatus}`
                      : WO_STATUS_META[u.toStatus as keyof typeof WO_STATUS_META]?.label ?? "Update"}
                  </span>
                  {u.note && <span className="block text-xs text-muted-foreground">{u.note}</span>}
                  <span className="block text-[11px] text-muted-foreground">{u.author ?? "System"} · {fmtRelative(u.createdAt)}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* reject dialog — reason mandatory */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Reject this resolution?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">The order returns to the crew for rework. A clear reason is required and will notify both the crew and the reporter.</p>
          <Textarea rows={3} placeholder="e.g. Patch has not compacted to grade — redo and resubmit" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} aria-label="Rejection reason" />
          <Button className="w-full bg-[#C83E4D] hover:bg-[#a93344]" disabled={busy || !rejectReason.trim()} onClick={() => reject.mutate()}>
            {reject.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <XCircle className="size-4" aria-hidden />} Reject &amp; request rework
          </Button>
        </DialogContent>
      </Dialog>
    </DialogContent>
  );
}

/* ------------------------------------------------------------------ */
/* Main view                                                           */
/* ------------------------------------------------------------------ */
export function ResolutionVerification() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const ordersQ = useQuery({
    queryKey: ["verify-orders"],
    queryFn: () => api<{ items: WorkOrderDTO[] }>("/api/work-orders"),
    staleTime: 15_000,
  });

  const orders = ordersQ.data?.items ?? [];
  const pending = useMemo(() => orders.filter((o) => o.status === "VERIFICATION_PENDING"), [orders]);
  const verifiedOpen = useMemo(() => orders.filter((o) => o.status === "VERIFIED"), [orders]);
  const resolved = useMemo(() => orders.filter((o) => o.status === "VERIFIED" || o.status === "CLOSED"), [orders]);
  const rework = useMemo(() => orders.filter((o) => o.status === "IN_PROGRESS" && o.rejectReason), [orders]);

  const q = search.trim().toLowerCase();
  const filterFn = (o: WorkOrderDTO) => {
    if (!q) return true;
    const h = o.hazard;
    return [o.code, h?.referenceCode, h?.roadName, h?.address, h?.ward, o.assignedTo].some((v) => v?.toLowerCase().includes(q));
  };
  const pendingShown = pending.filter(filterFn);
  const selected = orders.find((o) => o.id === selectedId) ?? null;

  const kpis = [
    { label: "Awaiting your verification", value: pending.length, sub: "before/after evidence submitted", color: "#B45309" },
    { label: "Problems resolved", value: resolved.length, sub: "verified & closed by you", color: "#168266" },
    { label: "Sent back for rework", value: rework.length, sub: "rejected resolutions in repair", color: "#C83E4D" },
    { label: "Verified — awaiting close", value: verifiedOpen.length, sub: "approved but not yet closed", color: "#6A00F4" },
  ];

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:py-10">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#6A00F4]">Administrator</p>
        <h1 className="mt-2 font-display text-4xl tracking-tight">Resolution Verification</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Field crews and contractors upload before/after evidence for every repair. Only you can inspect the comparison,
          verify the work and close the problem — every decision is audit-logged and the reporter is notified.
        </p>
      </div>

      {/* KPI strip */}
      <section aria-label="Verification statistics" className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-2xl border border-border bg-card p-5" style={{ borderLeft: `3px solid ${k.color}` }}>
            <p className="font-display text-3xl font-semibold tabular-nums" style={{ color: k.color }}>
              {ordersQ.isLoading ? "—" : k.value}
            </p>
            <p className="mt-1 text-sm font-medium">{k.label}</p>
            <p className="text-[11px] text-muted-foreground">{k.sub}</p>
          </div>
        ))}
      </section>

      <div className="relative mt-8 max-w-sm">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search code, road, ward, crew…"
          aria-label="Search verification queue"
          className="h-10 w-full rounded-xl border border-border bg-card pl-9 pr-3 text-sm outline-none transition-colors focus:border-[#6A00F4]/50"
        />
      </div>

      {/* ---- verification queue ---- */}
      <section aria-label="Resolutions awaiting verification" className="mt-5">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <ClipboardCheck className="size-4.5 text-[#B45309]" aria-hidden /> Awaiting verification
          <span className="rounded-full bg-[#B45309] px-2 py-0.5 text-[10px] font-bold text-white">{pendingShown.length}</span>
        </h2>

        {ordersQ.isLoading ? (
          <div className="mt-4 space-y-3">{[0, 1].map((i) => <div key={i} className="h-24 animate-pulse rounded-2xl bg-secondary/50" />)}</div>
        ) : pendingShown.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              title={pending.length === 0 ? "Nothing to verify right now" : "No results match your search"}
              hint={pending.length === 0 ? "When a crew submits before/after evidence, the repair lands here for your sign-off." : "Try a different code, road or crew name."}
              icon={<ShieldCheck className="size-5" aria-hidden />}
            />
          </div>
        ) : (
          <ul className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {pendingShown.map((o) => {
              const cls = o.hazard?.hazardClass ? CLASS_META[o.hazard.hazardClass] : null;
              return (
                <li key={o.id}>
                  <button
                    onClick={() => setSelectedId(o.id)}
                    className="group flex h-full w-full flex-col rounded-2xl border border-border bg-card p-4 text-left transition-all hover:-translate-y-0.5 hover:border-[#B45309]/50 hover:shadow-[0_16px_36px_-20px_rgba(180,83,9,0.45)]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-display text-base font-semibold">{o.hazard?.referenceCode ?? o.code}</span>
                      <WoStatusChip status={o.status} />
                    </div>
                    <span className="mt-1 truncate text-xs text-muted-foreground">{o.hazard?.roadName ?? o.hazard?.address ?? "location n/a"}{o.hazard?.ward ? ` · ${o.hazard.ward}` : ""}</span>
                    <div className="mt-3 flex flex-1 items-center gap-2">
                      {[o.beforeMediaId, o.afterMediaId].map((id, i) => (
                        <span key={i} className="relative h-16 flex-1 overflow-hidden rounded-lg border border-border bg-muted/40">
                          {id ? (
                            <img src={mediaUrl(id)} alt={i === 0 ? "Before repair" : "After repair"} className="size-full object-cover" loading="lazy" />
                          ) : (
                            <span className="flex size-full items-center justify-center text-[10px] text-muted-foreground">{i === 0 ? "no before" : "no after"}</span>
                          )}
                          <span className={cn("absolute left-1 top-1 rounded px-1 py-0.5 text-[8px] font-bold uppercase text-white", i === 0 ? "bg-[#655D73]/85" : "bg-[#168266]/85")}>
                            {i === 0 ? "before" : "after"}
                          </span>
                        </span>
                      ))}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      {cls && <span className={cn("rounded-full border px-2 py-0.5 text-[10px] font-bold", cls.chip)}>{cls.short}</span>}
                      {o.hazard && <SeverityDots severity={o.hazard.severity} />}
                      {o.assignedTo && <span className="text-[10px] text-muted-foreground">crew: {o.assignedTo}</span>}
                      <span className="ml-auto inline-flex items-center gap-1 text-[10px] font-bold text-[#B45309] opacity-0 transition-opacity group-hover:opacity-100">
                        verify <ShieldCheck className="size-3" aria-hidden />
                      </span>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* ---- verified awaiting close ---- */}
      {verifiedOpen.filter(filterFn).length > 0 && (
        <section aria-label="Verified resolutions awaiting close" className="mt-8">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
            <CheckCircle2 className="size-4.5 text-[#6A00F4]" aria-hidden /> Verified — awaiting close
          </h2>
          <ul className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {verifiedOpen.filter(filterFn).map((o) => (
              <li key={o.id}>
                <button
                  onClick={() => setSelectedId(o.id)}
                  className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:border-[#6A00F4]/40 hover:bg-secondary/50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold">{o.hazard?.referenceCode ?? o.code}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      verified {o.verifiedAt ? fmtRelative(o.verifiedAt) : "recently"} · {o.hazard?.roadName ?? o.hazard?.address ?? "location n/a"}
                    </span>
                  </span>
                  <WoStatusChip status={o.status} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---- recently resolved ---- */}
      {resolved.filter(filterFn).length > 0 && (
        <section aria-label="Problems resolved" className="mt-8">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
            <CheckCircle2 className="size-4.5 text-[#168266]" aria-hidden /> Problems resolved
            <span className="rounded-full bg-[#168266] px-2 py-0.5 text-[10px] font-bold text-white">{resolved.length}</span>
          </h2>
          <ul className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {resolved.filter(filterFn).slice(0, 6).map((o) => (
              <li key={o.id} className="rounded-2xl border border-border bg-card p-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-semibold">{o.hazard?.referenceCode ?? o.code}</span>
                  <WoStatusChip status={o.status} />
                </div>
                <p className="mt-1 truncate text-xs text-muted-foreground">{o.hazard?.roadName ?? o.hazard?.address ?? "location n/a"}</p>
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  {o.verifiedAt ? `verified ${fmtDate(o.verifiedAt, true)}` : "verified"}{o.assignedTo ? ` · crew ${o.assignedTo}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {selected && (
        <Dialog open onOpenChange={(o) => !o && setSelectedId(null)}>
          <VerificationDetail key={selected.id + selected.status} order={selected} onClose={() => setSelectedId(null)} />
        </Dialog>
      )}
    </div>
  );
}
