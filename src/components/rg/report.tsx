"use client";
// Report a Hazard — 3-step wizard: media → location → review. AI preview after upload.
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, uploadFile, mediaUrl } from "@/lib/rg/api";
import { useApp } from "@/lib/rg/store";
import { dynamicImport } from "@/lib/rg/lazy";
import { CLASS_META, HAZARD_CLASSES, ROAD_CLASS_CRITICALITY } from "@/lib/rg/constants";
import type { BboxDTO, DuplicateCandidateDTO, HazardClass, InferenceResponse, RoadClass } from "@/lib/rg/types";
import { SeverityDots } from "@/components/rg/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { BboxOverlay } from "@/components/rg/media";
import { Camera, Check, ChevronLeft, ChevronRight, CopyPlus, Crosshair, Eye, GitMerge, Loader2, MapPin, Search, ShieldCheck, Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaDTO } from "@/lib/rg/types";

const LeafletMap = dynamicImport(() => import("@/components/rg/leaflet-map"));

interface GeoResult {
  lat: number;
  lng: number;
  label: string;
}

type WizardState = {
  step: 1 | 2 | 3;
  file: File | null;
  previewUrl: string | null;
  uploading: boolean;
  media: { mediaId: string; mimeType: string } | null;
  inferring: boolean;
  inference: InferenceResponse | null;
  videoJob: { jobId: string; status: string; progress: number } | null;
  lat: number | null;
  lng: number | null;
  addressLabel: string | null;
  hazardClass: HazardClass;
  severity: number;
  notes: string;
  roadName: string;
  roadClass: RoadClass | "none";
  blurRequested: boolean;
  geoConsent: boolean;
  exifSuggestion: { lat: number; lng: number } | null;
  submitting: boolean;
  submittedRef: string | null;
  mergedIntoRef: string | null;
  dupCandidates: DuplicateCandidateDTO[] | null;
  thresholdPct: number;
};

const INITIAL: WizardState = {
  step: 1,
  file: null,
  previewUrl: null,
  uploading: false,
  media: null,
  inferring: false,
  inference: null,
  videoJob: null,
  lat: null,
  lng: null,
  addressLabel: null,
  hazardClass: "pothole",
  severity: 3,
  notes: "",
  roadName: "",
  roadClass: "none",
  blurRequested: false,
  geoConsent: false,
  exifSuggestion: null,
  submitting: false,
  submittedRef: null,
  mergedIntoRef: null,
  dupCandidates: null,
  thresholdPct: 70,
};

