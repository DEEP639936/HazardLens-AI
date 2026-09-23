"use client";
// WorkOrders — the hazard-to-resolution dashboard.
//   AUTHORITY/ADMIN : KPI strip, board (Open → Assigned → In progress → Verification → Closed),
//                     filterable/sortable table, full detail dialog with assignment and evidence
//                     review. Final resolution verification (approve / reject) is ADMIN-only —
//                     authorities see read-only status here and are pointed to the admin console.
//   FIELD_WORKER    : "My assignments" — start work, upload before/after evidence, resolution
//                     notes; orders auto-advance to verification when the after photo lands.
// Transitions are enforced server-side; the UI only offers valid next steps.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, mediaUrl, uploadFile } from "@/lib/rg/api";
import { useApp } from "@/lib/rg/store";
import { CLASS_META, WO_STATUSES, WO_STATUS_META } from "@/lib/rg/constants";
import type { BboxDTO, MapResponse, PriorityBand, WorkOrderDTO } from "@/lib/rg/types";
import { BandBadge, ClassChip, EmptyState, SeverityDots, WoStatusChip } from "@/components/rg/primitives";
import { MediaFrame } from "@/components/rg/media";
import { SeverityBadge } from "@/components/rg/hazard-detail";
import { fmtDate, fmtRelative } from "@/lib/rg/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  GitMerge,
  HardHat,
  ImagePlus,
  Loader2,
  Map as MapIcon,
  PlayCircle,
  Search,
  ShieldCheck,
  UserPlus,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

type OrderItem = { kind: "order"; order: WorkOrderDTO };
type QueueItem = { kind: "queue"; hazard: MapResponse["hazards"][number] };
type BoardItem = OrderItem | QueueItem;

interface FieldWorker {
  id: string;
  name: string;
  email: string;
  role: string;
  ward?: string | null;
}

