"use client";
// Detect Potholes — three-way detection studio:
//   1. LIVE    — webcam stream, frames sampled & analyzed on a rolling cycle (stateless /api/detect/frame)
//   2. IMAGE   — upload or pick a sample → upload → engine-chain inference → validated boxes
//   3. VIDEO   — upload → async frame-by-frame job → progress → per-frame gallery + majority-vote result
// Confidence threshold is user-adjustable; boxes below it are hidden. Engines are labeled honestly —
// when the vision chain is unreachable the live mode reports "no clear detection" instead of guessing.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, uploadFile, mediaUrl } from "@/lib/rg/api";
import { CLASS_META } from "@/lib/rg/constants";
import type { BboxDTO, InferenceResponse } from "@/lib/rg/types";
import { BboxOverlay, MediaFrame } from "@/components/rg/media";
import { SeverityDots } from "@/components/rg/primitives";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import {
  Camera,
  CameraOff,
  CheckCircle2,
  CircleAlert,
  Cpu,
  Download,
  Film,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  ScanSearch,
  ShieldCheck,
  SwitchCamera,
  Video,
} from "lucide-react";

const SAMPLES = [
  { src: "/demo/pothole-3.jpg", label: "Pothole · asphalt" },
  { src: "/demo/pothole-2.jpg", label: "Pothole · lane edge" },
  { src: "/demo/pothole-4.jpg", label: "Pothole · car wheel" },
  { src: "/demo/crack-1.jpg", label: "Cracks · markings" },
];

interface FrameResult {
  engine: string;
  modelVersion: string;
  inferenceMs: number;
  detections: BboxDTO[];
}

interface VideoJobState {
  jobId: string;
  status: string;
  progress: number;
  result?: {
    frames?: { frameIndex: number; frameTimeSec: number; annotatedMediaId: string | null; detections: BboxDTO[] }[];
    detections?: BboxDTO[];
    engine?: string;
    inferenceMs?: number;
  };
  error?: string;
}

function EngineBadge({ engine, modelVersion }: { engine?: string; modelVersion?: string }) {
  if (!engine) return null;
  const real = engine === "glm-vision" || engine === "yolo-service";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold",
        real ? "border-[#168266]/30 bg-[#168266]/10 text-[#0f5c49]" : "border-border bg-muted text-muted-foreground"
      )}
    >
      <Cpu className="size-3" aria-hidden />
      engine: {engine}
      {modelVersion && modelVersion !== "none" ? ` · ${modelVersion}` : ""}
    </span>
  );
}

function DetectionList({ detections, compact = false }: { detections: BboxDTO[]; compact?: boolean }) {
  if (detections.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
        No hazards cleared the confidence threshold in this capture — the engine reports
        <span className="font-semibold text-foreground"> “no clear detection”</span> rather than inventing boxes.
      </div>
    );
  }
  return (
    <ul className="space-y-2.5">
      {detections.map((d, i) => (
        <li key={`${d.id ?? i}-${d.hazardClass}`} className="rounded-xl border border-border bg-card p-3">
          <div className="flex items-center justify-between gap-3">
            <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-bold", CLASS_META[d.hazardClass].chip)}>
              {CLASS_META[d.hazardClass].label}
            </span>
            <span className="flex items-center gap-2">
              {!compact && <SeverityDots severity={d.severity} />}
              <span className="font-display text-lg font-semibold text-foreground">{Math.round(d.confidence * 100)}%</span>
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-[#6A00F4]" style={{ width: `${Math.round(d.confidence * 100)}%` }} />
          </div>
          <p className="mt-1.5 text-[11px] text-muted-foreground">
            area {(d.areaRatio * 100).toFixed(1)}% of frame · severity {d.severity}/5
          </p>
        </li>
      ))}
    </ul>
  );
}

