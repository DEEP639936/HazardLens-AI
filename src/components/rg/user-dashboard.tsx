"use client";
// My Reports — citizen report tracking, timeline, personal map, notifications, privacy settings.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, mediaUrl } from "@/lib/rg/api";
import { useApp } from "@/lib/rg/store";
import { dynamicImport } from "@/lib/rg/lazy";
import { BAND_META, CLASS_META, WO_STATUS_META } from "@/lib/rg/constants";
import type { HazardDTO, NotificationDTO } from "@/lib/rg/types";
import { BandBadge, ClassChip, EmptyState, PriorityGauge, SeverityDots, StatusChip, WoStatusChip } from "@/components/rg/primitives";
import { MediaFrame } from "@/components/rg/media";
import { fmtDate, fmtRelative } from "@/lib/rg/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Bell, CheckCheck, FileCheck2, Loader2, MapPin, PencilLine, ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";

const LeafletMap = dynamicImport(() => import("@/components/rg/leaflet-map"));

export function UserDashboard() {
  const { user, refreshUnread } = useApp();
  const qc = useQueryClient();
  const [detail, setDetail] = useState<HazardDTO | null>(null);
  const [profile, setProfile] = useState<{ name?: string; phone?: string; ward?: string; notifyInApp?: boolean; geoConsent?: boolean }>({});

  const reportsQ = useQuery({
    queryKey: ["my-reports"],
    queryFn: () => api<{ items: HazardDTO[] }>("/api/reports"),
    enabled: Boolean(user),
  });
  const notifQ = useQuery({
    queryKey: ["notifications"],
    queryFn: () => api<{ items: NotificationDTO[]; unread: number }>("/api/users/me/notifications"),
    enabled: Boolean(user),
  });

  if (!user) return null;
  const reports = reportsQ.data?.items ?? [];
  const counts = {
    total: reports.length,
    pending: reports.filter((r) => r.status === "PENDING_REVIEW" || r.status === "REPORTED" || r.status === "AI_VERIFIED").length,
    approved: reports.filter((r) => r.status === "VERIFIED").length,
    resolved: reports.filter((r) => r.workOrderStatus === "VERIFIED" || r.workOrderStatus === "CLOSED").length,
  };

  const saveProfile = async () => {
    try {
      await api("/api/users/me", { method: "PATCH", json: profile });
      await useApp.getState().loadSession();
      toast.success("Profile updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Update failed");
    }
  };

  const markAll = async () => {
    await api("/api/users/me/notifications", { json: { action: "read-all" } });
    void qc.invalidateQueries({ queryKey: ["notifications"] });
    void refreshUnread();
  };

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#6A00F4]">Citizen workspace</p>
          <h1 className="mt-2 font-display text-4xl tracking-tight">My Reports</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">Every report you file is tracked from submission to repair — you'll be notified as the crew moves.</p>
        </div>
        <Button className="bg-[#6A00F4] hover:bg-[#5a00d1]" onClick={() => useApp.getState().setView("report")}>
          <PencilLine className="size-4" aria-hidden /> New report
        </Button>
      </div>

      <div className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { label: "My reports", value: counts.total, icon: ScrollText, color: "#6A00F4" },
          { label: "Pending review", value: counts.pending, icon: Loader2, color: "#D97706" },
          { label: "Verified & public", value: counts.approved, icon: MapPin, color: "#168266" },
          { label: "Problems resolved", value: counts.resolved, icon: FileCheck2, color: "#8B3DFF" },
        ].map((k) => (
          <div key={k.label} className="rounded-2xl border border-border bg-card p-5">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{k.label}</p>
              <k.icon className="size-4" style={{ color: k.color }} aria-hidden />
            </div>
            <p className="mt-2 font-display text-3xl font-semibold tabular-nums">{reportsQ.isLoading ? "—" : k.value}</p>
          </div>
        ))}
      </div>

      <Tabs defaultValue="reports" className="mt-8">
        <TabsList className="h-11">
          <TabsTrigger value="reports">My reports</TabsTrigger>
          <TabsTrigger value="map">My map</TabsTrigger>
          <TabsTrigger value="notifications">
            Notifications
            {(notifQ.data?.unread ?? 0) > 0 && (
              <span className="ml-1.5 rounded-full bg-[#C83E4D] px-1.5 py-0.5 text-[10px] font-bold text-white">{notifQ.data!.unread}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="profile">Profile & privacy</TabsTrigger>
        </TabsList>

        <TabsContent value="reports" className="mt-5">
          {reportsQ.isLoading ? (
            <EmptyState title="Loading your reports…" />
          ) : reports.length === 0 ? (
            <EmptyState
              title="No reports yet"
              hint="Spotted a pothole on your commute? File your first report — it takes under a minute."
              icon={<MapPin className="size-5" aria-hidden />}
            />
          ) : (
            <div className="overflow-hidden rounded-2xl border border-border bg-card">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-3 font-semibold">Reference</th>
                    <th className="px-4 py-3 font-semibold">Hazard</th>
                    <th className="hidden px-4 py-3 font-semibold sm:table-cell">Severity</th>
                    <th className="hidden px-4 py-3 font-semibold md:table-cell">Priority</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="hidden px-4 py-3 font-semibold md:table-cell">Repair</th>
                    <th className="hidden px-4 py-3 font-semibold lg:table-cell">Filed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {reports.map((r) => (
                    <tr key={r.id} className="cursor-pointer transition-colors hover:bg-secondary" onClick={() => setDetail(r)}>
                      <td className="px-4 py-3 font-semibold text-[#6A00F4]">{r.referenceCode}</td>
                      <td className="px-4 py-3"><ClassChip cls={r.hazardClass} /></td>
                      <td className="hidden px-4 py-3 sm:table-cell"><SeverityDots severity={r.severity} /></td>
                      <td className="hidden px-4 py-3 md:table-cell">
                        {r.priority ? (
                          <span className="font-bold tabular-nums" style={{ color: BAND_META[r.priority.band].color }}>
                            {Math.round(r.priority.score)} · {BAND_META[r.priority.band].label}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3"><StatusChip status={r.status} /></td>
                      <td className="hidden px-4 py-3 md:table-cell">
                        {r.workOrderStatus ? (
                          <WoStatusChip status={r.workOrderStatus} />
                        ) : (
                          <span className="text-xs text-muted-foreground">awaiting crew</span>
                        )}
                      </td>
                      <td className="hidden px-4 py-3 text-muted-foreground lg:table-cell">{fmtDate(r.createdAt, true)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="map" className="mt-5">
          <div className="h-[60vh] min-h-[400px] overflow-hidden rounded-2xl border border-border bg-card">
            {reports.length > 0 ? (
              <LeafletMap
                hazards={reports.map((h) => ({ id: h.id, lat: h.lat, lng: h.lng, hazardClass: h.hazardClass, severity: h.severity, band: h.priority?.band ?? null, referenceCode: h.referenceCode }))}
                clusters={[]}
                center={reports.length ? [reports[0].lat, reports[0].lng] : undefined}
                zoom={12}
                onSelect={(id) => {
                  const r = reports.find((x) => x.id === id);
                  if (r) setDetail(r);
                }}
                className="h-full w-full"
              />
            ) : (
              <EmptyState title="Your map is waiting for its first pin" />
            )}
          </div>
        </TabsContent>

        <TabsContent value="notifications" className="mt-5">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">{notifQ.data?.unread ?? 0} unread</p>
            <Button size="sm" variant="outline" className="border-border" onClick={markAll}>
              <CheckCheck className="size-4" aria-hidden /> Mark all read
            </Button>
          </div>
          <div className="mt-4 space-y-3">
            {(notifQ.data?.items ?? []).length === 0 && (
              <EmptyState title="No notifications yet" hint="Review decisions and repair updates will land here." icon={<Bell className="size-5" aria-hidden />} />
            )}
            {(notifQ.data?.items ?? []).map((n) => (
              <button
                key={n.id}
                onClick={async () => {
                  await api("/api/users/me/notifications", { json: { action: "read", id: n.id } });
                  void qc.invalidateQueries({ queryKey: ["notifications"] });
                  void refreshUnread();
                }}
                className={cn(
                  "flex w-full items-start gap-3 rounded-xl border p-4 text-left transition-colors",
                  n.read ? "border-border bg-card" : "border-[#6A00F4]/30 bg-[#6A00F4]/[0.05] hover:bg-[#6A00F4]/[0.09]"
                )}
              >
                <Bell className={cn("mt-0.5 size-4 shrink-0", n.read ? "text-muted-foreground" : "text-[#6A00F4]")} aria-hidden />
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold">{n.title}</span>
                    <span className="text-xs text-muted-foreground">{fmtRelative(n.createdAt)}</span>
                  </span>
                  <span className="mt-1 block text-sm text-muted-foreground">{n.body}</span>
                </span>
              </button>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="profile" className="mt-5 max-w-2xl">
          <div className="space-y-5 rounded-2xl border border-border bg-card p-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="p-name">Full name</Label>
                <Input id="p-name" className="mt-1.5" defaultValue={user.name} onChange={(e) => setProfile((p) => ({ ...p, name: e.target.value }))} />
              </div>
              <div>
                <Label htmlFor="p-phone">Phone (optional)</Label>
                <Input id="p-phone" className="mt-1.5" placeholder="+91…" onChange={(e) => setProfile((p) => ({ ...p, phone: e.target.value }))} />
              </div>
              <div>
                <Label htmlFor="p-ward">Home ward</Label>
                <Input id="p-ward" className="mt-1.5" placeholder="e.g. Indiranagar" onChange={(e) => setProfile((p) => ({ ...p, ward: e.target.value }))} />
              </div>
              <div className="flex items-end text-sm text-muted-foreground">{user.email}</div>
            </div>
            <div className="space-y-4 border-t border-border pt-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">In-app notifications</p>
                  <p className="text-xs text-muted-foreground">Review decisions and repair progress.</p>
                </div>
                <Switch defaultChecked={user.notifyInApp} onCheckedChange={(v) => setProfile((p) => ({ ...p, notifyInApp: v }))} />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Location services consent</p>
                  <p className="text-xs text-muted-foreground">Permits reading device GPS & photo EXIF. Withdraw anytime; metadata is always stripped.</p>
                </div>
                <Switch defaultChecked={user.geoConsent} onCheckedChange={(v) => setProfile((p) => ({ ...p, geoConsent: v }))} />
              </div>
            </div>
            <Button className="bg-[#6A00F4] hover:bg-[#5a00d1]" onClick={saveProfile}>Save changes</Button>
          </div>
        </TabsContent>
      </Tabs>

      {/* report detail dialog */}
      <Dialog open={Boolean(detail)} onOpenChange={(o) => !o && setDetail(null)}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto scrollbar-slim">
          {detail && (
            <>
              <DialogHeader>
                <DialogTitle className="flex flex-wrap items-center gap-2 font-display text-2xl">
                  {detail.referenceCode} <StatusChip status={detail.status} />
                </DialogTitle>
              </DialogHeader>
              <MediaFrame
                mediaId={detail.media.find((m) => m.kind === "ORIGINAL")?.id ?? detail.media[0]?.id}
                alt="Reported hazard media"
                detections={detail.detections}
                className="aspect-[4/3] w-full"
              />
              <div className="flex flex-wrap items-center gap-3">
                <ClassChip cls={detail.hazardClass} size="md" />
                <SeverityDots severity={detail.severity} />
                {detail.priority && <BandBadge band={detail.priority.band} />}
              </div>
              <ol className="space-y-0 rounded-xl border border-border p-4">
                {[
                  { at: detail.createdAt, label: "Submitted", done: true },
                  { at: detail.reviewedAt, label: `Reviewed${detail.reviewNote ? ` — ${detail.reviewNote}` : ""}`, done: Boolean(detail.reviewedAt) },
                  {
                    at: null,
                    label: detail.workOrderStatus
                      ? `Repair: ${WO_STATUS_META[detail.workOrderStatus].label.toLowerCase()}`
                      : "Repair: awaiting assignment",
                    done: ["COMPLETED", "VERIFICATION_PENDING", "VERIFIED", "CLOSED"].includes(detail.workOrderStatus ?? ""),
                  },
                  {
                    at: detail.workOrder?.verifiedAt ?? null,
                    label:
                      detail.workOrderStatus === "VERIFICATION_PENDING"
                        ? "Verification pending — awaiting administrator sign-off"
                        : detail.workOrderStatus === "VERIFIED" || detail.workOrderStatus === "CLOSED"
                          ? `Verified & closed${detail.workOrder?.verifiedBy ? ` by ${detail.workOrder.verifiedBy}` : ""}`
                          : "Verification by administrator",
                    done: detail.workOrderStatus === "VERIFIED" || detail.workOrderStatus === "CLOSED",
                  },
                ].map((s, i) => (
                  <li key={i} className="relative flex gap-3 pb-4 last:pb-0">
                    {i < 3 && <span className="absolute left-[7px] top-5 h-full w-px bg-border" aria-hidden />}
                    <span className={cn("mt-1 size-3.5 shrink-0 rounded-full border-2", s.done ? "border-[#168266] bg-[#168266]" : "border-border bg-card")} aria-hidden />
                    <span>
                      <span className="block text-sm font-medium">{s.label}</span>
                      <span className="block text-xs text-muted-foreground">{s.at ? fmtDate(s.at, true) : "pending"}</span>
                    </span>
                  </li>
                ))}
              </ol>
              {detail.workOrderStatus === "VERIFICATION_PENDING" && user.role === "ADMIN" && (
                <Button
                  className="w-full bg-[#B45309] hover:bg-[#93440a]"
                  onClick={() => {
                    setDetail(null);
                    useApp.getState().setView("verify");
                  }}
                >
                  <FileCheck2 className="size-4" aria-hidden /> Verify this repair — compare before/after evidence
                </Button>
              )}
              {detail.notes && <p className="text-sm text-muted-foreground"><span className="font-semibold text-foreground">Your notes:</span> {detail.notes}</p>}
              {detail.priority && (
                <div className="flex items-center gap-5 rounded-xl border border-border p-4">
                  <PriorityGauge priority={detail.priority} size={84} />
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    Score refreshes as nearby duplicates arrive, the road&apos;s criticality changes, and time passes. The full factor
                    breakdown is attached to every score and available through the explain-priority API.
                  </p>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