function toDayValue(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ */
/* Detail dialog                                                       */
/* ------------------------------------------------------------------ */
function WorkOrderDetail({
  item,
  detections,
  departments,
  teams,
  fieldWorkers,
  onClose,
}: {
  item: BoardItem;
  detections: BboxDTO[];
  departments: string[];
  teams: string[];
  fieldWorkers: FieldWorker[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { user } = useApp();
  const isWorker = user?.role === "FIELD_WORKER";
  const isAuthority = user?.role === "ADMIN" || user?.role === "AUTHORITY";
  const isAdmin = user?.role === "ADMIN";

  const order = item.kind === "order" ? item.order : null;
  const hazard = order?.hazard ?? (item.kind === "queue" ? item.hazard : null);
  const [department, setDepartment] = useState(order?.department ?? "");
  const [team, setTeam] = useState(order?.assignedTeam ?? "");
  const [workerId, setWorkerId] = useState(order?.assignedUserId ?? "");
  const [crewText, setCrewText] = useState(order?.assignedTo ?? "");
  const [due, setDue] = useState(toDayValue(order?.dueDate));
  const [note, setNote] = useState("");
  const [resolutionNotes, setResolutionNotes] = useState(order?.resolutionNotes ?? "");
  const [beforeId, setBeforeId] = useState<string | null>(order?.beforeMediaId ?? null);
  const [afterId, setAfterId] = useState<string | null>(order?.afterMediaId ?? null);
  const [uploading, setUploading] = useState<"before" | "after" | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");

  const status = order?.status ?? null;
  const mine = Boolean(isWorker && order?.assignedUserId === user?.id);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["work-orders"] });
    void qc.invalidateQueries({ queryKey: ["work-map"] });
    void qc.invalidateQueries({ queryKey: ["admin-dashboard"] });
    void qc.invalidateQueries({ queryKey: ["admin-dashboard-map"] });
    void qc.invalidateQueries({ queryKey: ["queue-map"] });
  };

  const createOrder = useMutation({
    mutationFn: () => {
      if (!hazard) throw new Error("Hazard context missing");
      return api<{ code: string; status: string }>("/api/work-orders", {
        json: {
          hazardReportId: hazard.id,
          department: department || undefined,
          assignedTeam: team || undefined,
          assignedUserId: workerId || undefined,
          assignedTo: !workerId && crewText.trim() ? crewText.trim() : undefined,
          dueDate: due ? new Date(`${due}T18:00:00`).toISOString() : undefined,
          note: note.trim() || undefined,
        },
      });
    },
    onSuccess: (r) => {
      toast.success(`${r.code} created`, { description: r.status === "ASSIGNED" ? "Crew assigned and notified" : "Added to the open queue" });
      invalidate();
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Could not create work order"),
  });

  const transition = useMutation({
    mutationFn: (payload: { status?: string; note?: string; assignedTo?: string; assignedUserId?: string; assignedTeam?: string | null; department?: string | null; dueDate?: string | null }) =>
      api(`/api/work-orders/${order?.id ?? ""}`, { method: "PATCH", json: payload }),
    onSuccess: (_r, payload) => {
      if (payload.status) toast.success(`Moved to ${WO_STATUS_META[payload.status as keyof typeof WO_STATUS_META].label.toLowerCase()}`);
      else toast.success("Work order updated");
      setNote("");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Update failed"),
  });

  const evidence = useMutation({
    mutationFn: (payload: { beforeMediaId?: string; afterMediaId?: string; resolutionNotes?: string }) =>
      api<{ status: string }>(`/api/work-orders/${order?.id ?? ""}/evidence`, { json: payload }),
    onSuccess: (r) => {
      toast.success("Evidence attached", { description: `Order is now ${WO_STATUS_META[r.status as keyof typeof WO_STATUS_META]?.label ?? r.status.toLowerCase()}.` });
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Evidence upload failed"),
  });

  const verify = useMutation({
    mutationFn: (payload: { decision: "approve" | "reject"; reason?: string }) =>
      api<{ status: string }>(`/api/work-orders/${order?.id ?? ""}/verify`, { json: payload }),
    onSuccess: (r, payload) => {
      toast.success(payload.decision === "approve" ? "Resolution verified — hazard closed out" : "Rework requested");
      if (payload.decision === "approve") onClose();
      else {
        setRejectOpen(false);
        setRejectReason("");
      }
      invalidate();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Verification failed"),
  });

  const onPickFile = async (slot: "before" | "after", file: File) => {
    setUploading(slot);
    try {
      const up = await uploadFile(file, false);
      if (slot === "before") setBeforeId(up.mediaId);
      else setAfterId(up.mediaId);
      toast.info(`${slot === "before" ? "Before" : "After"} photo attached`, { description: "Submit the evidence to update the work order." });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Photo upload failed");
    } finally {
      setUploading(null);
    }
  };

  const assignOpen = useMutation({
    mutationFn: () => {
      if (!order) throw new Error("Order context missing");
      return api(`/api/work-orders/${order.id}`, {
        method: "PATCH",
        json: {
          status: "ASSIGNED",
          assignedUserId: workerId || undefined,
          assignedTo: !workerId && crewText.trim() ? crewText.trim() : undefined,
          department: department || undefined,
          assignedTeam: team || undefined,
          dueDate: due ? new Date(`${due}T18:00:00`).toISOString() : undefined,
          note: note.trim() || undefined,
        },
      });
    },
    onSuccess: () => {
      toast.success("Crew assigned and notified");
      invalidate();
      onClose();
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Assign failed"),
  });

  const busy = createOrder.isPending || transition.isPending || evidence.isPending || verify.isPending || assignOpen.isPending || Boolean(uploading);

  return (
    <DialogContent className="max-h-[88vh] max-w-2xl overflow-y-auto scrollbar-slim">
      <DialogHeader>
        <DialogTitle className="flex flex-wrap items-center gap-2 font-display text-2xl">
          {hazard?.referenceCode ?? order?.code}
          {status ? <WoStatusChip status={status} /> : <span className="rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">Needs assignment</span>}
        </DialogTitle>
        {order && <p className="text-xs text-muted-foreground">{order.code} · {order.title}</p>}
      </DialogHeader>

      <MediaFrame mediaId={hazard?.media.find((m) => m.kind === "ORIGINAL")?.id ?? hazard?.media[0]?.id} alt="Reported hazard evidence" detections={detections} className="aspect-[4/3] w-full" />

      <div className="flex flex-wrap items-center gap-2.5">
        {hazard && <ClassChip cls={hazard.hazardClass} size="md" />}
        {hazard && hazard.severityBand && <SeverityBadge band={hazard.severityBand} />}
        {hazard && <SeverityDots severity={hazard.severity} />}
        {order && <BandBadge band={order.band} />}
        {order && (
          <span className="font-display text-lg font-semibold tabular-nums">
            {Math.round(order.priority)}
            <span className="text-[10px] font-normal text-muted-foreground">/100 risk</span>
          </span>
        )}
        {hazard && hazard.reportCount > 1 && (
          <span className="rounded-full bg-[#168266]/10 px-2 py-0.5 text-[10px] font-bold text-[#0f5c49]">{hazard.reportCount} community reports</span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-xl border border-border p-4 text-xs text-muted-foreground sm:grid-cols-3">
        <div><span className="block font-semibold text-foreground">Location</span>{hazard?.roadName ?? hazard?.address ?? "—"}</div>
        <div><span className="block font-semibold text-foreground">Ward / area</span>{hazard?.ward ?? "—"}</div>
        <div><span className="block font-semibold text-foreground">Reporter</span>{(hazard as { reporter?: string | null })?.reporter ?? (hazard as { submitterName?: string | null })?.submitterName ?? "Anonymous"}</div>
        {hazard && "lat" in hazard && hazard.lat != null && (
          <div><span className="block font-semibold text-foreground">Coordinates</span>{hazard.lat.toFixed(5)}, {hazard.lng.toFixed(5)}</div>
        )}
        <div><span className="block font-semibold text-foreground">Reported</span>{hazard?.createdAt ? fmtDate(hazard.createdAt, true) : "—"}</div>
        <div>
          <span className="block font-semibold text-foreground">Live map</span>
          <button
            className="mt-0.5 inline-flex items-center gap-1 font-semibold text-[#6A00F4] hover:underline"
            onClick={() => {
              useApp.getState().setView("map");
              onClose();
            }}
          >
            <MapIcon className="size-3" aria-hidden /> open map
          </button>
        </div>
        {hazard?.notes && (
          <div className="col-span-2 sm:col-span-3"><span className="block font-semibold text-foreground">Reporter notes</span>{hazard.notes}</div>
        )}
      </div>

      {/* ---------------- assignment panel (queue item or OPEN order) ---------------- */}
      {isAuthority && (status === null || status === "OPEN") && (
        <div className="rounded-xl border border-[#6A00F4]/25 bg-[#6A00F4]/[0.04] p-4">
          <p className="flex items-center gap-2 text-sm font-semibold"><UserPlus className="size-4 text-[#6A00F4]" aria-hidden /> {status === "OPEN" ? `Assign ${order?.code}` : "Create & assign work order"}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <Label>Department</Label>
              <Select value={department} onValueChange={setDepartment}>
                <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select department" /></SelectTrigger>
                <SelectContent>
                  {departments.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Field team</Label>
              <Select value={team} onValueChange={setTeam}>
                <SelectTrigger className="mt-1.5"><SelectValue placeholder="Select team" /></SelectTrigger>
                <SelectContent>
                  {teams.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Field worker</Label>
              <Select value={workerId} onValueChange={setWorkerId}>
                <SelectTrigger className="mt-1.5"><SelectValue placeholder={fieldWorkers.length ? "Select field worker" : "No field workers yet"} /></SelectTrigger>
                <SelectContent>
                  {fieldWorkers.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}{w.ward ? ` · ${w.ward}` : ""}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="w-crew-free">Or contractor / crew name</Label>
              <Input id="w-crew-free" className="mt-1.5" placeholder="e.g. Ward-12 patch crew" value={crewText} onChange={(e) => setCrewText(e.target.value)} disabled={Boolean(workerId)} />
            </div>
            <div>
              <Label htmlFor="w-due">Due date</Label>
              <Input id="w-due" type="date" className="mt-1.5" value={due} onChange={(e) => setDue(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="w-note">Instruction (optional)</Label>
              <Textarea id="w-note" rows={2} className="mt-1.5" placeholder="e.g. Cold-mix patch, divert traffic during pour" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <div className="mt-3">
            <Button className="bg-[#6A00F4] hover:bg-[#5a00d1]" disabled={busy || (!workerId && !crewText.trim() && status !== "OPEN")} onClick={() => (status === "OPEN" ? assignOpen.mutate() : createOrder.mutate())}>
              {createOrder.isPending || assignOpen.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ClipboardList className="size-4" aria-hidden />}
              {status === "OPEN" ? "Assign crew" : workerId || crewText.trim() ? "Create & assign" : "Create work order"}
            </Button>
            {status === "OPEN" && (
              <p className="mt-1.5 text-[11px] text-muted-foreground">Leave the crew fields empty to assign later — the order stays in the open queue.</p>
            )}
          </div>
        </div>
      )}

      {/* ---------------- ASSIGNED ---------------- */}
      {status === "ASSIGNED" && (
        <div className="rounded-xl border border-[#6A00F4]/25 bg-[#6A00F4]/[0.04] p-4">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            <HardHat className="size-4 text-[#6A00F4]" aria-hidden /> Assigned to {order?.assignedUserName ?? order?.assignedTo ?? "—"}
            {order?.assignedTeam && <span className="font-normal text-muted-foreground">· {order.assignedTeam}</span>}
            {order?.department && <span className="font-normal text-muted-foreground">· {order.department}</span>}
            {order?.dueDate && <span className="font-normal text-muted-foreground">· due {fmtDate(order.dueDate, false)}</span>}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {(isWorker ? mine : true) && (
              <Button className="bg-[#D97706] hover:bg-[#b45309]" disabled={busy} onClick={() => transition.mutate({ status: "IN_PROGRESS", note: note.trim() || undefined })}>
                <PlayCircle className="size-4" aria-hidden /> Start work
              </Button>
            )}
            {isAuthority && (
              <>
                <Select value={workerId} onValueChange={setWorkerId}>
                  <SelectTrigger className="h-9 w-44"><SelectValue placeholder="Reassign to…" /></SelectTrigger>
                  <SelectContent>
                    {fieldWorkers.map((w) => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button variant="outline" className="border-border" disabled={busy || !workerId} onClick={() => transition.mutate({ assignedUserId: workerId, note: note.trim() || undefined })}>
                  <UserPlus className="size-4" aria-hidden /> Reassign
                </Button>
                <div>
                  <Input type="date" className="h-9 w-40" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
                </div>
                <Button variant="outline" className="border-border" disabled={busy || !due} onClick={() => transition.mutate({ dueDate: due ? new Date(`${due}T18:00:00`).toISOString() : null })}>
                  <CalendarClock className="size-4" aria-hidden /> Update due date
                </Button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---------------- IN_PROGRESS ---------------- */}
      {status === "IN_PROGRESS" && (
        <div className="rounded-xl border border-[#168266]/30 bg-emerald-50/60 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-[#0f5c49]">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Repair in progress — crew: {order?.assignedUserName ?? order?.assignedTo ?? "—"}
          </p>
          {(mine || isAuthority) && (
            <div className="mt-3 space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <EvidenceSlot label="Before photo" mediaId={beforeId} onPick={(f) => void onPickFile("before", f)} uploading={uploading === "before"} />
                <EvidenceSlot label="After photo" mediaId={afterId} onPick={(f) => void onPickFile("after", f)} uploading={uploading === "after"} required />
              </div>
              <div>
                <Label htmlFor="w-res">Resolution notes</Label>
                <Textarea id="w-res" rows={2} className="mt-1.5" placeholder="e.g. Patched with hot mix, compacted and reopened at 14:20" value={resolutionNotes} onChange={(e) => setResolutionNotes(e.target.value)} />
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  className="bg-[#168266] hover:bg-[#0f5c49]"
                  disabled={busy || !afterId}
                  onClick={() => evidence.mutate({ beforeMediaId: beforeId ?? undefined, afterMediaId: afterId ?? undefined, resolutionNotes: resolutionNotes.trim() || undefined })}
                >
                  <ImagePlus className="size-4" aria-hidden /> Submit evidence for verification
                </Button>
                {isAuthority && (
                  <Button variant="outline" className="border-border" disabled={busy} onClick={() => transition.mutate({ status: "COMPLETED", note: resolutionNotes.trim() || note.trim() || undefined })}>
                    <CheckCircle2 className="size-4" aria-hidden /> Mark completed (no after photo yet)
                  </Button>
                )}
              </div>
              <p className="text-[11px] text-muted-foreground">Submitting the after photo moves the order to Completed → Verification pending automatically.</p>
            </div>
          )}
        </div>
      )}

      {/* ---------------- COMPLETED (awaiting evidence) ---------------- */}
      {status === "COMPLETED" && (
        <div className="rounded-xl border border-[#168266]/30 bg-emerald-50/60 p-4 text-sm text-[#0f5c49]">
          <p className="flex items-center gap-2 font-semibold"><CheckCircle2 className="size-4" aria-hidden /> Marked completed{order?.assignedTo ? ` by ${order.assignedTo}` : ""}.</p>
          {isAuthority ? (
            <div className="mt-2">
              <Button size="sm" variant="outline" className="border-border" disabled={busy} onClick={() => transition.mutate({ status: "VERIFICATION_PENDING" })}>
                <ShieldCheck className="size-4" aria-hidden /> Send for verification
              </Button>
            </div>
          ) : (
            <p className="mt-1 text-xs">Attach the after photo to send this order for authority verification.</p>
          )}
        </div>
      )}

      {/* ---------------- VERIFICATION_PENDING (final sign-off: ADMIN only) ---------------- */}
      {status === "VERIFICATION_PENDING" && isAuthority && (
        <div className="rounded-xl border border-[#B45309]/30 bg-orange-50/60 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-[#7a3a05]">
            <ShieldCheck className="size-4" aria-hidden /> Resolution submitted — before/after evidence under review
          </p>
          {isAdmin ? (
            <>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button className="bg-[#168266] hover:bg-[#0f5c49]" disabled={busy} onClick={() => verify.mutate({ decision: "approve" })}>
                  <CheckCircle2 className="size-4" aria-hidden /> Approve resolution
                </Button>
                <Button variant="outline" className="border-[#C83E4D]/40 text-[#C83E4D] hover:bg-[#C83E4D]/10" disabled={busy} onClick={() => setRejectOpen(true)}>
                  <XCircle className="size-4" aria-hidden /> Reject resolution
                </Button>
              </div>
              <p className="mt-2 text-[11px] text-[#7a3a05]/80">Approving verifies the repair — close the order from Resolution Verification to count the problem as resolved.</p>
            </>
          ) : (
            <p className="mt-1.5 text-xs leading-relaxed text-[#7a3a05]/80">
              Final sign-off is reserved for the main administrator. You will see the outcome here once they verify the evidence.
            </p>
          )}
        </div>
      )}

      {/* ---------------- VERIFIED / CLOSED ---------------- */}
      {(status === "VERIFIED" || status === "CLOSED") && (
        <div className="flex items-center gap-2 rounded-xl border border-[#168266]/30 bg-emerald-50/60 p-4 text-sm font-semibold text-[#0f5c49]">
          <CheckCircle2 className="size-4" aria-hidden />
          {status === "VERIFIED"
            ? `Resolution verified by ${order?.verifiedBy ?? "the administrator"}${order?.verifiedAt ? ` · ${fmtDate(order.verifiedAt, true)}` : ""}.`
            : "Work order closed. The full trail is in the timeline below."}
          {status === "VERIFIED" && isAdmin && (
            <Button size="sm" className="ml-auto bg-[#655D73] hover:bg-[#4d4759]" disabled={busy} onClick={() => transition.mutate({ status: "CLOSED" })}>
              Close work order
            </Button>
          )}
        </div>
      )}

      {order?.rejectReason && (
        <div className="rounded-xl border border-[#C83E4D]/30 bg-[#C83E4D]/[0.05] p-3 text-xs leading-relaxed text-[#C83E4D]">
          <strong>Previous rejection:</strong> {order.rejectReason}
        </div>
      )}

      {/* ---------------- evidence gallery ---------------- */}
      {order && (order.beforeMediaId || order.afterMediaId) && status !== null && (
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Repair evidence</p>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <EvidenceFrame label="Before" mediaId={order.beforeMediaId} at={order.startedAt} />
            <EvidenceFrame label="After" mediaId={order.afterMediaId} at={order.completedAt} />
          </div>
          {order.resolutionNotes && <p className="mt-2 rounded-lg bg-secondary/60 p-3 text-xs leading-relaxed"><span className="font-semibold">Resolution notes:</span> {order.resolutionNotes}</p>}
        </div>
      )}

      {/* ---------------- timeline ---------------- */}
      {order && order.updates.length > 0 && (
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

      {/* ---------------- reject dialog ---------------- */}
      <Dialog open={rejectOpen} onOpenChange={setRejectOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-xl">Reject this resolution?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">The order returns to the crew for rework. A clear reason is required and will notify both the crew and the reporter.</p>
          <Textarea rows={3} placeholder="e.g. Patch has not compacted to grade — redo and resubmit" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} aria-label="Rejection reason" />
          <Button className="w-full bg-[#C83E4D] hover:bg-[#a93344]" disabled={busy || !rejectReason.trim()} onClick={() => verify.mutate({ decision: "reject", reason: rejectReason.trim() })}>
            {verify.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <XCircle className="size-4" aria-hidden />} Reject & request rework
          </Button>
        </DialogContent>
      </Dialog>
    </DialogContent>
  );
}

function EvidenceSlot({ label, mediaId, onPick, uploading, required }: { label: string; mediaId: string | null; onPick: (f: File) => void; uploading: boolean; required?: boolean }) {
  return (
    <label className={cn("flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed p-3 text-center transition-colors hover:border-[#6A00F4]/60", mediaId ? "border-[#168266]/50 bg-[#168266]/[0.04]" : "border-border")}>
      {mediaId ? <img src={mediaUrl(mediaId)} alt={label} className="h-20 w-full rounded-lg object-cover" /> : <ImagePlus className="size-5 text-muted-foreground" aria-hidden />}
      <span className="text-xs font-medium">{label}{required && " *"}</span>
      <span className="text-[10px] text-muted-foreground">{uploading ? "Uploading…" : mediaId ? "Attached — tap to replace" : "Tap to upload"}</span>
      <input type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onPick(f); }} />
    </label>
  );
}

function EvidenceFrame({ label, mediaId, at }: { label: string; mediaId: string | null | undefined; at?: string | null }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <div className="aspect-[4/3] bg-muted/40">
        {mediaId ? <img src={mediaUrl(mediaId)} alt={`${label} repair evidence`} className="size-full object-cover" loading="lazy" /> : (
          <div className="flex size-full items-center justify-center text-xs text-muted-foreground">No {label.toLowerCase()} photo</div>
        )}
      </div>
      <p className="border-t border-border px-2.5 py-1.5 text-[11px] font-semibold text-muted-foreground">{label}{at ? ` · ${fmtDate(at, true)}` : ""}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main page                                                           */
/* ------------------------------------------------------------------ */
const COLUMNS = [
  { key: "queue", label: "Needs assignment", dot: "#655D73", hint: "New reports + open work orders" },
  { key: "ASSIGNED", label: "Assigned", dot: "#6A00F4", hint: "Crew booked, work not started" },
  { key: "IN_PROGRESS", label: "In progress", dot: "#D97706", hint: "Repairs happening right now" },
  { key: "verification", label: "Verification", dot: "#B45309", hint: "Completed work awaiting approval" },
  { key: "closed", label: "Verified · closed", dot: "#168266", hint: "Resolutions approved by the authority" },
] as const;

export function WorkOrders() {
  const { user } = useApp();
  const role = user?.role ?? "CITIZEN";
  const isWorker = role === "FIELD_WORKER";
  const isAuthority = role === "ADMIN" || role === "AUTHORITY";

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [classFilter, setClassFilter] = useState<string>("all");
  const [bandFilter, setBandFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 12;

  const ordersQ = useQuery({
    queryKey: ["work-orders"],
    queryFn: () => api<{ items: WorkOrderDTO[] }>("/api/work-orders"),
    staleTime: 15_000,
  });
  const mapQ = useQuery({
    queryKey: ["work-map"],
    queryFn: () => api<MapResponse>("/api/map?limit=500"),
    enabled: isAuthority,
    staleTime: 20_000,
  });
  const orgQ = useQuery({
    queryKey: ["org-config"],
    queryFn: () => api<{ settings: { org: { departments: string[]; teams: string[] }; actions: Record<string, string> } }>("/api/admin/settings"),
    enabled: isAuthority,
    staleTime: 60_000,
  });
  const workersQ = useQuery({
    queryKey: ["field-workers"],
    queryFn: () => api<{ items: FieldWorker[] }>("/api/users?role=FIELD_WORKER"),
    enabled: isAuthority,
    staleTime: 60_000,
  });

  const orders = ordersQ.data?.items ?? [];
  const hazards = mapQ.data?.hazards ?? [];
  const hazardById = useMemo(() => new Map(hazards.map((h) => [h.id, h])), [hazards]);

  const queue = useMemo(() => {
    if (!isAuthority) return [];
    const withOrder = new Set(orders.map((o) => o.hazardReportId).filter(Boolean) as string[]);
    return hazards
      .filter((h) => h.status !== "REJECTED" && h.status !== "MERGED" && !withOrder.has(h.id) && !h.workOrderStatus)
      .sort((a, b) => (b.priority?.score ?? 0) - (a.priority?.score ?? 0));
  }, [hazards, orders, isAuthority]);

  const departments = orgQ.data?.settings.org.departments ?? [];
  const teams = orgQ.data?.settings.org.teams ?? [];
  const fieldWorkers = workersQ.data?.items ?? [];

  const loading = ordersQ.isLoading || (isAuthority && mapQ.isLoading);

  /* KPIs */
  const kpis = isWorker
    ? [
        { label: "My assignments", value: orders.length, color: "#6A00F4" },
        { label: "Not started", value: orders.filter((o) => o.status === "ASSIGNED").length, color: "#655D73" },
        { label: "In progress", value: orders.filter((o) => o.status === "IN_PROGRESS").length, color: "#D97706" },
        { label: "Awaiting verification", value: orders.filter((o) => ["COMPLETED", "VERIFICATION_PENDING"].includes(o.status)).length, color: "#B45309" },
      ]
    : [
        { label: "Open + needs assignment", value: orders.filter((o) => o.status === "OPEN").length + queue.length, color: "#655D73" },
        { label: "In progress", value: orders.filter((o) => o.status === "IN_PROGRESS" || o.status === "ASSIGNED").length, color: "#6A00F4" },
        { label: "Verification pending", value: orders.filter((o) => o.status === "COMPLETED" || o.status === "VERIFICATION_PENDING").length, color: "#B45309" },
        { label: "Problems resolved", value: orders.filter((o) => o.status === "VERIFIED" || o.status === "CLOSED").length, color: "#168266" },
      ];

  const highPriority = orders.filter((o) => o.priority >= 51 && !["VERIFIED", "CLOSED"].includes(o.status)).length;

  /* board columns (labels resolved at render time) */
  const boardItems = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matchHazard = (h: NonNullable<WorkOrderDTO["hazard"]> | QueueItem["hazard"]) => {
      if (q && ![h.referenceCode, h.roadName, h.address, h.ward].some((v) => v?.toLowerCase().includes(q))) return false;
      if (classFilter !== "all" && h.hazardClass !== classFilter) return false;
      return true;
    };
    return COLUMNS.map((c) => {
      let items: BoardItem[] = [];
      if (c.key === "queue") {
        items = isWorker
          ? orders.filter((o) => o.status === "ASSIGNED").map((o) => ({ kind: "order" as const, order: o }))
          : [...queue.map((h) => ({ kind: "queue" as const, hazard: h })), ...orders.filter((o) => o.status === "OPEN").map((o) => ({ kind: "order" as const, order: o }))];
      } else if (c.key === "verification") {
        items = orders.filter((o) => o.status === "COMPLETED" || o.status === "VERIFICATION_PENDING").map((o) => ({ kind: "order" as const, order: o }));
      } else if (c.key === "closed") {
        items = orders.filter((o) => o.status === "VERIFIED" || o.status === "CLOSED").map((o) => ({ kind: "order" as const, order: o }));
      } else {
        items = orders.filter((o) => o.status === c.key).map((o) => ({ kind: "order" as const, order: o }));
      }
      items = items.filter((it) => (it.kind === "order" ? it.order.hazard ? matchHazard(it.order.hazard) : true : matchHazard(it.hazard)));
      if (bandFilter !== "all") items = items.filter((it) => (it.kind === "order" ? it.order.band === bandFilter : (it.hazard.priority?.band ?? "") === bandFilter));
      const label = c.key === "queue" ? (isWorker ? "My queue" : "Needs assignment") : c.label;
      const hint = c.key === "queue" ? (isWorker ? "Waiting for an authority to assign" : "New reports + open work orders") : c.hint;
      return { ...c, label, hint, items };
    });
  }, [orders, queue, search, classFilter, bandFilter, isWorker]);

  /* table rows with sorting + pagination */
  const tableRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows: BoardItem[] = [
      ...queue.map((h) => ({ kind: "queue" as const, hazard: h })),
      ...orders.map((o) => ({ kind: "order" as const, order: o })),
    ];
    rows = rows.filter((it) => {
      const h = it.kind === "order" ? it.order.hazard : it.hazard;
      if (h) {
        if (q && ![h.referenceCode, h.roadName, h.address, h.ward].some((v) => v?.toLowerCase().includes(q))) return false;
        if (classFilter !== "all" && h.hazardClass !== classFilter) return false;
      }
      if (statusFilter !== "all") {
        const st = it.kind === "order" ? it.order.status : null;
        if (statusFilter === "UNASSIGNED" && it.kind !== "queue") return false;
        if (statusFilter !== "UNASSIGNED" && st !== statusFilter) return false;
      }
      if (bandFilter !== "all" && (it.kind === "order" ? it.order.band !== bandFilter : (it.hazard.priority?.band ?? "") !== bandFilter)) return false;
      return true;
    });
    rows.sort((a, b) => {
      const pa = a.kind === "order" ? a.order.priority : (a.hazard.priority?.score ?? 0);
      const pb = b.kind === "order" ? b.order.priority : (b.hazard.priority?.score ?? 0);
      return pb - pa;
    });
    return rows;
  }, [orders, queue, search, statusFilter, classFilter, bandFilter]);

  const pageCount = Math.max(1, Math.ceil(tableRows.length / PAGE_SIZE));
  const pagedRows = tableRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const itemKey = (it: BoardItem) => (it.kind === "order" ? `o-${it.order.id}` : `h-${it.hazard.id}`);
  const selectedItem: BoardItem | null = useMemo(() => {
    if (!selectedKey) return null;
    if (selectedKey.startsWith("o-")) {
      const o = orders.find((x) => x.id === selectedKey.slice(2));
      return o ? { kind: "order", order: o } : null;
    }
    const h = hazards.find((x) => x.id === selectedKey.slice(2));
    return h ? { kind: "queue", hazard: h } : null;
  }, [selectedKey, orders, hazards]);

  const selectedDetections = selectedItem
    ? selectedItem.kind === "order"
      ? selectedItem.order.hazard
        ? hazardById.get(selectedItem.order.hazard.id)?.detections ?? []
        : []
      : hazardById.get(selectedItem.hazard.id)?.detections ?? []
    : [];

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#6A00F4]">{isWorker ? "Field workspace" : "Management"}</p>
          <h1 className="mt-2 font-display text-4xl tracking-tight">{isWorker ? "My Assignments" : "Work Orders"}</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
            {isWorker
              ? "Start your assigned repairs, upload before/after evidence and submit for authority verification."
              : "The full hazard-to-resolution pipeline: assign crews, track repairs, verify before/after evidence and close the loop — reporters are notified at each step."}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {kpis.map((k) => (
            <div key={k.label} className="rounded-xl border border-border bg-card px-4 py-3 text-center">
              <p className="font-display text-2xl font-semibold tabular-nums" style={{ color: k.color }}>{loading ? "—" : k.value}</p>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{k.label}</p>
            </div>
          ))}
        </div>
      </div>

      {!isWorker && highPriority > 0 && (
        <div className="mt-4 flex items-center gap-2 rounded-xl border border-[#D97706]/30 bg-[#D97706]/[0.06] px-4 py-2.5 text-sm text-[#7a3a05]">
          <GitMerge className="size-4 shrink-0" aria-hidden />
          {highPriority} high/critical-risk work order{highPriority === 1 ? "" : "s"} still in flight — prioritize these queues.
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input className="w-60 pl-9" placeholder="Search ref, road, ward…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} aria-label="Search work items" />
        </div>
        <select className="h-9 rounded-md border border-border bg-card px-3 text-sm" value={classFilter} onChange={(e) => { setClassFilter(e.target.value); setPage(1); }} aria-label="Filter by hazard class">
          <option value="all">All hazard types</option>
          {Object.entries(CLASS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
        <select className="h-9 rounded-md border border-border bg-card px-3 text-sm" value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} aria-label="Filter by status">
          <option value="all">All statuses</option>
          {isAuthority && <option value="UNASSIGNED">Needs assignment</option>}
          {WO_STATUSES.map((s) => <option key={s} value={s}>{WO_STATUS_META[s].label}</option>)}
        </select>
        <select className="h-9 rounded-md border border-border bg-card px-3 text-sm" value={bandFilter} onChange={(e) => { setBandFilter(e.target.value); setPage(1); }} aria-label="Filter by risk band">
          <option value="all">Any risk band</option>
          {(["CRITICAL", "HIGH", "MODERATE", "LOW"] as PriorityBand[]).map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
      </div>

      <Tabs defaultValue="board" className="mt-5">
        <TabsList className="h-11">
          <TabsTrigger value="board">{isWorker ? "My queue" : "Board"}</TabsTrigger>
          <TabsTrigger value="list">Table</TabsTrigger>
        </TabsList>

        <TabsContent value="board" className="mt-5">
          {loading ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              {[0, 1, 2, 3, 4].map((i) => <div key={i} className="h-40 animate-pulse rounded-xl bg-secondary/60" />)}
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              {boardItems.map((col) => (
                <section key={col.key} aria-label={col.label} className="rounded-2xl border border-border bg-secondary/40 p-3">
                  <div className="flex items-center justify-between gap-2 px-1 pb-1">
                    <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      <span className="size-2 rounded-full" style={{ background: col.dot }} aria-hidden />
                      {col.label}
                    </p>
                    <span className="rounded-full border border-border bg-card px-2 py-0.5 text-[10px] font-bold text-muted-foreground">{col.items.length}</span>
                  </div>
                  <p className="px-1 pb-2 text-[11px] text-muted-foreground/80">{col.hint}</p>
                  <div className="max-h-[calc(100vh-400px)] min-h-24 space-y-2.5 overflow-y-auto scrollbar-slim pr-0.5">
                    {col.items.length === 0 ? (
                      <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">Nothing here right now</p>
                    ) : (
                      col.items.map((it) => <WorkCard key={itemKey(it)} item={it} onOpen={() => setSelectedKey(itemKey(it))} />)
                    )}
                  </div>
                </section>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="list" className="mt-5">
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <div className="max-h-[68vh] overflow-auto scrollbar-slim">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-3 font-semibold">ID</th>
                    <th className="px-4 py-3 font-semibold">Hazard</th>
                    <th className="px-4 py-3 font-semibold">Location</th>
                    <th className="px-4 py-3 font-semibold">Severity</th>
                    <th className="px-4 py-3 font-semibold">Priority</th>
                    <th className="hidden px-4 py-3 font-semibold lg:table-cell">Department</th>
                    <th className="hidden px-4 py-3 font-semibold lg:table-cell">Team / crew</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="hidden px-4 py-3 font-semibold xl:table-cell">Due</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {loading && <tr><td colSpan={9} className="px-4 py-10 text-center text-muted-foreground">Loading work orders…</td></tr>}
                  {!loading && pagedRows.length === 0 && <tr><td colSpan={9} className="px-4 py-10 text-center text-muted-foreground">No work orders match the current filters.</td></tr>}
                  {!loading &&
                    pagedRows.map((it) => {
                      const h = it.kind === "order" ? it.order.hazard : it.hazard;
                      const order = it.kind === "order" ? it.order : null;
                      return (
                        <tr key={itemKey(it)} className="cursor-pointer transition-colors hover:bg-secondary" onClick={() => setSelectedKey(itemKey(it))}>
                          <td className="px-4 py-3 font-mono text-[11px] font-semibold text-[#6A00F4]">{order?.code ?? h?.referenceCode}</td>
                          <td className="px-4 py-3">{h && <ClassChip cls={h.hazardClass} />}</td>
                          <td className="max-w-48 truncate px-4 py-3">{h?.roadName ?? h?.address ?? "—"}</td>
                          <td className="px-4 py-3">{h && <SeverityDots severity={h.severity} />}</td>
                          <td className="px-4 py-3">
                            {order ? (
                              <span className="font-bold tabular-nums">{Math.round(order.priority)}</span>
                            ) : it.kind === "queue" && it.hazard.priority ? (
                              <span className="font-bold tabular-nums">{Math.round(it.hazard.priority.score)}</span>
                            ) : ("—")}
                          </td>
                          <td className="hidden px-4 py-3 lg:table-cell">{order?.department ?? "—"}</td>
                          <td className="hidden max-w-36 truncate px-4 py-3 lg:table-cell">{order?.assignedTeam ?? order?.assignedTo ?? "—"}</td>
                          <td className="px-4 py-3">
                            {order ? (
                              <WoStatusChip status={order.status} />
                            ) : (
                              <span className="rounded-full border border-amber-200 bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">Needs assignment</span>
                            )}
                          </td>
                          <td className="hidden px-4 py-3 text-muted-foreground xl:table-cell">{order?.dueDate ? fmtDate(order.dueDate, false) : "—"}</td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              <span>{tableRows.length} item{tableRows.length === 1 ? "" : "s"} · page {page} of {pageCount}</span>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="h-8 border-border" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
                <Button size="sm" variant="outline" className="h-8 border-border" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>Next</Button>
              </div>
            </div>
          </div>
        </TabsContent>
      </Tabs>

      {!loading && queue.length === 0 && orders.length === 0 && (
        <EmptyState
          title={isWorker ? "No assignments yet" : "The work board is clear"}
          hint={isWorker ? "When an authority assigns you a repair it appears here with full location details." : "Once citizens report potholes, they appear here for assignment."}
          icon={<ClipboardList className="size-5" aria-hidden />}
        />
      )}

      <Dialog open={Boolean(selectedItem)} onOpenChange={(o) => !o && setSelectedKey(null)}>
        {selectedItem && (
          <WorkOrderDetail
            key={`${itemKey(selectedItem)}-${selectedItem.kind === "order" ? selectedItem.order.status : "queue"}`}
            item={selectedItem}
            detections={selectedDetections}
            departments={departments}
            teams={teams}
            fieldWorkers={fieldWorkers}
            onClose={() => setSelectedKey(null)}
          />
        )}
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Board card                                                          */
/* ------------------------------------------------------------------ */
function WorkCard({ item, onOpen }: { item: BoardItem; onOpen: () => void }) {
  const h = item.kind === "order" ? item.order.hazard : item.hazard;
  const order = item.kind === "order" ? item.order : null;
  if (!h) return null;
  const cls = CLASS_META[h.hazardClass];
  const hp = (h as { priority?: { band: PriorityBand; score: number } | null }).priority ?? null;
  const band: PriorityBand | null = order?.band ?? hp?.band ?? null;
  const score = order ? order.priority : hp?.score ?? null;
  const src = h.media.find((m) => m.kind === "ORIGINAL")?.id ?? h.media[0]?.id;

  return (
    <button
      onClick={onOpen}
      className="w-full rounded-xl border border-border bg-card p-3 text-left transition-all hover:-translate-y-px hover:border-[#6A00F4]/40 hover:shadow-[0_10px_24px_-14px_rgba(106,0,244,0.45)]"
    >
      <div className="flex gap-3">
        <div className="relative size-12 shrink-0 overflow-hidden rounded-lg border border-border bg-secondary">
          {src ? (
            <img src={mediaUrl(src)} alt={`Evidence for ${h.referenceCode}`} className="size-full object-cover" loading="lazy" />
          ) : (
            <span className="flex size-full items-center justify-center text-[10px] font-bold text-white" style={{ background: cls.color }} aria-hidden>
              {cls.short.slice(0, 2).toUpperCase()}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[11px] font-semibold text-[#6A00F4]">{order?.code ?? h.referenceCode}</span>
            {band && <BandBadge band={band} />}
          </div>
          <p className="mt-0.5 truncate text-sm font-semibold">{h.roadName ?? h.address ?? "Unnamed location"}</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <ClassChip cls={h.hazardClass} />
            <SeverityDots severity={h.severity} />
          </div>
          {order?.assignedTo && (
            <p className="mt-1.5 flex items-center gap-1 truncate text-[11px] font-medium text-[#4d00b3]">
              <HardHat className="size-3 shrink-0" aria-hidden /> {order.assignedTo}
              {order.dueDate && <span className="font-normal text-muted-foreground"> · due {fmtDate(order.dueDate, false)}</span>}
            </p>
          )}
          {score != null && score > 0 && (
            <p className="mt-1 text-[10px] text-muted-foreground">
              risk <span className="font-bold tabular-nums text-foreground">{Math.round(score)}</span>/100 · reported {fmtRelative(h.createdAt)}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}
