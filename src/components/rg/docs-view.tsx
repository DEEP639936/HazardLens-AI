"use client";
// Documentation hub — repo documents, live OpenAPI (Swagger UI), quick reference + demo credentials.
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DEMO_ACCOUNTS } from "@/lib/rg/constants";
import { useApp } from "@/lib/rg/store";
import { BookOpen, Boxes, ClipboardCopy, FileCode2, FileDown, FlaskConical, FolderDown, GraduationCap, Presentation, ShieldCheck, UserRound, Video } from "lucide-react";
import { toast } from "sonner";

const DOCS = [
  { icon: BookOpen, file: "README.md", title: "README", desc: "Architecture diagram, setup, Docker, demo flow, API reference index.", audience: "Everyone" },
  { icon: ShieldCheck, file: "docs/SYSTEM_CARD.md", title: "System card", desc: "Scope, data flow, operational assumptions, security, monitoring & rollback.", audience: "Engineers" },
  { icon: Boxes, file: "docs/MODEL_CARD.md", title: "Model card", desc: "Training data & licenses, metrics, intended use, bias and failure cases.", audience: "ML / auditors" },
  { icon: ClipboardCopy, file: "docs/ADMIN_GUIDE.md", title: "Admin guide", desc: "Review queue, cluster management, priority overrides, work orders, troubleshooting.", audience: "Moderators" },
  { icon: UserRound, file: "docs/USER_GUIDE.md", title: "User guide", desc: "Sign-up, reporting, location permission, tracking, privacy information.", audience: "Citizens" },
  { icon: GraduationCap, file: "docs/FINAL_REPORT.md", title: "Final report", desc: "Abstract → conclusion: methodology, evaluation, results, references.", audience: "Reviewers" },
  { icon: Presentation, file: "docs/PRESENTATION_OUTLINE.md", title: "Presentation outline", desc: "12–15 slides with speaker notes and recommended visuals.", audience: "Presenters" },
  { icon: Video, file: "docs/DEMO_VIDEO_SCRIPT.md", title: "Demo video script", desc: "5–8 minute narration with precise screen flow and timings.", audience: "Demo day" },
  { icon: FileDown, file: "docs/CONTRIBUTION_EVIDENCE_TEMPLATE.md", title: "Contribution evidence", desc: "Per-contributor features, commits, PRs, tests and percentage split.", audience: "Teams" },
  { icon: FlaskConical, file: "ml/README.md", title: "ML pipeline", desc: "Dataset schema, training, MLflow tracking, evaluation, ONNX export.", audience: "ML engineers" },
];

