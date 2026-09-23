"use client";
// Authentication — editorial split-screen: live detection showcase (road-damage photography with
// animated bounding boxes) beside a focused, accessible auth form. Sign-in / sign-up / reset.
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { motion } from "framer-motion";
import { api } from "@/lib/rg/api";
import { useApp } from "@/lib/rg/store";
import { DEMO_ACCOUNTS } from "@/lib/rg/constants";
import type { SessionUser } from "@/lib/rg/types";
import { BboxOverlay } from "@/components/rg/media";
import { BrandMark, BrandWordmarkInline } from "@/components/rg/brand";
import { usePrefersReducedMotion } from "@/components/rg/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ShieldCheck,
  Loader2,
  KeyRound,
  ArrowLeft,
  ScanSearch,
  MapPin,
  Radar,
  TriangleAlert,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { BboxDTO } from "@/lib/rg/types";

type Mode = "signin" | "signup" | "reset";

/* ---------------- visual showcase (left panel) ---------------- */

const SHOWCASE = [
  {
    src: "/demo/pothole-3.jpg",
    alt: "Large pothole on an asphalt road",
    tag: "Pothole · detected 97%",
    boxes: [
      { hazardClass: "pothole", confidence: 0.97, bbox: [0.03, 0.3, 0.82, 0.66], severity: 5, areaRatio: 0.28 } as BboxDTO,
      { hazardClass: "erosion", confidence: 0.81, bbox: [0.4, 0.03, 0.35, 0.11], severity: 3, areaRatio: 0.017 } as BboxDTO,
    ],
  },
  {
    src: "/demo/pothole-2.jpg",
    alt: "Pothole filled with water beside a yellow lane marking",
    tag: "Pothole · detected 94%",
    boxes: [
      { hazardClass: "pothole", confidence: 0.94, bbox: [0.26, 0.32, 0.5, 0.55], severity: 4, areaRatio: 0.14 } as BboxDTO,
      { hazardClass: "marking", confidence: 0.86, bbox: [0.02, 0.02, 0.94, 0.24], severity: 2, areaRatio: 0.05 } as BboxDTO,
    ],
  },
  {
    src: "/demo/crack-1.jpg",
    alt: "Cracked asphalt with yellow and white lane marking",
    tag: "Cracks · detected 91%",
    boxes: [
      { hazardClass: "crack", confidence: 0.91, bbox: [0.02, 0.05, 0.96, 0.9], severity: 3, areaRatio: 0.3 } as BboxDTO,
      { hazardClass: "marking", confidence: 0.88, bbox: [0.08, 0.3, 0.84, 0.42], severity: 2, areaRatio: 0.08 } as BboxDTO,
    ],
  },
];

