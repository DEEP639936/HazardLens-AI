"use client";
// AdminPanel — the ADMIN-only administration console.
// Tabs: Users (role management) · Risk rules (weights + recommended actions) ·
//       Duplicate rules (radius/window/threshold) · Departments & teams · Audit log.
// Everything here mutates real backend configuration and is audit-logged.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/lib/rg/api";
import { ROLE_META, ROLES, SEVERITY_BANDS } from "@/lib/rg/constants";
import type { Role } from "@/lib/rg/types";
import { EmptyState } from "@/components/rg/primitives";
import { fmtDate } from "@/lib/rg/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, BarChart3, Building2, ClipboardList, GitMerge, Loader2, ScrollText, Users } from "lucide-react";

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  ward?: string | null;
  reportCount: number;
  createdAt: string;
}

interface SettingsPayload {
  settings: {
    weights: { severity: number; density: number; criticality: number; recurrence: number; age: number };
    duplicates: { radiusM: number; windowDays: number; thresholdPct: number };
    actions: Record<string, string>;
    org: { departments: string[]; teams: string[] };
  };
}

interface AuditRow {
  id: string;
  actorEmail?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  createdAt: string;
}

export function AdminPanel() {
  const qc = useQueryClient();

  const usersQ = useQuery({ queryKey: ["admin-users"], queryFn: () => api<{ items: AdminUser[] }>("/api/admin/users"), staleTime: 30_000 });
  const settingsQ = useQuery({ queryKey: ["admin-settings"], queryFn: () => api<SettingsPayload>("/api/admin/settings"), staleTime: 30_000 });
  const auditQ = useQuery({ queryKey: ["admin-audit"], queryFn: () => api<{ items: AuditRow[] }>("/api/admin/audit-logs?limit=200"), staleTime: 15_000 });

  const setRole = useMutation({
    mutationFn: (payload: { userId: string; role: Role }) => api("/api/admin/users", { method: "PATCH", json: payload }),
    onSuccess: () => {
      toast.success("Role updated — the user is notified and signs in fresh");
      void qc.invalidateQueries({ queryKey: ["admin-users"] });
      void qc.invalidateQueries({ queryKey: ["admin-audit"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Role change failed"),
  });

  /* Editable drafts initialize once from the fetched settings (render-phase init —
     later refetches never clobber in-progress edits). */
  const s = settingsQ.data?.settings;
  const [weights, setWeights] = useState<SettingsPayload["settings"]["weights"] | null>(null);
  const [actions, setActions] = useState<Record<string, string> | null>(null);
  const [dup, setDup] = useState<SettingsPayload["settings"]["duplicates"] | null>(null);
  const [departments, setDepartments] = useState<string | null>(null);
  const [teams, setTeams] = useState<string | null>(null);
  if (s && weights === null && actions === null && dup === null) {
    setWeights(s.weights);
    setActions(s.actions);
    setDup(s.duplicates);
    setDepartments(s.org.departments.join("\n"));
    setTeams(s.org.teams.join("\n"));
  }

  const saveSettings = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api("/api/admin/settings", { method: "PUT", json: patch }),
    onSuccess: () => {
      toast.success("Configuration saved — applies to the next risk computation");
      void qc.invalidateQueries({ queryKey: ["admin-settings"] });
      void qc.invalidateQueries({ queryKey: ["admin-audit"] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Save failed"),
  });

  const saveWeights = () => {
    if (!weights) return;
    saveSettings.mutate({ weights });
  };
  const saveActions = () => actions && saveSettings.mutate({ actions });
  const saveDup = () => dup && saveSettings.mutate({ duplicates: dup });
  const saveOrg = () =>
    saveSettings.mutate({
      org: {
        departments: (departments ?? "").split("\n").map((x) => x.trim()).filter(Boolean),
        teams: (teams ?? "").split("\n").map((x) => x.trim()).filter(Boolean),
      },
    });

  const weightTotal = weights ? weights.severity + weights.density + weights.criticality + weights.recurrence + weights.age : 0;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 sm:px-6 lg:py-10">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#6A00F4]">Administration</p>
        <h1 className="mt-2 font-display text-4xl tracking-tight">Administration</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground">
          User roles, risk-engine rules, duplicate detection parameters, departments & teams, and the platform-wide audit log.
        </p>
      </div>

      <Tabs defaultValue="users" className="mt-6">
        <TabsList className="h-11 flex-wrap">
          <TabsTrigger value="users"><Users className="mr-1.5 size-4" aria-hidden />Users</TabsTrigger>
          <TabsTrigger value="risk"><BarChart3 className="mr-1.5 size-4" aria-hidden />Risk rules</TabsTrigger>
          <TabsTrigger value="dup"><GitMerge className="mr-1.5 size-4" aria-hidden />Duplicates</TabsTrigger>
          <TabsTrigger value="org"><Building2 className="mr-1.5 size-4" aria-hidden />Departments</TabsTrigger>
          <TabsTrigger value="audit"><ScrollText className="mr-1.5 size-4" aria-hidden />Audit log</TabsTrigger>
        </TabsList>

        {/* ---------------- users ---------------- */}
        <TabsContent value="users" className="mt-5">
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                  <th className="px-4 py-3 font-semibold">Name</th>
                  <th className="px-4 py-3 font-semibold">Email</th>
                  <th className="px-4 py-3 font-semibold">Reports</th>
                  <th className="hidden px-4 py-3 font-semibold sm:table-cell">Joined</th>
                  <th className="px-4 py-3 font-semibold">Role</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(usersQ.data?.items ?? []).map((u) => (
                  <tr key={u.id}>
                    <td className="px-4 py-3 font-medium">{u.name}</td>
                    <td className="px-4 py-3 text-muted-foreground">{u.email}</td>
                    <td className="px-4 py-3 tabular-nums">{u.reportCount}</td>
                    <td className="hidden px-4 py-3 text-muted-foreground sm:table-cell">{fmtDate(u.createdAt, false)}</td>
                    <td className="px-4 py-3">
                      <Select value={u.role} onValueChange={(v) => setRole.mutate({ userId: u.id, role: v as Role })}>
                        <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {ROLES.map((r) => (
                            <SelectItem key={r} value={r}>{ROLE_META[r].label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                  </tr>
                ))}
                {usersQ.isLoading && <tr><td colSpan={5} className="px-4 py-10 text-center text-muted-foreground">Loading users…</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Role changes revoke the user's refresh tokens and take effect at their next sign-in. Every change is audit-logged.
          </p>
        </TabsContent>

        {/* ---------------- risk rules ---------------- */}
        <TabsContent value="risk" className="mt-5 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-border bg-card p-5">
            <h2 className="font-display text-lg font-semibold">Risk score weights</h2>
            <p className="mt-1 text-xs text-muted-foreground">Weights must sum to 1.0. Applies to every subsequent risk computation.</p>
            {weights && (
              <>
                <div className="mt-4 space-y-4">
                  {(
                    [
                      ["severity", "Detection severity"],
                      ["density", "Cluster density"],
                      ["criticality", "Road criticality"],
                      ["recurrence", "Recurrence"],
                      ["age", "Unresolved age"],
                    ] as const
                  ).map(([key, label]) => (
                    <div key={key}>
                      <div className="flex items-center justify-between text-sm">
                        <Label>{label}</Label>
                        <span className="font-bold tabular-nums text-[#6A00F4]">{Math.round(weights[key] * 100)}%</span>
                      </div>
                      <Slider className="mt-2" min={0} max={0.6} step={0.01} value={[weights[key]]} onValueChange={([v]) => setWeights({ ...weights, [key]: v })} />
                    </div>
                  ))}
                </div>
                <div className={`mt-4 flex items-center justify-between rounded-xl px-4 py-2.5 text-sm ${Math.abs(weightTotal - 1) < 0.001 ? "bg-[#168266]/10 text-[#0f5c49]" : "bg-[#C83E4D]/10 text-[#C83E4D]"}`}>
                  <span>Σ weights = {weightTotal.toFixed(2)}</span>
                  <Button size="sm" className="bg-[#6A00F4] hover:bg-[#5a00d1]" disabled={Math.abs(weightTotal - 1) >= 0.001 || saveSettings.isPending} onClick={saveWeights}>
                    {saveSettings.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null} Save weights
                  </Button>
                </div>
              </>
            )}
          </div>

          <div className="rounded-2xl border border-border bg-card p-5">
            <h2 className="font-display text-lg font-semibold">Recommended actions per severity</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Served by the backend on every hazard — the UI never hardcodes these. They appear in detail panels and work orders.
            </p>
            {actions && (
              <div className="mt-4 space-y-3">
                {SEVERITY_BANDS.map((band) => (
                  <div key={band}>
                    <Label className="flex items-center gap-2">
                      <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-bold ${band === "CRITICAL" ? "bg-[#C83E4D] text-white border-[#C83E4D]" : band === "HIGH" ? "bg-[#D97706] text-white border-[#D97706]" : band === "MODERATE" ? "bg-[#8B3DFF]/15 text-[#4d00b3] border-[#8B3DFF]/30" : "bg-[#168266]/15 text-[#0f5c49] border-[#168266]/30"}`}>
                        {band}
                      </span>
                    </Label>
                    <Input className="mt-1.5" value={actions[band] ?? ""} onChange={(e) => setActions({ ...actions, [band]: e.target.value })} />
                  </div>
                ))}
                <Button className="bg-[#6A00F4] hover:bg-[#5a00d1]" disabled={saveSettings.isPending} onClick={saveActions}>
                  {saveSettings.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null} Save actions
                </Button>
              </div>
            )}
          </div>
        </TabsContent>

        {/* ---------------- duplicates ---------------- */}
        <TabsContent value="dup" className="mt-5 max-w-xl">
          <div className="rounded-2xl border border-border bg-card p-5">
            <h2 className="font-display text-lg font-semibold">Duplicate detection parameters</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Candidates are compared on location (45%), hazard type (25%), evidence image perceptual hash (20%) and temporal proximity (10%).
              Reports at or above the threshold trigger the "Possible existing hazard" flow before anything is created.
            </p>
            {dup && (
              <>
                <div className="mt-4 space-y-4">
                  <div>
                    <Label htmlFor="d-radius">Candidate radius (m)</Label>
                    <Input id="d-radius" type="number" min={10} max={500} className="mt-1.5" value={dup.radiusM} onChange={(e) => setDup({ ...dup, radiusM: Number(e.target.value) })} />
                  </div>
                  <div>
                    <Label htmlFor="d-window">Report window (days)</Label>
                    <Input id="d-window" type="number" min={1} max={365} className="mt-1.5" value={dup.windowDays} onChange={(e) => setDup({ ...dup, windowDays: Number(e.target.value) })} />
                  </div>
                  <div>
                    <div className="flex items-center justify-between text-sm">
                      <Label>Similarity threshold (%)</Label>
                      <span className="font-bold tabular-nums text-[#6A00F4]">{dup.thresholdPct}%</span>
                    </div>
                    <Slider className="mt-2" min={50} max={99} step={1} value={[dup.thresholdPct]} onValueChange={([v]) => setDup({ ...dup, thresholdPct: v })} />
                  </div>
                </div>
                <Button className="mt-4 bg-[#6A00F4] hover:bg-[#5a00d1]" disabled={saveSettings.isPending} onClick={saveDup}>
                  {saveSettings.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null} Save duplicate rules
                </Button>
              </>
            )}
          </div>
        </TabsContent>

        {/* ---------------- org ---------------- */}
        <TabsContent value="org" className="mt-5 grid gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-border bg-card p-5">
            <h2 className="font-display text-lg font-semibold">Departments</h2>
            <p className="mt-1 text-xs text-muted-foreground">One per line — offered in work-order assignment.</p>
            <Textarea className="mt-3 min-h-32 font-mono text-sm" value={departments ?? ""} onChange={(e) => setDepartments(e.target.value)} />
            <Button className="mt-3 bg-[#6A00F4] hover:bg-[#5a00d1]" disabled={saveSettings.isPending} onClick={saveOrg}>
              {saveSettings.isPending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null} Save departments & teams
            </Button>
          </div>
          <div className="rounded-2xl border border-border bg-card p-5">
            <h2 className="font-display text-lg font-semibold">Field teams</h2>
            <p className="mt-1 text-xs text-muted-foreground">One per line — e.g. ward crews, rapid response units.</p>
            <Textarea className="mt-3 min-h-32 font-mono text-sm" value={teams ?? ""} onChange={(e) => setTeams(e.target.value)} />
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <ClipboardList className="size-3.5" aria-hidden /> Field workers are managed on the Users tab (role: Field worker).
            </p>
          </div>
        </TabsContent>

        {/* ---------------- audit ---------------- */}
        <TabsContent value="audit" className="mt-5">
          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <div className="max-h-[70vh] overflow-auto scrollbar-slim">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="sticky top-0 bg-card">
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-4 py-3 font-semibold">When</th>
                    <th className="px-4 py-3 font-semibold">Actor</th>
                    <th className="px-4 py-3 font-semibold">Action</th>
                    <th className="px-4 py-3 font-semibold">Entity</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {(auditQ.data?.items ?? []).map((l) => (
                    <tr key={l.id}>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-muted-foreground">{fmtDate(l.createdAt, true)}</td>
                      <td className="px-4 py-2.5">
                        <span className="block text-xs font-medium">{l.actorEmail ?? "system"}</span>
                        <span className="text-[10px] text-muted-foreground">{l.actorRole ?? "—"}</span>
                      </td>
                      <td className="px-4 py-2.5"><span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px]">{l.action}</span></td>
                      <td className="px-4 py-2.5 text-xs text-muted-foreground">{l.entityType}{l.entityId ? ` · ${l.entityId.slice(-6)}` : ""}</td>
                    </tr>
                  ))}
                  {auditQ.isLoading && <tr><td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">Loading audit trail…</td></tr>}
                  {!auditQ.isLoading && (auditQ.data?.items ?? []).length === 0 && (
                    <tr><td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">No audit entries yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <AlertTriangle className="size-3.5" aria-hidden /> Every verification, merge, work-order transition, evidence upload and settings change is recorded here server-side.
          </p>
        </TabsContent>
      </Tabs>

      {usersQ.isError && (
        <div className="mt-4">
          <EmptyState title="Could not load administration data" hint="Check your connection and retry." />
        </div>
      )}
    </div>
  );
}
