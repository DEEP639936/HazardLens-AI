"use client";
// Shared presentational atoms: badges, severity dots, priority gauge, empty states, skeletons.
import { cn } from "@/lib/utils";
import { BAND_META, CLASS_META, STATUS_META, WO_STATUS_META } from "@/lib/rg/constants";
import type { HazardClass, PriorityBand, PriorityDTO, ReportStatus, WorkOrderStatus } from "@/lib/rg/types";
import { Skeleton } from "@/components/ui/skeleton";
import { Inbox } from "lucide-react";
import { motion, useInView, useMotionValue, useSpring } from "framer-motion";
import { useEffect, useRef, useSyncExternalStore } from "react";

/** Respect prefers-reduced-motion (hydration-safe, reactive). */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false
  );
}

export function ClassChip({ cls, size = "sm" }: { cls: HazardClass; size?: "sm" | "md" }) {
  const meta = CLASS_META[cls];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border font-medium",
        meta.chip,
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm"
      )}
    >
      <span className="size-1.5 rounded-full" style={{ background: meta.color }} />
      {meta.label}
    </span>
  );
}

export function BandBadge({ band }: { band: PriorityBand }) {
  const meta = BAND_META[band];
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold tracking-wide", meta.chip)}>
      {meta.label.toUpperCase()}
    </span>
  );
}

export function StatusChip({ status }: { status: ReportStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium", meta.chip)}>{meta.label}</span>
  );
}

export function WoStatusChip({ status }: { status: WorkOrderStatus }) {
  const meta = WO_STATUS_META[status];
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", meta.chip)}>{meta.label}</span>
  );
}

export function SeverityDots({ severity, className }: { severity: number; className?: string }) {
  const color = severity >= 4 ? "#C83E4D" : severity === 3 ? "#D97706" : "#168266";
  return (
    <span className={cn("inline-flex items-center gap-1", className)} aria-label={`Severity ${severity} of 5`}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span
          key={i}
          className="size-1.5 rounded-full"
          style={{ background: i <= severity ? color : "#E8E2EF" }}
        />
      ))}
      <span className="ml-1 text-xs font-semibold tabular-nums" style={{ color }}>
        {severity}/5
      </span>
    </span>
  );
}

export function PriorityGauge({ priority, size = 96 }: { priority: PriorityDTO | null; size?: number }) {
  const score = priority?.score ?? 0;
  const band = priority?.band ?? "LOW";
  const color = BAND_META[band].color;
  const r = (size - 12) / 2;
  const circ = Math.PI * r; // half circle
  const filled = (Math.min(100, Math.max(0, score)) / 100) * circ;
  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size * 0.62} viewBox={`0 0 ${size} ${size * 0.62}`} role="img" aria-label={`Priority score ${Math.round(score)}`}>
        <path d={`M 6 ${size * 0.55} A ${r} ${r} 0 0 1 ${size - 6} ${size * 0.55}`} fill="none" stroke="#E8E2EF" strokeWidth={9} strokeLinecap="round" />
        <motion.path
          d={`M 6 ${size * 0.55} A ${r} ${r} 0 0 1 ${size - 6} ${size * 0.55}`}
          fill="none"
          stroke={color}
          strokeWidth={9}
          strokeLinecap="round"
          initial={{ strokeDasharray: `0 ${circ}` }}
          whileInView={{ strokeDasharray: `${filled} ${circ}` }}
          viewport={{ once: true }}
          transition={{ duration: 1.1, ease: "easeOut" }}
        />
        <text x="50%" y={size * 0.5} textAnchor="middle" className="fill-foreground font-semibold" style={{ fontSize: size * 0.24 }}>
          {Math.round(score)}
        </text>
      </svg>
      <BandBadge band={band} />
    </div>
  );
}

export function EmptyState({ title, hint, icon }: { title: string; hint?: string; icon?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card/60 px-6 py-12 text-center">
      <div className="rounded-full bg-secondary p-3 text-[#6A00F4]">{icon ?? <Inbox className="size-5" aria-hidden />}</div>
      <p className="font-medium text-foreground">{title}</p>
      {hint ? <p className="max-w-sm text-sm text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("space-y-3 rounded-xl border border-border bg-card p-5", className)}>
      <Skeleton className="h-4 w-1/3" />
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className="h-3 w-full" />
      ))}
    </div>
  );
}

export function CountUp({ to, suffix = "", decimals = 0, duration = 1.4 }: { to: number; suffix?: string; decimals?: number; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, margin: "-40px" });
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { duration: duration * 1000, bounce: 0 });
  useEffect(() => {
    if (inView) mv.set(to);
  }, [inView, mv, to]);
  useEffect(() => {
    const unsub = spring.on("change", (v) => {
      if (ref.current) ref.current.textContent = `${v.toFixed(decimals)}${suffix}`;
    });
    return unsub;
  }, [spring, decimals, suffix]);
  return <span ref={ref}>0{suffix}</span>;
}

export function SectionHeading({ eyebrow, title, lead, align = "left" }: { eyebrow: string; title: string; lead?: string; align?: "left" | "center" }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      className={cn("max-w-2xl", align === "center" && "mx-auto text-center")}
    >
      <p className="mb-3 text-xs font-bold uppercase tracking-[0.22em] text-[#6A00F4]">{eyebrow}</p>
      <h2 className="font-display text-3xl leading-tight text-foreground sm:text-4xl">{title}</h2>
      {lead ? <p className="mt-4 text-base leading-relaxed text-muted-foreground">{lead}</p> : null}
    </motion.div>
  );
}