const SWAGGER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"/>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui.css"/>
<style>body{margin:0;background:#fff}</style></head>
<body><div id="swagger"></div>
<script src="https://unpkg.com/swagger-ui-dist@5.17.14/swagger-ui-bundle.js" crossorigin></script>
<script>
  window.onload = function(){
    try { window.SwaggerUIBundle({ url: '/api/openapi.json', dom_id: '#swagger', docExpansion: 'list', defaultModelsExpandDepth: 0 });
    } catch(e) { document.body.innerHTML = '<p style="font:14px sans-serif;padding:24px">Swagger assets could not be fetched offline. The raw spec is available at <a href="/api/openapi.json">/api/openapi.json</a>.</p>'; }
  };
</script></body></html>`;

export function DocsView() {
  const { user, setView } = useApp();
  const [tab, setTab] = useState("guides");
  const specUrl = useMemo(() => "/api/openapi.json", []);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-12 sm:px-6">
      <div className="max-w-3xl">
        <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#6A00F4]">Documentation</p>
        <h1 className="mt-3 font-display text-4xl tracking-tight sm:text-5xl">Everything is documented — on purpose.</h1>
        <p className="mt-4 text-base leading-relaxed text-muted-foreground">
          Ship-ready docs live in the repository under <code className="rounded bg-muted px-1.5 py-0.5 text-[13px]">docs/</code>, alongside a
          live OpenAPI 3.1 specification served by this deployment. Start here, then go deep.
        </p>
      </div>

      <div className="mt-8 flex flex-col gap-5 rounded-2xl border border-[#6A00F4]/20 bg-[#6A00F4]/[0.04] p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-[#6A00F4]/10 text-[#6A00F4]">
            <FolderDown className="size-5" aria-hidden />
          </div>
          <div>
            <h2 className="font-display text-lg font-semibold">One-click download — the whole project</h2>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
              The complete repository as a single ZIP: Next.js frontend + API, FastAPI backend, YOLO ML pipeline,
              infrastructure &amp; CI workflows, and every document on this page. Unzip → <code className="rounded bg-muted px-1 py-0.5 text-[12px]">git init</code> → push.
            </p>
          </div>
        </div>
        <Button asChild className="shrink-0 bg-[#6A00F4] hover:bg-[#5a00d1]">
          <a href="/api/project/download" download>
            <FolderDown className="size-4" aria-hidden /> Download .zip
          </a>
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab} className="mt-10">
        <TabsList className="h-11">
          <TabsTrigger value="guides">Guides & deliverables</TabsTrigger>
          <TabsTrigger value="api">API reference</TabsTrigger>
          <TabsTrigger value="ops">Operate & demo</TabsTrigger>
        </TabsList>

        <TabsContent value="guides" className="mt-6">
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {DOCS.map((d) => (
              <Card key={d.file} className="group border-border bg-card transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_18px_40px_-18px_rgba(106,0,244,0.25)]">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between">
                    <d.icon className="size-5 text-[#6A00F4]" aria-hidden />
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{d.audience}</span>
                  </div>
                  <h3 className="mt-4 font-display text-xl font-semibold">{d.title}</h3>
                  <p className="mt-2 min-h-10 text-sm leading-relaxed text-muted-foreground">{d.desc}</p>
                  <code className="mt-3 block truncate rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">{d.file}</code>
                </CardContent>
              </Card>
            ))}
          </div>
        </TabsContent>

        <TabsContent value="api" className="mt-6 space-y-5">
          <div className="flex flex-wrap items-center gap-3">
            <Button variant="outline" className="border-border" onClick={() => window.open(specUrl, "_blank")}>
              <FileCode2 className="size-4" aria-hidden /> Raw OpenAPI 3.1 JSON
            </Button>
            <Button variant="outline" className="border-border" onClick={() => window.open("/api/health", "_blank")}>
              Service health
            </Button>
            <Button variant="outline" className="border-border" onClick={() => window.open("/api/metrics", "_blank")}>
              Prometheus metrics
            </Button>
          </div>
          <div className="overflow-hidden rounded-2xl border border-border bg-white">
            <iframe
              title="HazardLensAI API — Swagger UI"
              srcDoc={SWAGGER_HTML}
              className="h-[760px] w-full"
              sandbox="allow-scripts allow-same-origin allow-popups"
            />
          </div>
          <div className="rounded-xl border border-border bg-card p-5 text-sm">
            <p className="font-semibold">Authentication</p>
            <p className="mt-1.5 leading-relaxed text-muted-foreground">
              Sign in issues a 15-minute JWT access token (httpOnly cookie <code className="rounded bg-muted px-1 text-xs">rg_access</code>) plus a
              30-day rotating refresh token. Swagger &quot;Authorize&quot; accepts the bearer token returned in the login response body.
            </p>
          </div>
        </TabsContent>

        <TabsContent value="ops" className="mt-6 grid gap-5 lg:grid-cols-2">
          <Card className="border-border">
            <CardContent className="p-6">
              <h3 className="font-display text-xl font-semibold">Try the full workflow</h3>
              <ol className="mt-4 list-decimal space-y-2.5 pl-5 text-sm leading-relaxed text-muted-foreground">
                <li>Sign in as a citizen and submit a hazard from the <button className="font-medium text-[#6A00F4] hover:underline" onClick={() => setView("report")}>report page</button> — watch the AI preview.</li>
                <li>Report the same spot again: the duplicate engine suggests <em>&ldquo;Possible existing hazard&rdquo;</em> — merge, view or create new. 12 reports ≠ 12 potholes.</li>
                <li>As an authority, open the <button className="font-medium text-[#6A00F4] hover:underline" onClick={() => setView("queue")}>hazard queue</button> — verify, reject, merge or escalate. Every action is audit-logged.</li>
                <li>Create a work order (department, team, field worker, due date) from the <button className="font-medium text-[#6A00F4] hover:underline" onClick={() => setView("work")}>work orders</button> board.</li>
                <li>As the assigned field worker: start work, upload before/after evidence — the order auto-advances to verification.</li>
                <li>Approve (or reject with a reason) the resolution; the reporter is notified at every step and the hazard lifecycle closes out.</li>
                <li>Explore <code className="rounded bg-muted px-1 text-xs">/api/hazards</code>, CSV/GeoJSON export, or the full lifecycle via <code className="rounded bg-muted px-1 text-xs">/api/hazards/&#123;id&#125;/timeline</code>.</li>
              </ol>
              <div className="mt-5 space-y-2.5 rounded-xl bg-muted/70 p-4 text-sm">
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Demo credentials</p>
                {[
                  { role: "Administrator", ...DEMO_ACCOUNTS.admin },
                  { role: "Citizen", ...DEMO_ACCOUNTS.user },
                  { role: "Field worker", email: "field@roadguardatlas.dev", password: "Atlas@User2024" },
                ].map((acc) => (
                  <div key={acc.email} className="flex items-center justify-between gap-2">
                    <div>
                      <span className="font-semibold">{acc.role}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{acc.email} · {acc.password}</span>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 border-border px-2 text-xs"
                      onClick={() => {
                        void navigator.clipboard?.writeText(`${acc.email} / ${acc.password}`);
                        toast.success("Credentials copied");
                      }}
                    >
                      <ClipboardCopy className="size-3" aria-hidden /> Copy
                    </Button>
                  </div>
                ))}
              </div>
              {!user && (
                <Button className="mt-5 bg-[#6A00F4] hover:bg-[#5a00d1]" onClick={() => setView("signin")}>
                  Sign in to start
                </Button>
              )}
            </CardContent>
          </Card>
          <Card className="border-border">
            <CardContent className="p-6">
              <h3 className="font-display text-xl font-semibold">Run it yourself</h3>
              <pre className="mt-4 overflow-x-auto rounded-xl bg-[#1C1530] p-4 text-[12.5px] leading-relaxed text-[#E8E2EF] scrollbar-slim">
<code>{`# full production stack (FastAPI + PostGIS + worker + MLflow)
cp .env.example .env
docker compose up --build

# live web demo (this deployment)
bun install
bun run db:push
bun run scripts/seed.ts     # Bengaluru demo scenario
bun run dev

# ML pipeline
cd ml && pip install -r requirements.txt
python train.py --data datasets/roadhazards.yaml --track   # MLflow
python export_onnx.py --weights runs/detect/train/weights/best.pt`}</code></pre>
              <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
                Commands, migration steps, deployment targets (Vercel/Railway/Fly.io + managed PostGIS) and rollback strategy are
                detailed in README.md and docs/SYSTEM_CARD.md.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