function AntiHallucinationNote() {
  return (
    <div className="rounded-xl border border-[#168266]/25 bg-[#168266]/[0.06] p-4">
      <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-[#0f5c49]">
        <ShieldCheck className="size-3.5" aria-hidden /> Anti-hallucination pipeline
      </p>
      <ul className="mt-2 space-y-1.5 text-xs leading-relaxed text-muted-foreground">
        <li>• Conservative vision model — uncertain frames return “no clear detection”, never a guessed box.</li>
        <li>• Deterministic sanity filter: tight-box geometry, plausibility bounds, confidence floor 0.45, duplicate suppression.</li>
        <li>• Video results survive a 2-frame majority vote before they are shown.</li>
        <li>• Production deployments swap in the YOLO service (<code className="rounded bg-muted px-1">INFERENCE_SERVICE_URL</code>) trained via <code className="rounded bg-muted px-1">ml/</code>.</li>
      </ul>
    </div>
  );
}

/* ================================ LIVE WEBCAM ================================ */

function LiveMode({ threshold }: { threshold: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const [streaming, setStreaming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [latest, setLatest] = useState<FrameResult | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [stats, setStats] = useState({ frames: 0, hits: 0, ms: 0 });
  const [aspect, setAspect] = useState(4 / 3);

  const stop = useCallback(() => {
    const v = videoRef.current;
    const s = v?.srcObject as MediaStream | null;
    s?.getTracks().forEach((t) => t.stop());
    if (v) v.srcObject = null;
    setStreaming(false);
  }, []);

  useEffect(() => stop, [stop]);

  const captureAndAnalyze = useCallback(async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || inFlight.current) return;
    inFlight.current = true;
    setAnalyzing(true);
    try {
      if (!canvasRef.current) canvasRef.current = document.createElement("canvas");
      const c = canvasRef.current;
      const scale = Math.min(1, 720 / v.videoWidth);
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      c.getContext("2d")?.drawImage(v, 0, 0, c.width, c.height);
      const frame = c.toDataURL("image/jpeg", 0.82);
      const res = await api<FrameResult>("/api/detect/frame", { json: { frame, width: c.width, height: c.height } });
      const visible = res.detections.filter((d) => d.confidence >= threshold);
      setLatest({ ...res, detections: visible });
      setStats((s) => ({ frames: s.frames + 1, hits: s.hits + visible.length, ms: Math.round((s.ms * s.frames + res.inferenceMs) / (s.frames + 1)) }));
    } catch {
      /* transient frame failure — keep streaming */
    } finally {
      inFlight.current = false;
      setAnalyzing(false);
    }
  }, [threshold]);

  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => void captureAndAnalyze(), 3000);
    void captureAndAnalyze();
    return () => clearInterval(t);
  }, [streaming, captureAndAnalyze]);

  const start = async () => {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Live camera is unavailable in this browser or context (camera APIs need a secure, permissioned environment). Use the Image or Video tab instead — same engine, same output.");
      return;
    }
    setStarting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: deviceId ? { deviceId: { exact: deviceId } } : { facingMode: facing, width: { ideal: 1280 } },
        audio: false,
      });
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        await v.play();
        setAspect(v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 4 / 3);
      }
      setStreaming(true);
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === "videoinput"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Camera could not be started";
      setError(
        msg.includes("Permission") || msg.includes("denied") || msg.includes("NotAllowed")
          ? "Camera permission was denied. Allow access in your browser, or use the Image / Video tabs."
          : `Camera could not be started: ${msg}. The Image and Video tabs work everywhere.`
      );
    } finally {
      setStarting(false);
    }
  };

  const flip = () => {
    const next = facing === "environment" ? "user" : "environment";
    setFacing(next);
    setDeviceId(null);
    if (streaming) {
      stop();
      setTimeout(() => void start(), 120);
    }
  };

  const snapshot = () => {
    const v = videoRef.current;
    if (!v || !latest) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(v, 0, 0);
    const colors: Record<number, string> = { 1: "#168266", 2: "#168266", 3: "#D97706", 4: "#C83E4D", 5: "#C83E4D" };
    for (const d of latest.detections) {
      const [x, y, w, h] = d.bbox;
      ctx.strokeStyle = colors[d.severity] ?? "#6A00F4";
      ctx.lineWidth = Math.max(3, c.width / 300);
      ctx.strokeRect(x * c.width, y * c.height, w * c.width, h * c.height);
      const label = `${CLASS_META[d.hazardClass].short} ${Math.round(d.confidence * 100)}%`;
      ctx.font = `bold ${Math.max(14, Math.round(c.width / 42))}px sans-serif`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fillRect(x * c.width, Math.max(0, y * c.height - c.width / 26), tw + 12, c.width / 26);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, x * c.width + 6, Math.max(c.width / 38, y * c.height - 6));
    }
    const a = document.createElement("a");
    a.href = c.toDataURL("image/jpeg", 0.9);
    a.download = `hazardlens-live-${Date.now()}.jpg`;
    a.click();
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
      <div>
        <div ref={wrapRef} className="relative overflow-hidden rounded-2xl border border-border bg-[#1C1530]" style={{ aspectRatio: String(aspect) }}>
          <video ref={videoRef} playsInline muted className="absolute inset-0 h-full w-full object-cover" />
          {streaming ? (
            <>
              <BboxOverlay detections={latest?.detections ?? []} animate />
              <div className="absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/55 px-3 py-1.5 text-[11px] font-semibold text-white backdrop-blur">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#FF6B6B] opacity-70" />
                  <span className="relative inline-flex size-2 rounded-full bg-[#FF6B6B]" />
                </span>
                LIVE · analyzing every ~3 s {analyzing && "· running…"}
              </div>
              {latest && (
                <div className="absolute bottom-3 left-3 rounded-lg bg-black/55 px-3 py-1.5 text-[11px] text-white backdrop-blur">
                  {latest.detections.length} hazard{latest.detections.length === 1 ? "" : "s"} above threshold · {latest.inferenceMs} ms
                </div>
              )}
            </>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center">
              <span className="flex size-16 items-center justify-center rounded-2xl bg-white/10 text-white">
                <Camera className="size-7" aria-hidden />
              </span>
              <div>
                <p className="text-sm font-semibold text-white">Camera preview appears here</p>
                <p className="mt-1 text-xs text-white/60">Point at the road surface. Frames are analyzed on-device → server → validated result.</p>
              </div>
              <Button onClick={start} disabled={starting} className="bg-[#6A00F4] hover:bg-[#5a00d1]">
                {starting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Camera className="size-4" aria-hidden />}
                {starting ? "Requesting camera…" : "Start live detection"}
              </Button>
            </div>
          )}
        </div>

        {streaming && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" className="border-border" onClick={flip}>
              <SwitchCamera className="size-4" aria-hidden /> Flip camera
            </Button>
            <Button size="sm" variant="outline" className="border-border" onClick={snapshot} disabled={!latest}>
              <Download className="size-4" aria-hidden /> Snapshot with boxes
            </Button>
            <Button size="sm" variant="outline" className="border-border" onClick={() => void captureAndAnalyze()} disabled={analyzing}>
              {analyzing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />} Analyze now
            </Button>
            <Button size="sm" variant="destructive" onClick={stop}>
              <CameraOff className="size-4" aria-hidden /> Stop
            </Button>
          </div>
        )}

        {devices.length > 1 && streaming && (
          <div className="mt-3">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="cam-select">Camera</label>
            <select
              id="cam-select"
              className="mt-1 w-full rounded-md border border-border bg-card px-3 py-2 text-sm"
              value={deviceId ?? ""}
              onChange={(e) => {
                setDeviceId(e.target.value || null);
                stop();
                setTimeout(() => void start(), 120);
              }}
            >
              <option value="">Default ({facing} camera)</option>
              {devices.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>
              ))}
            </select>
          </div>
        )}

        {error && (
          <div className="mt-4 rounded-xl border border-[#D97706]/30 bg-[#FFD6A5]/30 p-4 text-sm leading-relaxed text-[#4a2c05]">
            <p className="flex items-center gap-1.5 font-semibold"><CircleAlert className="size-4" aria-hidden /> Camera unavailable</p>
            <p className="mt-1">{error}</p>
          </div>
        )}
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">This session</p>
            {latest && <EngineBadge engine={latest.engine} modelVersion={latest.modelVersion} />}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-3 text-center">
            {[
              { v: stats.frames, l: "frames analyzed" },
              { v: stats.hits, l: "validated hazards" },
              { v: stats.ms, l: "avg ms / frame" },
            ].map((s) => (
              <div key={s.l} className="rounded-lg bg-muted/60 p-3">
                <p className="font-display text-2xl font-semibold text-foreground">{s.v}</p>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{s.l}</p>
              </div>
            ))}
          </div>
        </div>
        {latest ? (
          <DetectionList detections={latest.detections} />
        ) : (
          <div className="rounded-xl border border-dashed border-border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
            Start the camera — validated detections stream in here.
          </div>
        )}
        <AntiHallucinationNote />
      </div>
    </div>
  );
}