function ShowcasePanel() {
  const [index, setIndex] = useState(0);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % SHOWCASE.length), 4600);
    return () => clearInterval(t);
  }, [reduced]);

  const slide = SHOWCASE[index % SHOWCASE.length];

  return (
    <div className="relative hidden overflow-hidden bg-[#1C1530] lg:flex lg:flex-col">
      {/* rotating road-damage imagery with animated detection boxes */}
      <div className="absolute inset-0">
        {SHOWCASE.map((s, i) => (
          <motion.img
            key={s.src}
            src={s.src}
            alt={i === index % SHOWCASE.length ? s.alt : ""}
            aria-hidden={i !== index % SHOWCASE.length}
            initial={false}
            animate={{ opacity: i === index % SHOWCASE.length ? 1 : 0, scale: i === index % SHOWCASE.length ? 1 : 1.05 }}
            transition={{ duration: 1.1, ease: "easeInOut" }}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ))}
        <div className="absolute inset-0 bg-gradient-to-t from-[#1C1530] via-[#1C1530]/55 to-[#1C1530]/25" />
      </div>
      <div className="relative inset-0">
        <BboxOverlay detections={slide.boxes} animate />
      </div>

      {/* live-scan chrome */}
      <div className="relative flex h-full flex-col justify-between p-10 xl:p-14">
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-2 rounded-full bg-white/10 px-3.5 py-1.5 text-xs font-semibold text-white backdrop-blur">
            <span className="relative flex size-2">
              {!reduced && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#7CFFCB] opacity-70" />}
              <span className="relative inline-flex size-2 rounded-full bg-[#7CFFCB]" />
            </span>
            Detection engine live
          </span>
          <span className="rounded-full bg-white/10 px-3.5 py-1.5 text-xs font-medium text-white/80 backdrop-blur">
            {slide.tag}
          </span>
        </div>

        <div className="max-w-md">
          <motion.blockquote
            key={index}
            initial={reduced ? false : { opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
          >
            <p className="font-display text-3xl leading-snug text-white xl:text-4xl">
              “Every box you see is a road we know about — located, classified and queued for repair.”
            </p>
          </motion.blockquote>
          <div className="mt-8 grid grid-cols-3 gap-3">
            {[
              { icon: ScanSearch, k: "7", l: "hazard classes" },
              { icon: MapPin, k: "60 m", l: "cluster radius" },
              { icon: Radar, k: "0–100", l: "priority scale" },
            ].map((s) => (
              <div key={s.l} className="rounded-xl border border-white/15 bg-white/[0.07] p-3.5 backdrop-blur">
                <s.icon className="size-4 text-[#FFD6A5]" aria-hidden />
                <p className="mt-2 font-display text-xl font-semibold text-white">{s.k}</p>
                <p className="text-[11px] text-white/65">{s.l}</p>
              </div>
            ))}
          </div>
          <p className="mt-6 flex items-start gap-2 text-[11px] leading-relaxed text-white/55">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Illustrative demo imagery. The production pipeline strips EXIF metadata and only reads GPS with your explicit consent.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ---------------- auth form ---------------- */

export function AuthView({ initialMode = "signin" }: { initialMode?: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const { loadSession, setView } = useApp();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", password2: "", token: "", resetToken: "" });
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const afterAuth = async (role: string) => {
    await loadSession();
    toast.success(role === "ADMIN" ? "Welcome back, Administrator" : "Welcome to HazardLensAI");
    // Every member lands on their role-shaped dashboard: citizens get the civic
    // toolkit, administrators get the ops desk with Work Management.
    setView("home");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "signin") {
        const res = await api<{ user: SessionUser }>("/api/auth/login", { json: { email: form.email, password: form.password } });
        await afterAuth(res.user.role);
      } else if (mode === "signup") {
        if (form.password !== form.password2) throw new Error("Passwords do not match");
        const res = await api<{ user: SessionUser }>("/api/auth/register", { json: { email: form.email, password: form.password, name: form.name } });
        await afterAuth(res.user.role);
      } else {
        if (!form.resetToken) {
          // step 1: request token
          const res = await fetch("/api/auth/forgot-password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: form.email }),
          });
          const token = res.headers.get("x-demo-reset-token");
          const body = (await res.json()) as { message?: string };
          if (token) {
            setForm((f) => ({ ...f, resetToken: token }));
            toast.info("Demo reset token issued below", { description: "No SMTP in this deployment — use the token to set a new password." });
          } else {
            toast.success(body.message ?? "If the account exists, a reset was issued.");
          }
        } else {
          if (form.password !== form.password2) throw new Error("Passwords do not match");
          await api("/api/auth/reset-password", { json: { token: form.resetToken, password: form.password } });
          toast.success("Password updated — sign in with it now");
          setMode("signin");
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  };

  const fillDemo = (which: "admin" | "user") => {
    setMode("signin");
    const acc = DEMO_ACCOUNTS[which];
    setForm((f) => ({ ...f, email: acc.email, password: acc.password }));
  };

  return (
    <div className="paper-texture flex min-h-[calc(100vh-4rem)] items-stretch">
      <div className="mx-auto grid w-full max-w-none lg:grid-cols-[1.15fr_1fr]">
        <ShowcasePanel />

        {/* form column */}
        <div className="flex items-center justify-center px-4 py-12 sm:px-8">
          <div className="w-full max-w-md">
            {/* compact image banner for mobile — keeps the pothole identity on small screens */}
            <div className="relative mb-8 overflow-hidden rounded-2xl border border-border lg:hidden">
              <img src="/demo/pothole-2.jpg" alt="Pothole beside a road marking, detected by HazardLensAI" className="h-36 w-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-[#1C1530]/85 via-transparent" />
              <BboxOverlay detections={SHOWCASE[1].boxes} animate />
              <span className="absolute bottom-3 left-3 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-[11px] font-semibold text-white backdrop-blur">
                <ShieldCheck className="size-3.5" aria-hidden /> Detection engine live
              </span>
            </div>

            <div className="rounded-2xl border border-border bg-card p-8 shadow-[0_24px_64px_-28px_rgba(28,21,48,0.35)]">
              <div className="flex items-center gap-3">
                <BrandMark className="size-11" />
                <BrandWordmarkInline />
              </div>
              <h1 className="mt-5 font-display text-3xl">
                {mode === "signin" ? "Sign in" : mode === "signup" ? "Create your account" : "Reset your password"}
              </h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {mode === "signin" && "Access your reports, notifications and review tools."}
                {mode === "signup" && "Track every hazard you report, end to end."}
                {mode === "reset" && (form.resetToken ? "Token received — choose a new password." : "We will verify your email and issue a reset.")}
              </p>

              <form onSubmit={submit} className="mt-7 space-y-4">
                {mode === "signup" && (
                  <div>
                    <Label htmlFor="name">Full name</Label>
                    <Input id="name" className="mt-1.5" required minLength={2} value={form.name} onChange={set("name")} autoComplete="name" />
                  </div>
                )}
                {!(mode === "reset" && form.resetToken) && (
                  <div>
                    <Label htmlFor="email">Email</Label>
                    <Input id="email" type="email" className="mt-1.5" required value={form.email} onChange={set("email")} autoComplete="email" />
                  </div>
                )}
                {mode === "reset" && form.resetToken && (
                  <div>
                    <Label htmlFor="token">Reset token</Label>
                    <Input id="token" className="mt-1.5 font-mono text-xs" required value={form.resetToken} onChange={set("resetToken")} />
                  </div>
                )}
                {mode !== "reset" && (
                  <div>
                    <Label htmlFor="password">Password</Label>
                    <Input id="password" type="password" className="mt-1.5" required minLength={8} value={form.password} onChange={set("password")} autoComplete={mode === "signin" ? "current-password" : "new-password"} />
                  </div>
                )}
                {mode !== "signin" && (
                  <div>
                    <Label htmlFor="password2">{mode === "reset" && form.resetToken ? "New password (repeat)" : "Repeat password"}</Label>
                    <Input id="password2" type="password" className="mt-1.5" required minLength={8} value={form.password2} onChange={set("password2")} autoComplete="new-password" />
                  </div>
                )}
                <Button type="submit" disabled={busy} className="w-full bg-[#6A00F4] hover:bg-[#5a00d1]">
                  {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                  {mode === "signin" && "Sign in"}
                  {mode === "signup" && "Create account"}
                  {mode === "reset" && (form.resetToken ? "Set new password" : "Issue reset")}
                </Button>
              </form>

              <div className="mt-5 flex items-center justify-between text-sm">
                {mode === "signin" ? (
                  <>
                    <button className="inline-flex items-center gap-1 text-muted-foreground hover:text-[#6A00F4]" onClick={() => setMode("reset")}>
                      <KeyRound className="size-3.5" aria-hidden /> Forgot password?
                    </button>
                    <button className="font-medium text-[#6A00F4] hover:underline" onClick={() => setMode("signup")}>
                      Create an account
                    </button>
                  </>
                ) : (
                  <button className="inline-flex items-center gap-1 text-muted-foreground hover:text-[#6A00F4]" onClick={() => setMode("signin")}>
                    <ArrowLeft className="size-3.5" aria-hidden /> Back to sign in
                  </button>
                )}
              </div>
            </div>

            {mode === "signin" && (
              <div className="mt-4 rounded-xl border border-border bg-card/70 p-4">
                <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Evaluation demo accounts</p>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" className="border-border text-xs" onClick={() => fillDemo("admin")}>
                    Fill administrator
                  </Button>
                  <Button size="sm" variant="outline" className="border-border text-xs" onClick={() => fillDemo("user")}>
                    Fill citizen
                  </Button>
                </div>
              </div>
            )}

            <p className={cn("mt-6 text-center text-xs text-muted-foreground")}>
              Protected by rate limiting, audited sessions and role-based access control.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
