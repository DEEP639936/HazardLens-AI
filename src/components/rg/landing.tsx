"use client";
// Landing — editorial, asymmetric, restrained motion. Strict light theme.
import { motion } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { SectionHeading, CountUp, usePrefersReducedMotion } from "@/components/rg/primitives";
import { ScanPreview } from "@/components/rg/media";
import { useApp } from "@/lib/rg/store";
import { api } from "@/lib/rg/api";
import { CLASS_META, DEFAULT_WEIGHTS } from "@/lib/rg/constants";
import { dynamicImport } from "@/lib/rg/lazy";
import type { BboxDTO, MapResponse } from "@/lib/rg/types";
import { useEffect, useState } from "react";
import {
  ArrowRight,
  Camera,
  Cpu,
  FolderDown,
  Layers,
  LockKeyhole,
  LogIn,
  Radar,
  ScanSearch,
  Signal,
  Route,
  TriangleAlert,
} from "lucide-react";

const LeafletMap = dynamicImport(() => import("@/components/rg/leaflet-map"));

const DETECTION_SETS: BboxDTO[][] = [
  [
    { hazardClass: "pothole", confidence: 0.97, bbox: [0.04, 0.32, 0.8, 0.64], severity: 5, areaRatio: 0.28 },
    { hazardClass: "erosion", confidence: 0.81, bbox: [0.4, 0.03, 0.35, 0.1], severity: 3, areaRatio: 0.017 },
  ],
  [
    { hazardClass: "pothole", confidence: 0.94, bbox: [0.3, 0.55, 0.42, 0.42], severity: 5, areaRatio: 0.13 },
    { hazardClass: "crack", confidence: 0.78, bbox: [0.02, 0.05, 0.32, 0.2], severity: 2, areaRatio: 0.03 },
  ],
  [
    { hazardClass: "erosion", confidence: 0.85, bbox: [0.12, 0.62, 0.6, 0.36], severity: 3, areaRatio: 0.11 },
    { hazardClass: "pothole", confidence: 0.89, bbox: [0.55, 0.1, 0.3, 0.24], severity: 4, areaRatio: 0.04 },
  ],
];

const WILD_GALLERY = [
  {
    img: "/demo/pothole-2.jpg",
    alt: "Pothole filled with water beside a yellow lane marking",
    cls: "pothole" as const,
    conf: "94%",
    caption: "Water-filled pothole at a lane edge — severe 4/5",
  },
  {
    img: "/demo/pothole-4.jpg",
    alt: "Deep potholes directly in the wheel path of a moving car",
    cls: "pothole" as const,
    conf: "96%",
    caption: "Wheel-path cluster — the exact pattern clustering catches",
  },
  {
    img: "/demo/crack-1.jpg",
    alt: "Alligator cracking spreading across asphalt with faded marking",
    cls: "crack" as const,
    conf: "91%",
    caption: "Alligator cracking + failing marking — resurface queue",
  },
  {
    img: "/demo/pothole-3.jpg",
    alt: "Large pothole with exposed aggregate on asphalt",
    cls: "pothole" as const,
    conf: "97%",
    caption: "Exposed aggregate — full-depth failure, critical band",
  },
];

const STEPS = [
  {
    icon: Camera,
    title: "Capture",
    body: "Citizens and field crews upload photos or short videos. EXIF GPS is read only with explicit consent — and always stripped from stored copies.",
  },
  {
    icon: ScanSearch,
    title: "Detect",
    body: "A YOLO-class vision model localizes potholes, cracks, erosion, waterlogging, broken markings, debris and edge damage with calibrated confidence.",
  },
  {
    icon: Layers,
    title: "Cluster & score",
    body: "DBSCAN groups nearby reports over PostGIS geometry; an explainable 0–100 priority blends severity, density, road class, recurrence and age.",
  },
  {
    icon: Route,
    title: "Repair",
    body: "Moderators validate, merge duplicates and push hazards onto a work-order board — from Reported through Resolved, fully audited.",
  },
];