/* ================================ IMAGE MODE ================================ */

function ImageMode({ threshold }: { threshold: number }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [inferring, setInferring] = useState(false);
  const [result, setResult] = useState<InferenceResponse | null>(null);
  const [localUrl, setLocalUrl] = useState<string | null>(null);

  const run = async (file: File) => {
    setResult(null);
    setLocalUrl(URL.createObjectURL(file));
    setUploading(true);
    try {
      const up = await uploadFile(file, false);
      setUploading(false);
      setInferring(true);
      const res = await api<InferenceResponse>("/api/inference", { json: { mediaId: up.mediaId } });
      setResult(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Detection failed");
    } finally {
      setUploading(false);
      setInferring(false);
    }
  };

  const loadSample = async (src: string) => {
    try {
      setUploading(true);
      const blob = await (await fetch(src)).blob();
      const file = new File([blob], src.split("/").pop() ?? "sample.jpg", { type: blob.type || "image/jpeg" });
      setUploading(false);
      await run(file);
    } catch {
      setUploading(false);
      toast.error("Could not load the sample image");
    }
  };

  const visible = (result?.detections ?? []).filter((d) => d.confidence >= threshold);

  return (
    <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
      <div>
        <label
          className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border bg-card p-10 text-center transition-colors hover:border-[#6A00F4]/50 hover:bg-secondary/40"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) void run(f);
          }}
        >
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void run(f); }} />
          <span className="flex size-12 items-center justify-center rounded-xl bg-[#6A00F4]/10 text-[#6A00F4]">
            <ImageIcon className="size-5" aria-hidden />
          </span>
          <span className="text-sm font-semibold">Drop a road image here, or click to browse</span>
          <span className="text-xs text-muted-foreground">JPEG / PNG / WebP · up to 12 MB · EXIF metadata stripped automatically</span>
        </label>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Try a sample:</span>
          {SAMPLES.map((s) => (
            <button
              key={s.src}
              onClick={() => void loadSample(s.src)}
              className="group relative h-14 w-20 overflow-hidden rounded-lg border border-border transition-all hover:-translate-y-0.5 hover:border-[#6A00F4]/60 hover:shadow-md"
              title={s.label}
            >
              <img src={s.src} alt={s.label} className="h-full w-full object-cover" loading="lazy" />
            </button>
          ))}
        </div>

        {(localUrl || uploading || inferring) && (
          <div className="relative mt-5 overflow-hidden rounded-2xl border border-border">
            <img src={localUrl ?? undefined} alt="Image under analysis" className="max-h-[480px] w-full object-contain bg-[#1C1530]" />
            {result && <BboxOverlay detections={visible} />}
            {(uploading || inferring) && (
              <div className="absolute inset-0 flex items-center justify-center bg-background/70 backdrop-blur-sm">
                <div className="flex items-center gap-3 rounded-full bg-card px-5 py-2.5 shadow-lg">
                  <Loader2 className="size-4 animate-spin text-[#6A00F4]" aria-hidden />
                  <span className="text-sm font-medium">{uploading ? "Securing upload…" : "Analyzing for hazards…"}</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-semibold">Result</p>
            {result && <EngineBadge engine={result.engine} modelVersion={result.modelVersion} />}
          </div>
          {result && (
            <p className="mt-1 text-xs text-muted-foreground">
              {visible.length} hazard{visible.length === 1 ? "" : "s"} ≥ {Math.round(threshold * 100)}% confidence · {result.inferenceMs} ms
            </p>
          )}
        </div>
        {inferring || uploading ? (
          <div className="rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto size-5 animate-spin text-[#6A00F4]" aria-hidden />
            <p className="mt-2">The vision chain is inspecting the image…</p>
          </div>
        ) : result ? (
          <DetectionList detections={visible} />
        ) : (
          <div className="rounded-xl border border-dashed border-border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
            Upload an image or tap a sample — validated detections appear here.
          </div>
        )}
        <AntiHallucinationNote />
      </div>
    </div>
  );
}

/* ================================ VIDEO MODE ================================ */

function VideoMode({ threshold }: { threshold: number }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [job, setJob] = useState<VideoJobState | null>(null);
  const [loadingSample, setLoadingSample] = useState(false);

  useEffect(() => {
    if (!job || job.status === "SUCCEEDED" || job.status === "FAILED") return;
    const t = setInterval(async () => {
      try {
        const j = await api<VideoJobState>(`/api/inference/jobs/${job.jobId}`);
        setJob((prev) => (prev ? { ...prev, ...j } : j));
      } catch {
        /* keep polling */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [job]);

  const run = async (file: File) => {
    setJob(null);
    setPreviewUrl(URL.createObjectURL(file));
    setUploading(true);
    try {
      const up = await uploadFile(file, false);
      const res = await api<{ jobId: string }>("/api/inference", { json: { mediaId: up.mediaId } });
      setJob({ jobId: res.jobId, status: "QUEUED", progress: 0 });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Video analysis failed");
    } finally {
      setUploading(false);
    }
  };

  const loadSample = async () => {
    try {
      setLoadingSample(true);
      const blob = await (await fetch("/demo/sample-hazards.mp4")).blob();
      const file = new File([blob], "sample-hazards.mp4", { type: "video/mp4" });
      setLoadingSample(false);
      await run(file);
    } catch {
      setLoadingSample(false);
      toast.error("Could not load the sample clip");
    }
  };

  const aggregated = (job?.result?.detections ?? []).filter((d) => d.confidence >= threshold);
  const frames = job?.result?.frames ?? [];

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
        <div>
          <label
            className="flex cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-border bg-card p-10 text-center transition-colors hover:border-[#6A00F4]/50 hover:bg-secondary/40"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) void run(f);
            }}
          >
            <input ref={fileRef} type="file" accept="video/mp4,video/webm,video/quicktime" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void run(f); }} />
            <span className="flex size-12 items-center justify-center rounded-xl bg-[#6A00F4]/10 text-[#6A00F4]">
              <Film className="size-5" aria-hidden />
            </span>
            <span className="text-sm font-semibold">Drop a pre-recorded clip here, or click to browse</span>
            <span className="text-xs text-muted-foreground">MP4 / WebM / MOV · up to 60 MB · sampled every 20% of duration</span>
          </label>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">No clip handy?</span>
            <Button size="sm" variant="outline" className="border-border" onClick={() => void loadSample()} disabled={loadingSample || uploading || Boolean(job)}>
              {loadingSample ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Film className="size-4" aria-hidden />}
              Analyze a 9-second sample clip (3 scenes)
            </Button>
            {job && (job.status === "SUCCEEDED" || job.status === "FAILED") && (
              <Button
                size="sm"
                variant="outline"
                className="border-border"
                onClick={() => {
                  setJob(null);
                  setPreviewUrl(null);
                }}
              >
                <RefreshCw className="size-4" aria-hidden /> Scan another clip
              </Button>
            )}
          </div>

          {previewUrl && (
            <div className="relative mt-5 overflow-hidden rounded-2xl border border-border bg-[#1C1530]">
              <video src={previewUrl} controls muted className="max-h-[440px] w-full" />
            </div>
          )}

          {job && job.status !== "SUCCEEDED" && job.status !== "FAILED" && (
            <div className="mt-5 rounded-2xl border border-border bg-card p-5">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-semibold">
                  <Loader2 className="size-4 animate-spin text-[#6A00F4]" aria-hidden /> Frame-by-frame analysis {job.status.toLowerCase()}…
                </span>
                <span className="text-muted-foreground">{job.progress}%</span>
              </div>
              <Progress value={job.progress} className="mt-3" />
              <p className="mt-2 text-xs text-muted-foreground">Each sampled frame runs through the validated engine chain.</p>
            </div>
          )}
          {job?.status === "FAILED" && (
            <div className="mt-5 rounded-xl border border-[#C83E4D]/30 bg-[#C83E4D]/10 p-4 text-sm text-[#C83E4D]">
              {job.error ?? "Video processing failed"}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-semibold">Majority-vote result</p>
              {job?.result?.engine && <EngineBadge engine={job.result.engine} modelVersion="glm-4.5v" />}
            </div>
            {job?.result && (
              <p className="mt-1 text-xs text-muted-foreground">
                Classes must appear in ≥2 sampled frames to survive · {job.result.inferenceMs ?? 0} ms total
              </p>
            )}
          </div>
          {job?.status === "SUCCEEDED" ? (
            <DetectionList detections={aggregated} />
          ) : (
            <div className="rounded-xl border border-dashed border-border bg-muted/40 p-4 text-center text-sm text-muted-foreground">
              {job ? "Aggregated result appears when processing completes." : "Upload a clip — the aggregated, vote-filtered result lands here."}
            </div>
          )}
          <AntiHallucinationNote />
        </div>
      </div>

      {frames.length > 0 && (
        <section aria-label="Per-frame results">
          <h3 className="font-display text-xl font-semibold">Sampled frames</h3>
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {frames.map((f) => (
              <div key={f.frameIndex} className="overflow-hidden rounded-xl border border-border bg-card">
                <MediaFrame
                  mediaId={f.annotatedMediaId}
                  alt={`Frame at ${f.frameTimeSec}s`}
                  detections={f.detections.filter((d) => d.confidence >= threshold)}
                  className="aspect-video w-full"
                />
                <div className="flex items-center justify-between px-3 py-2 text-xs text-muted-foreground">
                  <span>t = {f.frameTimeSec}s</span>
                  <span>{f.detections.length} detection{f.detections.length === 1 ? "" : "s"}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/* ================================ PAGE ================================ */

const MODES = [
  { id: "live", label: "Live webcam", icon: Camera, blurb: "Real-time sweep with your camera", accent: "bg-[#6A00F4]/10 text-[#6A00F4]" },
  { id: "image", label: "Image", icon: ImageIcon, blurb: "Upload or pick a pothole photo", accent: "bg-[#168266]/10 text-[#168266]" },
  { id: "video", label: "Pre-recorded video", icon: Video, blurb: "Frame-by-frame dashcam analysis", accent: "bg-[#D97706]/10 text-[#D97706]" },
];

export function DetectStudio() {
  const [mode, setMode] = useState("live");
  const [threshold, setThreshold] = useState(0.5);

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-10 sm:px-6 lg:py-14">
      <div className="max-w-3xl">
        <span className="inline-flex items-center gap-2 rounded-full border border-[#6A00F4]/25 bg-[#6A00F4]/[0.06] px-3.5 py-1.5 text-xs font-semibold text-[#4d00b3]">
          <ScanSearch className="size-3.5" aria-hidden /> Detection studio
        </span>
        <h1 className="mt-4 font-display text-4xl tracking-tight sm:text-5xl">Detect potholes</h1>
        <p className="mt-3 text-lg leading-relaxed text-muted-foreground">
          Run the HazardLensAI vision engine three ways — through your <strong className="text-foreground">live webcam</strong>, a single{" "}
          <strong className="text-foreground">image</strong>, or a <strong className="text-foreground">pre-recorded video</strong>. Every result is
          validated before it reaches you; when the engine is unsure it says so instead of inventing hazards.
        </p>
      </div>

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        {MODES.map((m) => (
          <button
            key={m.id}
            onClick={() => setMode(m.id)}
            className={cn(
              "flex items-center gap-3.5 rounded-2xl border p-4 text-left transition-all",
              mode === m.id
                ? "border-[#6A00F4] bg-[#6A00F4]/[0.05] shadow-[0_12px_32px_-16px_rgba(106,0,244,0.4)]"
                : "border-border bg-card hover:-translate-y-0.5 hover:shadow-md"
            )}
            aria-pressed={mode === m.id}
          >
            <span className={cn("flex size-11 shrink-0 items-center justify-center rounded-xl", m.accent)}>
              <m.icon className="size-5" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-bold">
                {m.label}
                {mode === m.id && <CheckCircle2 className="size-3.5 text-[#6A00F4]" aria-hidden />}
              </span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">{m.blurb}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card px-5 py-4">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Confidence threshold</span>
          <Slider
            value={[threshold]}
            onValueChange={([v]) => setThreshold(v)}
            min={0.3}
            max={0.95}
            step={0.05}
            className="w-44"
            aria-label="Confidence threshold"
          />
          <span className="w-12 font-display text-lg font-semibold text-[#6A00F4]">{Math.round(threshold * 100)}%</span>
        </div>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5 text-[#168266]" aria-hidden /> Boxes below the threshold are hidden — precision first.
        </p>
      </div>

      <Tabs value={mode} onValueChange={setMode} className="mt-8">
        <TabsList className="sr-only">
          <TabsTrigger value="live">Live webcam</TabsTrigger>
          <TabsTrigger value="image">Image</TabsTrigger>
          <TabsTrigger value="video">Video</TabsTrigger>
        </TabsList>
        <TabsContent value="live" className="mt-0">
          <LiveMode threshold={threshold} />
        </TabsContent>
        <TabsContent value="image" className="mt-0">
          <ImageMode threshold={threshold} />
        </TabsContent>
        <TabsContent value="video" className="mt-0">
          <VideoMode threshold={threshold} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
