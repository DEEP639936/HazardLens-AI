"use client";
// Brand kit — HazardLensAI logo (mark + wordmark) used across every surface.
// The mark is the generated lens-over-road emblem; the wordmark is typographic
// so it stays crisp at any size.
import { cn } from "@/lib/utils";

export const BRAND_NAME = "HazardLensAI";
export const BRAND_TAGLINE = "See the road. Prioritize the repair.";

/** The emblem. Renders as a rounded app-icon tile so it sits cleanly on any surface. */
export function BrandMark({ className, compact = false }: { className?: string; compact?: boolean }) {
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white shadow-sm ring-1 ring-black/5",
        className
      )}
      aria-hidden
    >
      <img src="/brand/logo.png" alt="" className={cn("size-full object-cover", compact && "rounded-lg")} draggable={false} />
    </span>
  );
}

/** "HazardLens" + violet "AI" — typographic wordmark. */
export function BrandWordmark({ className, light = false }: { className?: string; light?: boolean }) {
  return (
    <span className={cn("leading-none", className)}>
      <span className={cn("block font-display text-lg font-semibold tracking-tight", light ? "text-white" : "text-foreground")}>
        HazardLens<span className="text-[#6A00F4]">AI</span>
      </span>
      <span className={cn("block text-[9px] font-bold uppercase tracking-[0.3em]", light ? "text-white/60" : "text-muted-foreground")}>
        Road intelligence
      </span>
    </span>
  );
}

/** Compact one-line wordmark for tight headers. */
export function BrandWordmarkInline({ className, light = false }: { className?: string; light?: boolean }) {
  return (
    <span className={cn("whitespace-nowrap font-display text-lg font-semibold tracking-tight", light ? "text-white" : "text-foreground")}>
      HazardLens<span className="text-[#6A00F4]">AI</span>
    </span>
  );
}