const CASES = [
  {
    img: "/demo/pothole-4.jpg",
    tag: "Ward pilot · Bengaluru",
    title: "Silk Board corridor pothole sweep",
    metric: "23 hazards → 4 clusters",
    body: "Duplicate citizen reports of the same pothole collapsed into single clusters, cutting inspection dispatches by an estimated 62% in the pilot ward.",
    attribution: "Photo: freely licensed road-survey imagery",
  },
  {
    img: "/demo/case-2.jpg",
    tag: "Monsoon response",
    title: "Waterlogging early-warning for ORR",
    metric: "60 m clustering radius",
    body: "Recurring waterlogging along the Outer Ring Road surfaced automatically as report density climbed — three high-priority clusters in one week.",
    attribution: "Photo: Wikimedia Commons (CC)",
  },
  {
    img: "/demo/crack-1.jpg",
    tag: "School-zone safety",
    title: "Cracked-marking restoration queue",
    metric: "Priority 81 · Critical band",
    body: "Faded, fractured markings outside two schools scored into the critical band and were scheduled ahead of cosmetic resurfacing work.",
    attribution: "Photo: freely licensed pavement survey",
  },
];

const TECH = [
  "PyTorch", "Ultralytics YOLOv8", "OpenCV", "Hugging Face", "FastAPI", "PostgreSQL + PostGIS",
  "SQLAlchemy · Alembic", "MLflow", "Redis · Celery", "Docker", "React + TypeScript", "Tailwind CSS",
];

function HeroBboxDemo() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 24, rotate: 1.5 }}
      animate={{ opacity: 1, y: 0, rotate: 0 }}
      transition={{ duration: 0.8, ease: [0.2, 0.8, 0.2, 1], delay: 0.15 }}
      className="relative"
    >
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_32px_80px_-24px_rgba(28,21,48,0.35)]">
        <div className="flex items-center justify-between border-b border-border bg-card px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#6A00F4] opacity-60" />
              <span className="relative inline-flex size-2.5 rounded-full bg-[#6A00F4]" />
            </span>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Live detection preview</p>
          </div>
          <p className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
            <Cpu className="size-3.5" aria-hidden /> engine: auto · glm-vision → yolo
          </p>
        </div>
        <ScanPreview imageSrc="/demo/pothole-3.jpg" detectionSets={DETECTION_SETS} className="aspect-[4/3] w-full" />
      </div>
      <motion.div
        aria-hidden
        initial={{ opacity: 0, x: 16 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: 0.7, duration: 0.6 }}
        className="absolute -bottom-5 -left-4 hidden rounded-xl border border-border bg-card px-4 py-3 shadow-lg sm:block"
      >
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Priority · cluster C-4</p>
        <p className="font-display text-2xl font-semibold text-[#6A00F4]">
          87<span className="text-sm text-muted-foreground">/100</span>
        </p>
        <p className="text-[11px] text-[#C83E4D]">Critical — immediate action</p>
      </motion.div>
    </motion.div>
  );
}

function MapPreview() {
  const [data, setData] = useState<MapResponse | null>(null);
  useEffect(() => {
    api<MapResponse>("/api/map?limit=120")
      .then(setData)
      .catch(() => setData(null));
  }, []);
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-[0_24px_64px_-28px_rgba(28,21,48,0.4)] transition-transform duration-300 hover:-translate-y-1">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-semibold">Bengaluru pilot — live hazard clusters</p>
        <span className="text-xs text-muted-foreground">
          {data ? `${data.hazards.length} hazards · ${data.clusters.length} clusters` : "loading…"}
        </span>
      </div>
      <div className="relative h-[380px] w-full sm:h-[440px]">
        {data ? (
          <>
            <LeafletMap
              hazards={data.hazards.map((h) => ({ id: h.id, lat: h.lat, lng: h.lng, hazardClass: h.hazardClass, severity: h.severity, band: h.priority?.band ?? null, referenceCode: h.referenceCode }))}
              clusters={data.clusters}
              className="h-full w-full"
            />
            {data.hazards.length === 0 && (
              <div className="pointer-events-none absolute inset-x-0 top-4 mx-auto w-fit rounded-full border border-border bg-background/90 px-4 py-1.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur">
                No hazards reported yet — members pin the first one from Report Hazard.
              </div>
            )}
          </>
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Preparing map…</div>
        )}
      </div>
    </div>
  );
}

