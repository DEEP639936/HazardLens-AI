"use client";
// HazardDetailSheet — the explainable hazard detail drawer shared by the Live Map,
// Hazard Alerts, Hazard Queue and My Reports. Renders the three distinct AI concepts
// side by side (AI confidence ≠ risk score ≠ severity), the community report count,
// the recommended action (backend-configured) and the "Why this risk score?" panel.
// When the repair is awaiting sign-off it also shows the contractor's before/after
// evidence — verification (verify & close / reject) is reserved for the main ADMIN.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { BAND_META, CLASS_META, SEVERITY_BAND_META, WO_STATUS_META } from "@/lib/rg/constants";
import { api, mediaUrl } from "@/lib/rg/api";
import { useApp } from "@/lib/rg/store";
import type { HazardDTO } from "@/lib/rg/types";
import { BandBadge, ClassChip, PriorityGauge, StatusChip } from "@/components/rg/primitives";
import { MediaFrame } from "@/components/rg/media";
import { fmtDate, fmtRelative } from "@/lib/rg/format";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { AlertTriangle, CheckCircle2, CircleAlert, Loader2, MapPin, ShieldCheck, Users, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { SeverityBand } from "@/lib/rg/types";

export function SeverityBadge({ band, className }: { band: SeverityBand; className?: string }) {
  const meta = SEVERITY_BAND_META[band];
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-bold tracking-wide", meta.chip, className)}>
      <AlertTriangle className="size-3" aria-hidden />
      {meta.label.toUpperCase()}
    </span>
  );
}

function RiskFactorRow({ label, met, detail }: { label: string; met: boolean; detail: string }) {
  const Icon = met ? CheckCircle2 : CircleAlert;
  return (
    <li className="flex gap-2.5 py-1.5">
      <Icon className={cn("mt-0.5 size-4 shrink-0", met ? "text-[#168266]" : "text-muted-foreground/50")} aria-hidden />
      <div className="min-w-0">
        <p className={cn("text-sm font-medium", met ? "text-foreground" : "text-muted-foreground")}>{label}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </li>
  );
}

/** Compact risk strip used inside list rows (alerts, queue). */
export function RiskChip({ hazard }: { hazard: HazardDTO }) {
  if (!hazard.priority) return null;
  const color = BAND_META[hazard.priority.band].color;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5">
      <span className="size-1.5 rounded-full" style={{ background: color }} aria-hidden />
      <span className="text-[11px] font-bold tabular-nums" style={{ color }}>
        {Math.round(hazard.priority.score)}
      </span>
      <span className="text-[10px] text-muted-foreground">risk</span>
    </span>
  );
}

