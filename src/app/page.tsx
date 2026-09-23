"use client";
// HazardLensAI — single-route application with a hard member gate and role separation.
//
//   Public website (signed out) : marketing landing + sign-in / sign-up / reset pages.
//   Members (signed in)         : role-shaped workspace —
//     CITIZEN       : dashboard, live map, AI detection, reporting, alerts, docs, my reports
//     FIELD_WORKER  : citizen surfaces + own work-order assignments
//     AUTHORITY     : + hazard queue (verify/merge/escalate), work orders, analytics
//     ADMIN         : + administration console (users, risk rules, org, audit)
//
// View routing is hash-based (#/map, #/report, …) so every surface stays deep-linkable;
// the access-control effect bounces unauthorized deep links to a safe page.
import { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { LockKeyhole, Loader2 } from "lucide-react";
import { AppShell } from "@/components/rg/shell";
import { PublicShell } from "@/components/rg/public-shell";
import { Landing } from "@/components/rg/landing";
import { Dashboard } from "@/components/rg/dashboard";
import { MapView } from "@/components/rg/map-view";
import { DetectStudio } from "@/components/rg/detect";
import { ReportWizard } from "@/components/rg/report";
import { DocsView } from "@/components/rg/docs-view";
import { AuthView } from "@/components/rg/auth";
import { UserDashboard } from "@/components/rg/user-dashboard";
import { WorkOrders } from "@/components/rg/work";
import { ResolutionVerification } from "@/components/rg/verify";
import { HazardQueue } from "@/components/rg/queue";
import { HazardAlerts } from "@/components/rg/alerts";
import { AnalyticsView } from "@/components/rg/analytics";
import { AdminPanel } from "@/components/rg/admin";
import { BrandMark, BrandWordmarkInline } from "@/components/rg/brand";
import { Button } from "@/components/ui/button";
import {
  ADMIN_ONLY_VIEWS,
  initHashRouting,
  isAuthView,
  isProtectedView,
  isViewAllowedForRole,
  useApp,
  VIEW_LABELS,
  viewFromHash,
  type View,
} from "@/lib/rg/store";

function Splash({ label = "Preparing your workspace…" }: { label?: string }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-background px-4">
      <BrandMark className="size-14 shadow-[0_16px_40px_-12px_rgba(106,0,244,0.6)]" />
      <BrandWordmarkInline />
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> {label}
      </p>
    </div>
  );
}

/* Rendered for a blink while the guard effect redirects an unauthorized deep link
   (e.g. #/detect signed-out) to the sign-in page. Doubles as a manual fallback. */
function AccessGate({ view }: { view: View }) {
  const setView = useApp((s) => s.setView);
  return (
    <PublicShell>
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-[#6A00F4]/10 text-[#6A00F4]">
          <LockKeyhole className="size-6" aria-hidden />
        </div>
        <h1 className="mt-5 font-display text-3xl">Members only</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {VIEW_LABELS[view] ? `Sign in to open ${VIEW_LABELS[view]} — taking you there…` : "Sign in to continue."}
        </p>
        <div className="mt-7 flex justify-center gap-3">
          <Button className="bg-[#6A00F4] hover:bg-[#5a00d1]" onClick={() => setView("signin")}>
            Go to sign in
          </Button>
          <Button variant="outline" className="border-border" onClick={() => setView("signup")}>
            Create account
          </Button>
        </div>
      </div>
    </PublicShell>
  );
}

export default function Home() {
  const { view, loadSession, user, sessionLoading, setView } = useApp();
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
      })
  );

  useEffect(() => {
    // honor deep links before the first render settles
    useApp.setState({ view: viewFromHash() });
    void loadSession();
    return initHashRouting();
  }, [loadSession]);

  /* ---------------- access control ---------------- */
  useEffect(() => {
    if (sessionLoading) return;
    if (!user) {
      // Visitor: only the marketing site and auth pages are open.
      if (isProtectedView(view)) {
        toast.info("Members only", { description: `Sign in to open ${VIEW_LABELS[view]}.` });
        setView("signin");
      }
    } else if (isAuthView(view)) {
      // Signed-in members don't need auth screens.
      setView("home");
    } else if (!isViewAllowedForRole(view, user.role)) {
      const hint =
        view === "verify"
          ? "Resolution verification is reserved for the main administrator account."
          : ADMIN_ONLY_VIEWS.includes(view) && user.role !== "ADMIN"
            ? "The administration console is restricted to administrator accounts."
            : view === "work"
              ? "Work orders are limited to field workers and management roles."
              : "This management surface requires an authority or administrator account.";
      toast.error("Restricted area", { description: hint });
      setView("home");
    }
  }, [view, user, sessionLoading, setView]);

  /* ---------------- render ---------------- */
  let content: React.ReactNode;

  if (sessionLoading) {
    content = <Splash />;
  } else if (!user) {
    // ------- PUBLIC WEBSITE -------
    if (view === "home") {
      content = (
        <PublicShell>
          <Landing />
        </PublicShell>
      );
    } else if (isAuthView(view)) {
      content = (
        <PublicShell variant="auth">
          <AuthView
            key={view}
            initialMode={view === "signup" ? "signup" : view === "reset" ? "reset" : "signin"}
          />
        </PublicShell>
      );
    } else {
      content = <AccessGate view={view} />;
    }
  } else {
    // ------- MEMBERS-ONLY APP -------
    if (isAuthView(view)) {
      content = <Splash label="Loading your workspace…" />;
    } else {
      content = (
        <AppShell>
          {view === "home" && <Dashboard />}
          {view === "map" && <MapView />}
          {view === "detect" && <DetectStudio />}
          {view === "report" && <ReportWizard />}
          {view === "alerts" && <HazardAlerts />}
          {view === "queue" && <HazardQueue />}
          {view === "work" && <WorkOrders />}
          {view === "verify" && <ResolutionVerification />}
          {view === "analytics" && <AnalyticsView />}
          {view === "admin" && <AdminPanel />}
          {view === "docs" && <DocsView />}
          {view === "dashboard" && <UserDashboard />}
        </AppShell>
      );
    }
  }

  return <QueryClientProvider client={queryClient}>{content}</QueryClientProvider>;
}
