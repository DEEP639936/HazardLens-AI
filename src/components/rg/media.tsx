"use client";
// Media rendering with AI bounding-box overlay (animated scan treatment for landing preview).
import { cn } from "@/lib/utils";
import { mediaUrl } from "@/lib/rg/api";
import { CLASS_META } from "@/lib/rg/constants";
import type { BboxDTO } from "@/lib/rg/types";
import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "@/components/rg/primitives";

function severityColor(sev: number): string {
  if (sev >= 4) return "#C83E4D";
  if (sev === 3) return "#D97706";
  return "#168266";
}

export function BboxOverlay({
  detections,
  active = true,
  animate = false,
  className,
}: {
  detections: BboxDTO[];
  active?: boolean;
  animate?: boolean;
  className?: string;
}) {
  if (!active || detections.length === 0) return null;
  return (
    <div className={cn("pointer-events-none absolute inset-0", className)} aria-hidden>
      {detections.map((d, i) => {
        const [x, y, w, h] = d.bbox;
        const color = severityColor(d.severity);
        return (
          <div
            key={`${d.id ?? i}-${d.hazardClass}`}
            className={cn("absolute rounded-[4px]", animate && "rg-bbox")}
            style={{
              left: `${x * 100}%`,
              top: `${y * 100}%`,
              width: `${w * 100}%`,
              height: `${h * 100}%`,
              border: `2px solid ${color}`,
              background: `${color}1f`,
              animationDelay: animate ? `${i * 0.28}s` : undefined,
            }}
          >
            <span
              className="absolute -top-[22px] left-0 whitespace-nowrap rounded-[3px] px-1.5 py-0.5 text-[10px] font-semibold text-white shadow"
              style={{ background: color }}
            >
              {CLASS_META[d.hazardClass]?.short ?? d.hazardClass} · {(d.confidence * 100).toFixed(0)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function MediaFrame({
  mediaId,
  alt,
  detections,
  showBoxes = true,
  animate = false,
  className,
  imgClassName,
}: {
  mediaId?: string | null;
  alt: string;
  detections?: BboxDTO[];
  showBoxes?: boolean;
  animate?: boolean;
  className?: string;
  imgClassName?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!mediaId || failed) {
    return (
      <div className={cn("flex items-center justify-center rounded-xl border border-dashed border-border bg-muted/50 text-xs text-muted-foreground", className)}>
        {mediaId && failed ? "Media unavailable" : "No media attached"}
      </div>
    );
  }
  return (
    <div className={cn("relative overflow-hidden rounded-xl border border-border bg-muted/30", className)}>
      <img
        src={mediaUrl(mediaId)}
        alt={alt}
        className={cn("h-full w-full object-cover", imgClassName)}
        loading="lazy"
        onError={() => setFailed(true)}
      />
      <BboxOverlay detections={detections ?? []} active={showBoxes} animate={animate} />
    </div>
  );
}

/** Rotating scan effect used on the landing hero: cycles detection sets over a static image. */
export function ScanPreview({ imageSrc, detectionSets, className }: { imageSrc: string; detectionSets: BboxDTO[][]; className?: string }) {
  const [index, setIndex] = useState(0);
  const reduced = usePrefersReducedMotion();
  useEffect(() => {
    if (reduced || detectionSets.length <= 1) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % detectionSets.length), 4200);
    return () => clearInterval(t);
  }, [reduced, detectionSets.length]);
  return (
    <div className={cn("relative overflow-hidden", className)}>
      <img src={imageSrc} alt="Live road hazard detection preview" className="h-full w-full object-cover" />
      {!reduced && <div className="rg-scanline" />}
      <BboxOverlay detections={detectionSets[index % detectionSets.length]} animate />
    </div>
  );
}