export function AiConfidenceChip({ hazard }: { hazard: HazardDTO }) {
  const top = hazard.detections[0];
  if (!top) {
    return (
      <span className="inline-flex items-center rounded-full border border-border bg-secondary/60 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
        No AI detection
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[#8B3DFF]/30 bg-[#8B3DFF]/10 px-2.5 py-0.5 text-[11px] font-bold text-[#4d00b3]">
      AI confidence {(top.confidence * 100).toFixed(1)}%
    </span>
  );
}

export function HazardDetailSheet({
  hazard,
  onClose,
  actions,
}: {
  hazard: HazardDTO | null;
  onClose: () => void;
  /** Optional authority action bar (verification panel passes its buttons). */
  actions?: React.ReactNode;
}) {
  const [whyOpen, setWhyOpen] = useState(true);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const qc = useQueryClient();
  const role = useApp((s) => s.user?.role ?? "CITIZEN");
  const isAdmin = role === "ADMIN";

  const invalidate = () => {
    void qc.invalidateQueries(); // hazard sheets render from many queries (map/alerts/reports/queue)
  };

  /* approve → VERIFIED, then VERIFIED → CLOSED: one click verifies and closes the problem. */
  const verifyAndClose = useMutation({
    mutationFn: async () => {
      if (!hazard?.workOrder) throw new Error("Work order missing");
      await api<{ status: string }>(`/api/work-orders/${hazard.workOrder.id}/verify`, { json: { decision: "approve" } });
      return api<{ status: string }>(`/api/work-orders/${hazard.workOrder.id}`, {
        method: "PATCH",
        json: { status: "CLOSED", note: "Resolution verified by administrator — problem closed." },
      });
    },
    onSuccess: () => {
      toast.success("Problem verified & closed", { description: `${hazard?.referenceCode ?? "Hazard"} is now counted under Problems resolved on the dashboard.` });
      invalidate();
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Verification failed"),
  });

  const reject = useMutation({
    mutationFn: () =>
      api<{ status: string }>(`/api/work-orders/${hazard?.workOrder?.id ?? ""}/verify`, { json: { decision: "reject", reason: rejectReason.trim() } }),
    onSuccess: () => {
      toast.success("Resolution rejected", { description: "The order returns to the crew for rework; reporter and crew were notified." });
      setRejectOpen(false);
      setRejectReason("");
      invalidate();
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Rejection failed"),
  });

  if (!hazard) return null;
  const band = hazard.priority ? BAND_META[hazard.priority.band] : null;
  const flags = hazard.priority?.riskFlags ?? [];
  const metFlags = flags.filter((f) => f.met).length;
  const wo = hazard.workOrder ?? null;
  const woPending = wo?.status === "VERIFICATION_PENDING";
  const woResolved = wo?.status === "VERIFIED" || wo?.status === "CLOSED";

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto scrollbar-slim sm:max-w-md">
        <SheetHeader className="p-0">
          <SheetTitle className="flex flex-wrap items-center gap-2 font-display text-2xl">
            {hazard.referenceCode}
            <StatusChip status={hazard.status} />
          </SheetTitle>
          <SheetDescription>
            <span className="inline-flex items-center gap-1.5 text-xs">
              <MapPin className="size-3.5" aria-hidden />
              {hazard.address ?? `${hazard.lat.toFixed(5)}, ${hazard.lng.toFixed(5)}`} · {hazard.ward ?? "ward n/a"}
            </span>
          </SheetDescription>
        </SheetHeader>

        <div className="mt-2 space-y-5 px-4 pb-10 sm:px-0">
          <MediaFrame
            mediaId={hazard.media.find((m) => m.kind === "ORIGINAL")?.id ?? hazard.media[0]?.id}
            alt={`${hazard.hazardClass} at ${hazard.roadName ?? hazard.ward ?? "reported location"}`}
            detections={hazard.detections}
            className="aspect-[4/3] w-full"
          />

          <div className="flex flex-wrap items-center gap-2">
            <ClassChip cls={hazard.hazardClass} size="md" />
            <SeverityBadge band={hazard.severityBand} />
            <AiConfidenceChip hazard={hazard} />
          </div>

          {/* -------- risk score + recommended action -------- */}
          <div className="flex items-center gap-5 rounded-2xl border border-border bg-card p-4">
            <PriorityGauge priority={hazard.priority} />
            <div className="min-w-0 text-sm">
              <p className="font-semibold">
                {hazard.priority?.recommendedAction ?? band?.action ?? "Awaiting risk assessment"}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {hazard.roadName ? `On ${hazard.roadName}. ` : ""}
                {hazard.detections[0]
                  ? `Top detection via ${hazard.detections[0].engine}. AI confidence is the model's certainty — the risk score is a separate maintenance signal.`
                  : "No AI detection attached; risk uses community and road signals."}
              </p>
            </div>
          </div>

          {/* -------- why this risk score -------- */}
          {hazard.priority && (
            <Accordion type="single" collapsible value={whyOpen ? "why" : ""} onValueChange={(v) => setWhyOpen(v.includes("why"))}>
              <AccordionItem value="why" className="rounded-xl border border-border bg-card px-4">
                <AccordionTrigger className="py-3.5 text-sm font-semibold hover:no-underline">
                  <span className="flex items-center gap-2">
                    Why this risk score?
                    <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-bold text-secondary-foreground">
                      {metFlags}/{flags.length} factors
                    </span>
                  </span>
                </AccordionTrigger>
                <AccordionContent className="pb-4">
                  <ul className="divide-y divide-border/60">
                    {flags.map((f) => (
                      <RiskFactorRow key={f.key} label={f.label} met={f.met} detail={f.detail} />
                    ))}
                  </ul>
                  <div className="mt-3 space-y-1.5 rounded-lg bg-secondary/50 p-3">
                    {hazard.priority.factors.map((f) => (
                      <div key={f.key} className="flex items-center gap-2 text-[11px]">
                        <span className="w-32 shrink-0 font-medium text-muted-foreground">{f.label}</span>
                        <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
                          <span
                            className="block h-full rounded-full"
                            style={{ width: `${Math.min(100, (f.contribution / 32) * 100)}%`, background: BAND_META[hazard.priority!.band].color }}
                          />
                        </span>
                        <span className="w-10 text-right font-bold tabular-nums text-foreground">+{f.contribution.toFixed(1)}</span>
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          )}

          {/* -------- community reports -------- */}
          <div className="flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3">
            <div className="flex items-center gap-2.5">
              <Users className="size-4 text-[#6A00F4]" aria-hidden />
              <div className="text-sm">
                <span className="font-bold">{hazard.reportCount}</span> report{hazard.reportCount === 1 ? "" : "s"} ·{" "}
                <span className="font-bold">{hazard.uniqueReporters}</span> unique reporter{hazard.uniqueReporters === 1 ? "" : "s"}
              </div>
            </div>
            <span className="text-xs text-muted-foreground">last {fmtRelative(hazard.lastReportedAt ?? hazard.createdAt)}</span>
          </div>

          {hazard.mergedEvidence.length > 0 && (
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Community evidence</h3>
              <div className="mt-2 flex gap-2 overflow-x-auto pb-1 scrollbar-slim">
                {hazard.mergedEvidence.map((m) => (
                  <a key={m.id} href={`/api/media/${m.id}`} target="_blank" rel="noreferrer" className="group relative size-20 shrink-0 overflow-hidden rounded-lg border border-border">
                    <img src={`/api/media/${m.id}`} alt={`Evidence from ${m.referenceCode}`} className="size-full object-cover transition-transform group-hover:scale-105" loading="lazy" />
                    <span className="absolute inset-x-0 bottom-0 truncate bg-background/80 px-1 py-0.5 text-[9px] font-semibold">{m.referenceCode}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {hazard.notes && (
            <div>
              <h3 className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Reporter notes</h3>
              <p className="mt-1.5 text-sm leading-relaxed">{hazard.notes}</p>
            </div>
          )}

          {/* -------- repair verification (contractor evidence → admin sign-off) -------- */}
          {wo && (woPending || woResolved || wo.beforeMediaId || wo.afterMediaId) && (
            <div className={cn("rounded-2xl border p-4", woPending ? "border-[#B45309]/30 bg-orange-50/50" : "border-[#168266]/30 bg-emerald-50/40")}>
              <h3 className={cn("flex items-center gap-2 text-sm font-bold", woPending ? "text-[#7a3a05]" : "text-[#0f5c49]")}>
                <ShieldCheck className="size-4" aria-hidden />
                {woPending ? "Repair verification pending" : woResolved ? "Repair verified" : "Repair evidence"}
              </h3>
              {woPending && (
                <p className="mt-1 text-xs leading-relaxed text-[#7a3a05]/85">
                  The contractor uploaded before/after evidence. {isAdmin ? "As the administrator, you can verify the work and close this problem." : "Only the main administrator can verify and close it."}
                </p>
              )}
              <div className="mt-3 grid grid-cols-2 gap-2.5">
                <div className="overflow-hidden rounded-xl border border-[#655D73]/30 bg-card">
                  <div className="aspect-[4/3] bg-muted/40">
                    {wo.beforeMediaId ? (
                      <img src={mediaUrl(wo.beforeMediaId)} alt="Before repair — hazard present" className="size-full object-cover" loading="lazy" />
                    ) : (
                      <div className="flex size-full items-center justify-center text-[11px] text-muted-foreground">No before photo</div>
                    )}
                  </div>
                  <p className="border-t border-border px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Before</p>
                </div>
                <div className="overflow-hidden rounded-xl border border-[#168266]/40 bg-card">
                  <div className="aspect-[4/3] bg-muted/40">
                    {wo.afterMediaId ? (
                      <img src={mediaUrl(wo.afterMediaId)} alt="After repair — hazard resolved" className="size-full object-cover" loading="lazy" />
                    ) : (
                      <div className="flex size-full items-center justify-center text-[11px] text-muted-foreground">No after photo</div>
                    )}
                  </div>
                  <p className="border-t border-border px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">After</p>
                </div>
              </div>
              {wo.resolutionNotes && <p className="mt-2 text-xs leading-relaxed text-muted-foreground"><span className="font-semibold text-foreground">Crew notes:</span> {wo.resolutionNotes}</p>}
              {woPending && isAdmin && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" className="bg-[#168266] hover:bg-[#0f5c49]" disabled={verifyAndClose.isPending || reject.isPending} onClick={() => verifyAndClose.mutate()}>
                    {verifyAndClose.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <CheckCircle2 className="size-4" aria-hidden />}
                    Verify &amp; close problem
                  </Button>
                  <Button size="sm" variant="outline" className="border-[#C83E4D]/40 text-[#C83E4D] hover:bg-[#C83E4D]/10" disabled={verifyAndClose.isPending || reject.isPending} onClick={() => setRejectOpen(true)}>
                    <XCircle className="size-4" aria-hidden /> Reject
                  </Button>
                </div>
              )}
              {woPending && !isAdmin && (
                <p className="mt-2 text-[11px] text-muted-foreground">Status: {WO_STATUS_META[wo.status].label} — the administrator signs off final resolutions.</p>
              )}
              {woResolved && (
                <p className="mt-2 text-xs font-medium text-[#0f5c49]">
                  Verified{wo.verifiedBy ? ` by ${wo.verifiedBy}` : ""}{wo.verifiedAt ? ` · ${fmtDate(wo.verifiedAt, true)}` : ""} — this problem is counted as resolved on the dashboard.
                </p>
              )}
            </div>
          )}

          {/* -------- meta grid -------- */}
          <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
            <div><span className="font-semibold text-foreground">Detected</span><br />{fmtDate(hazard.createdAt, true)}</div>
            <div><span className="font-semibold text-foreground">Last updated</span><br />{fmtDate(hazard.updatedAt, true)}</div>
            <div><span className="font-semibold text-foreground">Reviewed</span><br />{hazard.reviewedAt ? fmtRelative(hazard.reviewedAt) : "pending"}</div>
            <div><span className="font-semibold text-foreground">Road class</span><br />{hazard.roadClass ?? "—"}</div>
            <div><span className="font-semibold text-foreground">Status</span><br />{hazard.status.replace(/_/g, " ").toLowerCase()}</div>
            <div><span className="font-semibold text-foreground">Maintenance</span><br />{hazard.workOrderStatus ? hazard.workOrderStatus.replace(/_/g, " ").toLowerCase() : "no work order"}</div>
          </div>

          {actions && <div className="space-y-2 border-t border-border pt-4">{actions}</div>}
        </div>

        {/* reject dialog — reason mandatory, mirrors the verification console */}
        <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="font-display text-xl">Reject this resolution?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">The order returns to the crew for rework. A clear reason is required and will notify both the crew and the reporter.</p>
            <Textarea rows={3} placeholder="e.g. Patch has not compacted to grade — redo and resubmit" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} aria-label="Rejection reason" />
            <Button className="w-full bg-[#C83E4D] hover:bg-[#a93344]" disabled={reject.isPending || !rejectReason.trim()} onClick={() => reject.mutate()}>
              {reject.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <XCircle className="size-4" aria-hidden />} Reject &amp; request rework
            </Button>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}

/** Chevron-style lifecycle stepper used in the queue/work dialogs. */
export function LifecycleTrace({ stages }: { stages: { label: string; done: boolean; note?: string }[] }) {
  return (
    <ol className="space-y-1.5">
      {stages.map((s, i) => (
        <li key={i} className="flex items-start gap-2 text-sm">
          {s.done ? (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-[#168266]" aria-hidden />
          ) : (
            <span className="mt-1 size-2.5 shrink-0 rounded-full border-2 border-border" aria-hidden />
          )}
          <span className={cn(s.done ? "font-medium text-foreground" : "text-muted-foreground")}>
            {s.label}
            {s.note && <span className="block text-xs text-muted-foreground">{s.note}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