export function ReportWizard() {
  const { user, refreshUnread } = useApp();
  const [st, setSt] = useState<WizardState>(INITIAL);
  const [searchQ, setSearchQ] = useState("");
  const [results, setResults] = useState<GeoResult[]>([]);
  const [searching, setSearching] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const patch = (p: Partial<WizardState>) => setSt((s) => ({ ...s, ...p }));

  /* ---------------- media ---------------- */
  const onFile = useCallback(
    async (file: File) => {
      patch({ file, previewUrl: URL.createObjectURL(file), uploading: true, inference: null, media: null });
      try {
        const up = await uploadFile(file, st.geoConsent);
        patch({ media: { mediaId: up.mediaId, mimeType: up.mimeType }, uploading: false, exifSuggestion: up.suggestedLocation });
        if (up.suggestedLocation) {
          patch({ lat: up.suggestedLocation.lat, lng: up.suggestedLocation.lng });
          toast.info("Location found in photo metadata", { description: "Suggested pin placed — adjust it if needed." });
        }
        // run AI detection
        if (up.mimeType.startsWith("image/")) {
          patch({ inferring: true });
          try {
            const res = await api<InferenceResponse>("/api/inference", { json: { mediaId: up.mediaId } });
            patch({ inference: res, inferring: false });
            if (res.detections[0]) {
              patch({ hazardClass: res.detections[0].hazardClass, severity: res.detections[0].severity });
            }
          } catch (err) {
            patch({ inferring: false });
            toast.error(err instanceof Error ? err.message : "Detection failed");
          }
        } else {
          // video → async job, poll
          try {
            const res = await api<{ jobId: string }>("/api/inference", { json: { mediaId: up.mediaId } });
            patch({ videoJob: { jobId: res.jobId, status: "QUEUED", progress: 0 } });
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Video job failed");
          }
        }
      } catch (err) {
        patch({ uploading: false });
        toast.error(err instanceof Error ? err.message : "Upload failed");
      }
    },
    [st.geoConsent]
  );

  // poll video job
  useEffect(() => {
    if (!st.videoJob || st.videoJob.status === "SUCCEEDED" || st.videoJob.status === "FAILED") return;
    const t = setInterval(async () => {
      try {
        const job = await api<{ status: string; progress: number; result?: { detections?: BboxDTO[] }; error?: string }>(
          `/api/inference/jobs/${st.videoJob!.jobId}`
        );
        patch({ videoJob: { jobId: st.videoJob!.jobId, status: job.status, progress: job.progress } });
        if (job.status === "SUCCEEDED" && job.result?.detections?.length) {
          const dets = job.result.detections;
          patch({
            inference: {
              mediaId: st.media!.mediaId,
              engine: "demo-engine-v2",
              modelVersion: "roadguard-yolo-demo-v2",
              inferenceMs: 0,
              detections: dets,
              jobId: st.videoJob!.jobId,
            },
          });
          if (dets[0]) patch({ hazardClass: dets[0].hazardClass, severity: dets[0].severity });
          toast.success("Video analyzed frame by frame");
        }
        if (job.status === "FAILED") toast.error(job.error ?? "Video analysis failed");
      } catch {
        /* keep polling */
      }
    }, 1500);
    return () => clearInterval(t);
  }, [st.videoJob, st.media]);

  /* ---------------- geolocation + search ---------------- */
  const locate = () => {
    if (!st.geoConsent) {
      toast.error("Consent required", { description: "Please confirm the location notice first — we only read GPS with your explicit permission." });
      return;
    }
    if (!navigator.geolocation) {
      toast.error("Geolocation unavailable in this browser");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => patch({ lat: pos.coords.latitude, lng: pos.coords.longitude, addressLabel: null }),
      () => toast.error("Could not read device location", { description: "Drop the pin manually instead." }),
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  useEffect(() => {
    if (searchQ.trim().length < 3) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await api<{ results: GeoResult[] }>(`/api/geocode?q=${encodeURIComponent(searchQ)}`);
        setResults(res.results);
      } catch {
        setResults([]);
      } finally {
        setSearching(false);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [searchQ]);

  /* ---------------- submit + duplicate decision ---------------- */
  const submit = async (opts?: { forceNew?: boolean; mergeIntoId?: string }) => {
    if (!st.media) {
      toast.error("Upload media first");
      patch({ step: 1 });
      return;
    }
    if (st.lat == null || st.lng == null) {
      toast.error("Place the hazard pin on the map first");
      patch({ step: 2 });
      return;
    }
    if (!st.geoConsent) {
      toast.error("Location consent is required to submit");
      return;
    }
    patch({ submitting: true });
    try {
      const res = await api<{
        report: { referenceCode: string };
        mergedIntoRef?: string | null;
        requiresDecision?: boolean;
        candidates?: DuplicateCandidateDTO[];
        thresholdPct?: number;
      }>("/api/reports", {
        json: {
          mediaIds: [st.media.mediaId],
          detectionIds: st.inference?.detections.map((d) => d.id).filter(Boolean) ?? [],
          hazardClass: st.hazardClass,
          severity: st.severity,
          lat: st.lat,
          lng: st.lng,
          notes: st.notes,
          roadName: st.roadName || undefined,
          roadClass: st.roadClass === "none" ? undefined : st.roadClass,
          geoConsent: true,
          blurRequested: st.blurRequested,
          forceNew: opts?.forceNew,
          mergeIntoId: opts?.mergeIntoId,
        },
      });
      if (res.requiresDecision && res.candidates?.length) {
        // Possible existing hazard — the reporter decides, nothing was created.
        patch({ submitting: false, dupCandidates: res.candidates, thresholdPct: res.thresholdPct ?? 70 });
        return;
      }
      patch({ submittedRef: res.report.referenceCode, mergedIntoRef: res.mergedIntoRef ?? null, submitting: false });
      void refreshUnread();
      toast.success(res.mergedIntoRef ? `Report merged with ${res.mergedIntoRef}` : `Report ${res.report.referenceCode} submitted`);
    } catch (err) {
      patch({ submitting: false });
      toast.error(err instanceof Error ? err.message : "Submission failed");
    }
  };

  /* ---------------- success screen ---------------- */
  if (st.submittedRef) {
    return (
      <div className="mx-auto max-w-xl px-4 py-20 text-center sm:px-6">
        <div className="mx-auto flex size-16 items-center justify-center rounded-full bg-[#168266]/15 text-[#168266]">
          <Check className="size-8" aria-hidden />
        </div>
        <h1 className="mt-6 font-display text-4xl">
          {st.mergedIntoRef ? "Report merged — thank you." : "Thank you — hazard logged."}
        </h1>
        <p className="mt-3 text-muted-foreground">
          {st.mergedIntoRef ? (
            <>
              Your evidence was counted toward existing hazard{" "}
              <span className="font-bold text-[#6A00F4]">{st.mergedIntoRef}</span>, raising its community confidence and risk accuracy.
              Tracking reference <span className="font-bold text-[#6A00F4]">{st.submittedRef}</span>.
            </>
          ) : (
            <>
              Tracking reference <span className="font-bold text-[#6A00F4]">{st.submittedRef}</span>. The hazard now sits in the
              verification queue with its AI detections and risk score, and you will be notified as it moves through the repair pipeline.
            </>
          )}
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Button variant="outline" className="border-border" onClick={() => setSt({ ...INITIAL, geoConsent: st.geoConsent })}>
            Submit another
          </Button>
          <Button
            className="bg-[#6A00F4] hover:bg-[#5a00d1]"
            onClick={() => useApp.getState().setView("map")}
          >
            <MapPin className="size-4" aria-hidden /> View it on the live map
          </Button>
          {user && (
            <Button variant="outline" className="border-border" onClick={() => useApp.getState().setView("dashboard")}>
              Track in my dashboard
            </Button>
          )}
        </div>
      </div>
    );
  }

  const detections = st.inference?.detections ?? [];
  const primary = detections[0];

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <div className="mb-8">
        <h1 className="font-display text-4xl tracking-tight">Report a hazard</h1>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Upload a photo or short video, confirm the location, and the detection engine will pre-fill the details. Your hazard is pinned on the live map at the exact spot you drop — photo and detection included.
        </p>
      </div>

      {/* stepper */}
      <ol className="mb-8 flex items-center gap-2 text-sm" aria-label="Progress">
        {["Media & AI", "Location", "Review"].map((label, i) => {
          const n = (i + 1) as 1 | 2 | 3;
          const done = st.step > n;
          const activeStep = st.step === n;
          return (
            <li key={label} className="flex flex-1 items-center gap-2">
              <button
                onClick={() => n < st.step && patch({ step: n })}
                disabled={n >= st.step}
                className={cn(
                  "flex size-8 items-center justify-center rounded-full border text-xs font-bold transition-colors",
                  done && "border-[#168266] bg-[#168266] text-white",
                  activeStep && "border-[#6A00F4] bg-[#6A00F4] text-white",
                  !done && !activeStep && "border-border bg-card text-muted-foreground"
                )}
                aria-current={activeStep ? "step" : undefined}
              >
                {done ? <Check className="size-4" aria-hidden /> : n}
              </button>
              <span className={cn("hidden sm:block", activeStep ? "font-semibold text-foreground" : "text-muted-foreground")}>{label}</span>
              {i < 2 && <span className="h-px flex-1 bg-border" aria-hidden />}
            </li>
          );
        })}
      </ol>

      {/* STEP 1 — media */}
      {st.step === 1 && (
        <div className="grid gap-8 lg:grid-cols-2">
          <div>
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload photo or video"
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => e.key === "Enter" && fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const f = e.dataTransfer.files?.[0];
                if (f) void onFile(f);
              }}
              className="flex min-h-64 cursor-pointer flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-input bg-card p-8 text-center transition-colors hover:border-[#6A00F4]/60 hover:bg-[#6A00F4]/[0.03]"
            >
              <span className="flex size-12 items-center justify-center rounded-full bg-[#6A00F4]/10 text-[#6A00F4]">
                <Upload className="size-5" aria-hidden />
              </span>
              <p className="text-sm font-medium">Drop an image or video here, or click to browse</p>
              <p className="text-xs text-muted-foreground">JPEG/PNG up to 12 MB · MP4/WebM/MOV up to 60 MB</p>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,video/mp4,video/webm,video/quicktime"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void onFile(f);
                }}
              />
            </div>
            <div className="mt-4 flex items-start gap-2.5 rounded-xl border border-[#FFD6A5] bg-[#FFD6A5]/25 p-4 text-xs leading-relaxed text-[#4a2c05]">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>
                <strong>Privacy:</strong> photos are re-encoded to strip all EXIF metadata before storage. GPS in your file is read
                <strong> only if you consent</strong> in the next step. Faces and plates can be blurred by the production pipeline.
              </span>
            </div>
          </div>

          <div className="space-y-4">
            <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-border bg-muted/40">
              {st.previewUrl ? (
                st.file?.type.startsWith("video/") ? (
                  <video src={st.previewUrl} controls className="h-full w-full object-contain" />
                ) : (
                  <>
                    <img src={st.previewUrl} alt="Upload preview" className="h-full w-full object-cover" />
                    <BboxOverlay detections={detections} animate />
                  </>
                )
              ) : (
                <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Camera className="size-4" aria-hidden /> Preview appears here
                </div>
              )}
              {(st.uploading || st.inferring) && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background/80 backdrop-blur-sm">
                  <Loader2 className="size-7 animate-spin text-[#6A00F4]" aria-hidden />
                  <p className="text-sm font-medium">{st.uploading ? "Uploading & stripping metadata…" : "Running detection engine…"}</p>
                </div>
              )}
            </div>

            {st.videoJob && st.videoJob.status !== "SUCCEEDED" && (
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium">Frame-by-frame analysis</span>
                  <span className="text-xs text-muted-foreground">{st.videoJob.status.toLowerCase()} · {st.videoJob.progress}%</span>
                </div>
                <Progress className="mt-2" value={st.videoJob.progress} />
              </div>
            )}

            {st.inference && (
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">
                    {detections.length} detection{detections.length === 1 ? "" : "s"}
                  </p>
                  <span className="rounded-full bg-secondary px-2.5 py-0.5 text-[11px] font-medium text-secondary-foreground">
                    engine: {st.inference.engine} · {st.inference.modelVersion}
                  </span>
                </div>
                <ul className="mt-3 space-y-2">
                  {detections.map((d, i) => (
                    <li key={i} className="flex items-center justify-between rounded-lg bg-muted/60 px-3 py-2 text-xs">
                      <span className="font-medium">{CLASS_META[d.hazardClass].label}</span>
                      <span className="flex items-center gap-3">
                        <span className="tabular-nums text-muted-foreground">conf {(d.confidence * 100).toFixed(0)}%</span>
                        <SeverityDots severity={d.severity} />
                      </span>
                    </li>
                  ))}
                  {detections.length === 0 && <li className="text-xs text-muted-foreground">No hazards detected — you can still submit the report.</li>}
                </ul>
              </div>
            )}

            <div className="flex justify-end">
              <Button
                onClick={() => patch({ step: 2 })}
                disabled={!st.media || st.uploading || st.inferring}
                className="bg-[#6A00F4] hover:bg-[#5a00d1]"
              >
                Continue to location <ChevronRight className="size-4" aria-hidden />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* STEP 2 — location */}
      {st.step === 2 && (
        <div className="grid gap-8 lg:grid-cols-[1fr_1.2fr]">
          <div className="space-y-5">
            <div className="rounded-xl border border-[#FFD6A5] bg-[#FFD6A5]/25 p-4 text-xs leading-relaxed text-[#4a2c05]">
              <strong>Location privacy.</strong> HazardLensAI stores the hazard coordinates you place below. Device GPS and photo-EXIF
              locations are used only with your explicit consent, and consent can be withdrawn in your profile at any time.
            </div>
            <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
              <div>
                <Label htmlFor="geo-consent" className="text-sm font-medium">Allow device GPS & EXIF location</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">Optional. You can always drop the pin manually.</p>
              </div>
              <Switch id="geo-consent" checked={st.geoConsent} onCheckedChange={(v) => patch({ geoConsent: v })} />
            </div>
            <Button variant="outline" className="w-full border-border" onClick={locate} disabled={!st.geoConsent}>
              <Crosshair className="size-4" aria-hidden /> Use my current location
            </Button>
            {st.exifSuggestion && (
              <p className="text-xs text-muted-foreground">
                <MapPin className="mr-1 inline size-3.5" aria-hidden /> EXIF-suggested pin placed at {st.exifSuggestion.lat.toFixed(4)}, {st.exifSuggestion.lng.toFixed(4)} — verify it points at the hazard.
              </p>
            )}
            <div>
              <Label htmlFor="addr-search" className="text-sm font-medium">Search address or landmark</Label>
              <div className="relative mt-1.5">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input id="addr-search" className="pl-9" placeholder="e.g. Silk Board Junction, Bengaluru" value={searchQ} onChange={(e) => setSearchQ(e.target.value)} />
                {searching && <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" aria-hidden />}
              </div>
              {results.length > 0 && (
                <ul className="mt-2 max-h-44 overflow-y-auto rounded-lg border border-border bg-card scrollbar-slim">
                  {results.map((r, i) => (
                    <li key={i}>
                      <button
                        className="w-full px-3 py-2 text-left text-xs hover:bg-secondary"
                        onClick={() => {
                          patch({ lat: r.lat, lng: r.lng, addressLabel: r.label });
                          setResults([]);
                        }}
                      >
                        {r.label}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">Latitude</Label>
                <Input readOnly value={st.lat?.toFixed(5) ?? ""} placeholder="—" className="tabular-nums" />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Longitude</Label>
                <Input readOnly value={st.lng?.toFixed(5) ?? ""} placeholder="—" className="tabular-nums" />
              </div>
            </div>
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => patch({ step: 1 })}>
                <ChevronLeft className="size-4" aria-hidden /> Back
              </Button>
              <Button onClick={() => patch({ step: 3 })} disabled={st.lat == null || st.lng == null} className="bg-[#6A00F4] hover:bg-[#5a00d1]">
                Continue to review <ChevronRight className="size-4" aria-hidden />
              </Button>
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl border border-border bg-card">
            <div className="h-[420px] lg:h-[520px]">
              <LeafletMap
                hazards={[]}
                clusters={[]}
                pickMode
                pin={st.lat != null && st.lng != null ? { lat: st.lat, lng: st.lng } : null}
                onPin={(p) => patch({ lat: p.lat, lng: p.lng })}
                center={st.lat != null && st.lng != null ? [st.lat, st.lng] : [12.9629, 77.6389]}
                zoom={st.lat != null ? 16 : 11}
                className="h-full w-full"
              />
            </div>
            <p className="border-t border-border px-4 py-2.5 text-center text-xs text-muted-foreground">
              Tap the map to drop or move the pin at the exact hazard spot.
            </p>
          </div>
        </div>
      )}

      {/* STEP 3 — review */}
      {st.step === 3 && (
        <div className="grid gap-8 lg:grid-cols-[1fr_1.1fr]">
          <div className="space-y-5">
            <div>
              <Label className="text-sm font-medium">Hazard type</Label>
              <Select value={st.hazardClass} onValueChange={(v) => patch({ hazardClass: v as HazardClass })}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {HAZARD_CLASSES.map((c) => (
                    <SelectItem key={c} value={c}>{CLASS_META[c].label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {primary && (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  AI suggested <strong>{CLASS_META[primary.hazardClass].label.toLowerCase()}</strong> at {(primary.confidence * 100).toFixed(0)}% confidence — correct it if needed.
                </p>
              )}
            </div>
            <div>
              <Label className="text-sm font-medium">Severity — operational heuristic (1 minor → 5 hazardous)</Label>
              <Slider
                className="mt-3"
                min={1}
                max={5}
                step={1}
                value={[st.severity]}
                onValueChange={([v]) => patch({ severity: v })}
              />
              <div className="mt-2"><SeverityDots severity={st.severity} /></div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label className="text-sm font-medium">Road name</Label>
                <Input className="mt-1.5" placeholder="e.g. Hosur Road" value={st.roadName} onChange={(e) => patch({ roadName: e.target.value })} />
              </div>
              <div>
                <Label className="text-sm font-medium">Road class</Label>
                <Select value={st.roadClass} onValueChange={(v) => patch({ roadClass: v as RoadClass | "none" })}>
                  <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not sure</SelectItem>
                    {Object.keys(ROAD_CLASS_CRITICALITY).map((rc) => (
                      <SelectItem key={rc} value={rc}>{rc}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium">Notes for the review team</Label>
              <Textarea className="mt-1.5 min-h-24" placeholder="Landmarks, lane position, time of day, how it affects traffic…" value={st.notes} onChange={(e) => patch({ notes: e.target.value })} maxLength={2000} />
            </div>
            <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
              <div>
                <Label htmlFor="blur" className="text-sm font-medium">Request privacy blur</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">Production pipeline blurs faces & plates (OpenCV).</p>
              </div>
              <Switch id="blur" checked={st.blurRequested} onCheckedChange={(v) => patch({ blurRequested: v })} />
            </div>
            {!user && (
              <p className="text-xs text-muted-foreground">
                Submitting as a guest. <button className="font-semibold text-[#6A00F4] hover:underline" onClick={() => useApp.getState().setView("signin")}>Sign in</button> to track this report in your dashboard.
              </p>
            )}
            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => patch({ step: 2 })}>
                <ChevronLeft className="size-4" aria-hidden /> Back
              </Button>
              <Button onClick={() => void submit()} disabled={st.submitting} className="bg-[#6A00F4] px-6 hover:bg-[#5a00d1]">
                {st.submitting ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
                Submit report
              </Button>
            </div>
          </div>

          <div>
            <div className="relative aspect-[4/3] overflow-hidden rounded-2xl border border-border bg-muted/40">
              {st.previewUrl && (
                <>
                  <img src={st.previewUrl} alt="Final preview" className="h-full w-full object-cover" />
                  <BboxOverlay detections={detections} />
                </>
              )}
            </div>
            <div className="mt-4 rounded-xl border border-border bg-card p-4 text-sm">
              <p className="font-semibold">What happens next</p>
              <ol className="mt-2 list-decimal space-y-1.5 pl-4 text-xs leading-relaxed text-muted-foreground">
                <li>Your report enters the review queue with its AI detections and priority estimate.</li>
                <li>It appears on the live map instantly at the exact coordinates you pinned, with the evidence photo attached.</li>
                <li>As duplicates arrive nearby, clustering groups them and the priority score sharpens automatically.</li>
              </ol>
            </div>
          </div>
        </div>
      )}

      {/* -------- possible existing hazard — duplicate decision -------- */}
      <Dialog open={Boolean(st.dupCandidates)} onOpenChange={(o) => !o && patch({ dupCandidates: null })}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-display text-2xl">
              <span className="flex size-9 items-center justify-center rounded-full bg-[#D97706]/15 text-[#B45309]">
                <GitMerge className="size-5" aria-hidden />
              </span>
              Possible existing hazard
            </DialogTitle>
            <DialogDescription>
              This report appears similar to an existing hazard nearby. Nothing has been submitted yet — choose how to proceed.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            {(st.dupCandidates ?? []).map((c) => (
              <div key={c.hazardId} className="flex items-center justify-between gap-3 rounded-xl border border-border p-3">
                <div className="min-w-0">
                  <p className="font-mono text-xs font-semibold text-[#6A00F4]">#{c.referenceCode}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {c.distanceM} m away · {c.similarityPct}% similar
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-display text-lg font-bold text-[#B45309]">{c.similarityPct}%</p>
                  <p className="text-[10px] text-muted-foreground">location {c.locationSimilarityPct}% · type {c.classSimilarityPct}%{c.imageSimilarityPct != null ? ` · photo ${c.imageSimilarityPct}%` : ""}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="grid gap-2">
            <Button
              className="bg-[#168266] hover:bg-[#0f5c49]"
              disabled={st.submitting}
              onClick={() => {
                const target = st.dupCandidates?.[0];
                patch({ dupCandidates: null });
                void submit({ mergeIntoId: target?.hazardId });
              }}
            >
              <GitMerge className="size-4" aria-hidden /> Merge with existing hazard
            </Button>
            <Button variant="outline" className="border-border" disabled={st.submitting} onClick={() => { patch({ dupCandidates: null }); useApp.getState().setView("map"); }}>
              <Eye className="size-4" aria-hidden /> View existing hazard on the map
            </Button>
            <Button variant="outline" className="border-border" disabled={st.submitting} onClick={() => { patch({ dupCandidates: null }); void submit({ forceNew: true }); }}>
              <CopyPlus className="size-4" aria-hidden /> Create new hazard anyway
            </Button>
          </div>
          <p className="text-center text-[11px] text-muted-foreground">
            Merging keeps one map pin per real-world hazard — 12 reports ≠ 12 potholes. Your evidence still counts.
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