const WEIGHT_BAR_COLOR = "#6A00F4";

export function Landing() {
  const { setView } = useApp();
  const motionOk = !usePrefersReducedMotion();

  return (
    <div>
      {/* ---------------- HERO ---------------- */}
      <section className="paper-texture relative overflow-hidden">
        <svg aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-40 w-full opacity-[0.12]" viewBox="0 0 1200 120" preserveAspectRatio="none">
          <path d="M0 90 C 300 30, 500 110, 800 60 S 1100 20, 1200 70" fill="none" stroke="#6A00F4" strokeWidth="2" strokeDasharray="10 14" className={motionOk ? "[animation:rg-dash_9s_linear_infinite]" : undefined} />
        </svg>
        <div className="mx-auto grid w-full max-w-7xl gap-12 px-4 pb-20 pt-14 sm:px-6 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:gap-10 lg:pb-28 lg:pt-20">
          <div>
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55 }}
              className="inline-flex items-center gap-2 rounded-full border border-[#6A00F4]/25 bg-[#6A00F4]/[0.06] px-3.5 py-1.5 text-xs font-semibold text-[#4d00b3]"
            >
              <Radar className="size-3.5" aria-hidden /> Vision · Geospatial clustering · Explainable priority
            </motion.div>
            <motion.h1
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.08 }}
              className="text-balance mt-6 font-display text-5xl leading-[1.04] tracking-tight text-foreground sm:text-6xl lg:text-[4.4rem]"
            >
              See the road.
              <br />
              <span className="italic text-[#6A00F4]">Prioritize</span> the repair.
            </motion.h1>
            <motion.p
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.16 }}
              className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground"
            >
              HazardLensAI turns everyday photos and dashcam clips into an actionable maintenance map — detecting seven classes of road damage, clustering nearby reports, and scoring each hazard from 0–100 so crews fix what matters first.
            </motion.p>
            <motion.div
              initial={{ opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, delay: 0.24 }}
              className="mt-8 flex flex-wrap items-center gap-3"
            >
              <Button size="lg" onClick={() => setView("signup")} className="bg-[#6A00F4] px-6 hover:bg-[#5a00d1]">
                Get started — it's free <ArrowRight className="size-4" aria-hidden />
              </Button>
              <Button size="lg" onClick={() => setView("signin")} className="bg-[#1C1530] px-6 text-white hover:bg-[#2a2145]">
                <LogIn className="size-4" aria-hidden /> Sign in
              </Button>
              <Button
                size="lg"
                variant="outline"
                onClick={() => document.getElementById("how")?.scrollIntoView({ behavior: motionOk ? "smooth" : "auto", block: "start" })}
                className="border-border bg-card/70 px-6 hover:bg-secondary"
              >
                See how it works
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="border-[#6A00F4]/30 bg-[#6A00F4]/[0.06] px-6 text-[#6A00F4] hover:bg-[#6A00F4]/[0.12]"
              >
                <a
                  href="/api/project/download"
                  download
                  title="Download the complete project — frontend, API, backend, ML pipeline, infrastructure and docs (ZIP)"
                >
                  <FolderDown className="size-4" aria-hidden /> Download project (.zip)
                </a>
              </Button>
            </motion.div>
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.7, delay: 0.34 }}
              className="mt-4 inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground"
            >
              <LockKeyhole className="size-3.5 text-[#6A00F4]" aria-hidden />
              The live map, pothole scanner, hazard reporting and dashboards unlock after sign-in.
            </motion.p>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.4 }}
              className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground"
            >
              <span className="inline-flex items-center gap-1.5"><Signal className="size-3.5 text-[#168266]" aria-hidden /> mAP@50-tracked models</span>
              <span className="inline-flex items-center gap-1.5"><Signal className="size-3.5 text-[#168266]" aria-hidden /> PostGIS spatial queries</span>
              <span className="inline-flex items-center gap-1.5"><Signal className="size-3.5 text-[#168266]" aria-hidden /> MLflow experiment registry</span>
              <span className="inline-flex items-center gap-1.5"><Signal className="size-3.5 text-[#168266]" aria-hidden /> Human-in-the-loop review</span>
            </motion.div>
          </div>
          <HeroBboxDemo />
        </div>
      </section>

      {/* ---------------- WILD GALLERY ---------------- */}
      <section id="detections" aria-label="Detected in the wild" className="mx-auto w-full max-w-7xl scroll-mt-20 px-4 pt-14 sm:px-6">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-[#6A00F4]">Straight from the corpus</p>
            <h2 className="mt-1.5 font-display text-2xl font-semibold tracking-tight sm:text-3xl">Potholes the engine actually detects</h2>
          </div>
          <Button variant="outline" onClick={() => setView("signin")} className="border-border bg-card hover:bg-secondary">
            <LockKeyhole className="size-4" aria-hidden /> Sign in to run your own image
          </Button>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {WILD_GALLERY.map((g, i) => (
            <motion.figure
              key={g.img}
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.07 }}
              className="group relative overflow-hidden rounded-xl border border-border bg-card shadow-sm transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_20px_44px_-20px_rgba(28,21,48,0.4)]"
            >
              <div className="relative aspect-[4/3] overflow-hidden">
                <img src={g.img} alt={g.alt} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.05]" loading="lazy" />
                <span
                  className="absolute left-2.5 top-2.5 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold text-white shadow"
                  style={{ background: CLASS_META[g.cls].color }}
                >
                  <ScanSearch className="size-2.5" aria-hidden /> {CLASS_META[g.cls].short} · {g.conf}
                </span>
              </div>
              <figcaption className="px-3 py-2.5 text-[11px] leading-snug text-muted-foreground">{g.caption}</figcaption>
            </motion.figure>
          ))}
        </div>
      </section>

      {/* ---------------- STATS ---------------- */}
      <section className="border-y border-border bg-card/60">
        <div className="mx-auto grid w-full max-w-7xl grid-cols-2 gap-8 px-4 py-12 sm:px-6 lg:grid-cols-4">
          {[
            { value: 1856, suffix: "", label: "road-crash deaths linked to potholes in India (2022)", source: "MoRTH" },
            { value: 7, suffix: "", label: "hazard classes detected end-to-end", source: "YOLO + review" },
            { value: 100, suffix: "-pt", label: "explainable maintenance-priority scale", source: "5-factor model" },
            { value: 60, suffix: " m", label: "DBSCAN clustering radius, configurable per city", source: "PostGIS-backed" },
          ].map((s, i) => (
            <motion.div
              key={s.label}
              initial={{ opacity: 0, y: 14 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.07 }}
              className="border-l-2 border-[#6A00F4]/25 pl-4"
            >
              <p className="font-display text-4xl font-semibold text-foreground">
                <CountUp to={s.value} suffix={s.suffix} />
              </p>
              <p className="mt-1.5 text-sm leading-snug text-muted-foreground">{s.label}</p>
              <p className="mt-1 text-[11px] font-medium uppercase tracking-wider text-[#6A00F4]">{s.source}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ---------------- HOW IT WORKS ---------------- */}
      <section id="how" className="mx-auto w-full max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6 lg:py-28">
        <SectionHeading
          eyebrow="How it works"
          title="From a phone photo to a scheduled repair"
          lead="Four stages, one auditable pipeline. Every number a planner sees can be traced back to a detection, a cluster or a policy weight."
        />
        <div className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <motion.div
              key={step.title}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.09 }}
            >
              <Card className="group h-full border-border bg-card transition-all duration-300 hover:-translate-y-1.5 hover:shadow-[0_20px_48px_-18px_rgba(106,0,244,0.28)]">
                <CardContent className="p-6">
                  <div className="flex items-center justify-between">
                    <span className="flex size-11 items-center justify-center rounded-xl bg-[#6A00F4]/10 text-[#6A00F4] transition-colors group-hover:bg-[#6A00F4] group-hover:text-white">
                      <step.icon className="size-5" aria-hidden />
                    </span>
                    <span className="font-display text-3xl font-semibold text-border transition-colors group-hover:text-[#FFD6A5]">0{i + 1}</span>
                  </div>
                  <h3 className="mt-5 font-display text-xl font-semibold">{step.title}</h3>
                  <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ---------------- MAP PREVIEW ---------------- */}
      <section className="border-y border-border bg-secondary/40">
        <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 lg:py-24">
          <div className="flex flex-wrap items-end justify-between gap-6">
            <SectionHeading
              eyebrow="Interactive map"
              title="Every hazard, every cluster, one canvas"
              lead="Filter by class, severity, review status and priority band. Cluster bubbles pulse where reports concentrate; heat view exposes corridors at a glance."
            />
            <Button variant="outline" onClick={() => setView("signin")} className="border-border bg-card hover:bg-secondary">
              <LockKeyhole className="size-4" aria-hidden /> Sign in to open the full map
            </Button>
          </div>
          <motion.div
            initial={{ opacity: 0, y: 24 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: "-60px" }}
            transition={{ duration: 0.7 }}
            className="mt-10"
          >
            <MapPreview />
          </motion.div>
        </div>
      </section>

      {/* ---------------- PRIORITY ENGINE ---------------- */}
      <section id="priorities" className="mx-auto w-full max-w-7xl scroll-mt-20 px-4 py-20 sm:px-6 lg:py-28">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <SectionHeading
              eyebrow="Maintenance prioritization"
              title="A 0–100 score planners can interrogate"
              lead="No black boxes. Five weighted factors — each normalized, each visible, each overridable by a human reviewer who signs the decision."
            />
            <div className="mt-8 space-y-4">
              {[
                { key: "severity", label: "Detection severity", w: DEFAULT_WEIGHTS.severity, note: "confidence + bbox extent + class" },
                { key: "density", label: "Cluster density", w: DEFAULT_WEIGHTS.density, note: "same-class reports within 120 m" },
                { key: "criticality", label: "Road criticality", w: DEFAULT_WEIGHTS.criticality, note: "highway → residential gradient" },
                { key: "recurrence", label: "Recurrence", w: DEFAULT_WEIGHTS.recurrence, note: "repeat reports over 30 days" },
                { key: "age", label: "Unresolved age", w: DEFAULT_WEIGHTS.age, note: "saturating at 90 days" },
              ].map((f, i) => (
                <motion.div
                  key={f.key}
                  initial={{ opacity: 0, x: -16 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: i * 0.07 }}
                  className="flex items-center gap-4"
                >
                  <div className="w-40 shrink-0 text-sm font-medium">{f.label}</div>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <motion.div
                      className="h-full rounded-full"
                      style={{ background: WEIGHT_BAR_COLOR }}
                      initial={{ width: 0 }}
                      whileInView={{ width: `${f.w * 100 * (100 / 32)}%` }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.9, delay: 0.15 + i * 0.08, ease: "easeOut" }}
                    />
                  </div>
                  <div className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">{f.w.toFixed(2)}</span> · {f.note}
                  </div>
                </motion.div>
              ))}
            </div>
            <p className="mt-6 rounded-lg border border-[#FFD6A5] bg-[#FFD6A5]/25 px-4 py-3 text-xs leading-relaxed text-[#4a2c05]">
              <TriangleAlert className="mr-1.5 inline size-3.5" aria-hidden />
              The score prioritizes crew attention — it is explicitly <strong>not</strong> an engineering-grade road-safety assessment. Human review always signs off.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {[
              { band: "80–100", label: "Critical", body: "Immediate action. Dispatch inspection within 24 h, emergency barriers if needed.", cls: "bg-[#C83E4D] text-white" },
              { band: "60–79", label: "High", body: "Schedule urgently — target inside the current maintenance cycle.", cls: "bg-[#D97706] text-white" },
              { band: "35–59", label: "Medium", body: "Fold into planned maintenance windows and ward work packages.", cls: "bg-[#8B3DFF] text-white" },
              { band: "0–34", label: "Low", body: "Monitor. Re-score automatically as density and age evolve.", cls: "bg-[#168266] text-white" },
            ].map((b, i) => (
              <motion.div
                key={b.label}
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.08 }}
                className="rounded-2xl border border-border bg-card p-6 shadow-sm transition-transform duration-300 hover:-translate-y-1"
              >
                <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold tracking-wide ${b.cls}`}>{b.band}</span>
                <h3 className="mt-3 font-display text-2xl font-semibold">{b.label}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{b.body}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- CASE STUDIES ---------------- */}
      <section id="field-notes" className="border-y border-border bg-card/50 scroll-mt-20">
        <div className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 lg:py-28">
          <SectionHeading
            eyebrow="Field notes"
            title="Where the pipeline already earns its keep"
            lead="Illustrative pilot narratives — the exact scenarios the platform is built to surface from the moment the first hazards are reported."
          />
          <div className="mt-14 grid gap-8 lg:grid-cols-3">
            {CASES.map((c, i) => (
              <motion.article
                key={c.title}
                initial={{ opacity: 0, y: 24 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, margin: "-60px" }}
                transition={{ duration: 0.6, delay: i * 0.1 }}
                className="group overflow-hidden rounded-2xl border border-border bg-card shadow-sm transition-all duration-300 hover:-translate-y-1.5 hover:shadow-[0_28px_56px_-24px_rgba(28,21,48,0.35)]"
              >
                <div className="relative aspect-[16/10] overflow-hidden">
                  <img src={c.img} alt={c.title} className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" loading="lazy" />
                  <span className="absolute left-4 top-4 rounded-full bg-background/90 px-3 py-1 text-[11px] font-semibold text-foreground backdrop-blur">{c.tag}</span>
                </div>
                <div className="p-6">
                  <p className="font-display text-2xl font-semibold text-[#6A00F4]">{c.metric}</p>
                  <h3 className="mt-1.5 font-display text-xl font-semibold leading-snug">{c.title}</h3>
                  <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">{c.body}</p>
                  <p className="mt-4 text-[11px] italic text-muted-foreground/80">{c.attribution}</p>
                </div>
              </motion.article>
            ))}
          </div>
        </div>
      </section>

      {/* ---------------- CTA ---------------- */}
      <section className="mx-auto w-full max-w-7xl px-4 py-20 sm:px-6 lg:py-24">
        <motion.div
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7 }}
          className="relative overflow-hidden rounded-3xl bg-[#6A00F4] px-6 py-16 text-center sm:px-12"
        >
          <div aria-hidden className="absolute inset-0 opacity-20" style={{ background: "radial-gradient(600px 240px at 20% 0%, #FFD6A5 0%, transparent 60%), radial-gradient(500px 220px at 85% 100%, #8B3DFF 0%, transparent 55%)" }} />
          <div className="relative">
            <h2 className="font-display text-4xl leading-tight text-white sm:text-5xl">Your street, mapped in under a minute.</h2>
            <p className="mx-auto mt-4 max-w-xl text-base leading-relaxed text-white/85">
              Create your account or sign in — the pothole scanner, live map, hazard reporting and the full work-order board are waiting inside.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Button size="lg" onClick={() => setView("signup")} className="bg-white px-7 text-[#4d00b3] hover:bg-[#FFD6A5] hover:text-[#4a2c05]">
                Create free account <ArrowRight className="size-4" aria-hidden />
              </Button>
              <Button size="lg" variant="outline" onClick={() => setView("signin")} className="border-white/40 bg-transparent px-7 text-white hover:bg-white/10 hover:text-white">
                <LogIn className="size-4" aria-hidden /> Sign in to explore
              </Button>
            </div>
          </div>
        </motion.div>

        <div className="mt-14 flex flex-wrap items-center justify-center gap-2.5">
          {TECH.map((t) => (
            <span key={t} className="rounded-full border border-border bg-card px-3.5 py-1.5 text-xs font-medium text-muted-foreground">
              {t}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}
