"use client";
// AppShell — vertical left sidebar navigation (collapsible on desktop, drawer on mobile)
// + slim top bar. Navigation is role-scoped:
//   EXPLORE     — Dashboard, Live Map, AI Detection, Report Hazard, Hazard Alerts
//   MANAGEMENT  — Hazard Queue, Work Orders, Analytics (AUTHORITY/ADMIN; Work Orders also FIELD_WORKER)
//   WORKSPACE   — My Reports
//   INFORMATION — Documentation
//   ADMIN       — Resolution Verification + Administration (ADMIN only)
import { cn } from "@/lib/utils";
import { useApp, isViewAllowedForRole, type View } from "@/lib/rg/store";
import type { Role } from "@/lib/rg/types";
import { api } from "@/lib/rg/api";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  BadgeCheck,
  Bell,
  BookOpen,
  ChevronLeft,
  ClipboardList,
  LayoutDashboard,
  Map as MapIcon,
  Menu,
  PanelLeft,
  PencilLine,
  ScanSearch,
  Settings2,
  ShieldCheck,
  Siren,
  BarChart3,
  HardHat,
} from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { BrandMark, BrandWordmark } from "@/components/rg/brand";

type NavItem = { view: View; label: string; icon: typeof Bell; badge?: number };

const NAV_EXPLORE: NavItem[] = [
  { view: "home", label: "Dashboard", icon: LayoutDashboard },
  { view: "map", label: "Live Map", icon: MapIcon },
  { view: "detect", label: "AI Detection", icon: ScanSearch },
  { view: "report", label: "Report Hazard", icon: PencilLine },
  { view: "alerts", label: "Hazard Alerts", icon: Siren },
];

const NAV_MANAGEMENT: NavItem[] = [
  { view: "queue", label: "Hazard Queue", icon: ShieldCheck },
  { view: "work", label: "Work Orders", icon: ClipboardList },
  { view: "analytics", label: "Analytics", icon: BarChart3 },
];

const NAV_WORKSPACE: NavItem[] = [{ view: "dashboard", label: "My Reports", icon: ClipboardList }];

const NAV_INFO: NavItem[] = [{ view: "docs", label: "Documentation", icon: BookOpen }];

const NAV_ADMIN: NavItem[] = [
  { view: "verify", label: "Verification", icon: BadgeCheck },
  { view: "admin", label: "Administration", icon: Settings2 },
];

const PAGE_TITLES: Partial<Record<View, string>> = {
  home: "Dashboard",
  map: "Live hazard map",
  detect: "AI detection",
  report: "Report a hazard",
  alerts: "Hazard alerts",
  queue: "Hazard queue",
  work: "Work orders",
  verify: "Resolution verification",
  analytics: "Analytics",
  admin: "Administration",
  docs: "Documentation",
  signin: "Sign in",
  signup: "Create account",
  reset: "Reset password",
  dashboard: "My Reports",
};

export function roleLabel(role: Role): string {
  switch (role) {
    case "ADMIN":
      return "Administrator";
    case "AUTHORITY":
      return "Authority";
    case "FIELD_WORKER":
      return "Field worker";
    default:
      return "Citizen";
  }
}

function NavSection({
  heading,
  items,
  view,
  collapsed,
  onNavigate,
}: {
  heading?: string;
  items: NavItem[];
  view: View;
  collapsed: boolean;
  onNavigate: (v: View) => void;
}) {
  if (items.length === 0) return null;
  return (
    <>
      {heading && !collapsed && (
        <p className="px-3 pb-1 pt-3 text-[10px] font-bold uppercase tracking-[0.22em] text-muted-foreground/70">{heading}</p>
      )}
      {items.map((item) => (
        <NavLink key={item.view} item={item} active={view === item.view} collapsed={collapsed} onNavigate={onNavigate} />
      ))}
    </>
  );
}

function NavLink({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate: (v: View) => void;
}) {
  const Icon = item.icon;
  const content = (
    <button
      onClick={() => onNavigate(item.view)}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all",
        active
          ? "bg-[#6A00F4] text-white shadow-[0_8px_20px_-8px_rgba(106,0,244,0.55)]"
          : "text-muted-foreground hover:bg-secondary hover:text-foreground",
        collapsed && "justify-center px-0"
      )}
    >
      <Icon className={cn("size-[18px] shrink-0", active ? "text-white" : "text-[#6A00F4] group-hover:scale-110 transition-transform")} aria-hidden />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {!collapsed && Boolean(item.badge) && item.badge! > 0 && (
        <span
          className={cn(
            "ml-auto flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-[10px] font-bold",
            active ? "bg-white/90 text-[#6A00F4]" : "bg-[#B45309] text-white"
          )}
        >
          {item.badge! > 9 ? "9+" : item.badge}
        </span>
      )}
      {collapsed && Boolean(item.badge) && item.badge! > 0 && (
        <span className="absolute right-2 top-1.5 flex size-2 rounded-full bg-[#B45309]" aria-hidden />
      )}
      {!collapsed && active && !item.badge && <span className="ml-auto size-1.5 rounded-full bg-white/90" aria-hidden />}
    </button>
  );
  if (!collapsed) return content;
  return (
    <TooltipProvider delayDuration={120}>
      <Tooltip>
        <TooltipTrigger asChild>{content}</TooltipTrigger>
        <TooltipContent side="right" className="text-xs">
          {item.label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function SidebarBody({ collapsed, onNavigate }: { collapsed: boolean; onNavigate: (v: View) => void }) {
  const { view, user } = useApp();
  const role = user?.role ?? "CITIZEN";
  const management = NAV_MANAGEMENT.filter((i) => isViewAllowedForRole(i.view, role));

  /* Pending-resolution badge for the administrator's Verification nav item. */
  const verifyQ = useQuery({
    queryKey: ["verify-nav-count"],
    queryFn: () => api<{ items: { status: string }[] }>("/api/work-orders"),
    enabled: role === "ADMIN",
    staleTime: 20_000,
    select: (d) => d.items.filter((o) => o.status === "VERIFICATION_PENDING").length,
  });
  const navAdmin = NAV_ADMIN.map((i) => (i.view === "verify" ? { ...i, badge: verifyQ.data ?? 0 } : i));

  return (
    <nav aria-label="Primary" className={cn("flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-2")}>
      <NavSection heading="Explore" items={NAV_EXPLORE} view={view} collapsed={collapsed} onNavigate={onNavigate} />

      {management.length > 0 && (
        <>
          <div className="my-3 h-px bg-border" aria-hidden />
          <NavSection heading="Management" items={management} view={view} collapsed={collapsed} onNavigate={onNavigate} />
        </>
      )}

      <div className="my-3 h-px bg-border" aria-hidden />
      <NavSection heading="Workspace" items={NAV_WORKSPACE} view={view} collapsed={collapsed} onNavigate={onNavigate} />
      <NavSection heading="Information" items={NAV_INFO} view={view} collapsed={collapsed} onNavigate={onNavigate} />

      {role === "ADMIN" && (
        <>
          <div className="my-3 h-px bg-border" aria-hidden />
          <NavSection heading="Administrator" items={navAdmin} view={view} collapsed={collapsed} onNavigate={onNavigate} />
        </>
      )}

      {!collapsed && (
        <div className="mt-auto space-y-3 pb-2 pt-4">
          {role === "FIELD_WORKER" ? (
            <div className="rounded-xl border border-[#6A00F4]/20 bg-[#6A00F4]/[0.05] p-3.5">
              <p className="text-xs font-semibold text-foreground">Field workspace</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Start assigned repairs, upload before/after evidence and submit for verification.
              </p>
              <Button size="sm" className="mt-2.5 h-7 w-full bg-[#6A00F4] text-xs hover:bg-[#5a00d1]" onClick={() => onNavigate("work")}>
                <HardHat className="size-3.5" aria-hidden /> My assignments
              </Button>
            </div>
          ) : role === "ADMIN" ? (
            <div className="rounded-xl border border-[#B45309]/25 bg-[#B45309]/[0.06] p-3.5">
              <p className="text-xs font-semibold text-foreground">Resolution verification</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                {verifyQ.data
                  ? `${verifyQ.data} repair${verifyQ.data === 1 ? "" : "s"} awaiting your sign-off. Compare before/after evidence, then verify & close.`
                  : "Compare contractor before/after evidence and close out verified repairs."}
              </p>
              <Button size="sm" className="mt-2.5 h-7 w-full bg-[#B45309] text-xs hover:bg-[#93440a]" onClick={() => onNavigate("verify")}>
                <BadgeCheck className="size-3.5" aria-hidden /> Verify resolutions
              </Button>
            </div>
          ) : management.length > 0 ? (
            <div className="rounded-xl border border-[#6A00F4]/20 bg-[#6A00F4]/[0.05] p-3.5">
              <p className="text-xs font-semibold text-foreground">Verification &amp; repairs</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Verify incoming hazards, assign crews and follow completed repairs — the administrator signs off final resolutions.
              </p>
              <Button size="sm" className="mt-2.5 h-7 w-full bg-[#6A00F4] text-xs hover:bg-[#5a00d1]" onClick={() => onNavigate("queue")}>
                <ShieldCheck className="size-3.5" aria-hidden /> Open the queue
              </Button>
            </div>
          ) : (
            <div className="rounded-xl border border-[#6A00F4]/20 bg-[#6A00F4]/[0.05] p-3.5">
              <p className="text-xs font-semibold text-foreground">Every report is risk-scored</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                AI confidence, severity and a transparent risk score — no black boxes, no hallucinated hazards.
              </p>
              <Button size="sm" className="mt-2.5 h-7 w-full bg-[#6A00F4] text-xs hover:bg-[#5a00d1]" onClick={() => onNavigate("detect")}>
                <ScanSearch className="size-3.5" aria-hidden /> Try the scanner
              </Button>
            </div>
          )}
        </div>
      )}
    </nav>
  );
}

const COLLAPSE_KEY = "rg-sidebar-collapsed";

export function AppShell({ children }: { children: React.ReactNode }) {
  const { view, setView, user, unread, signOut, refreshUnread } = useApp();
  const [scrolled, setScrolled] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const role = user?.role ?? "CITIZEN";
  const canManage = role === "ADMIN" || role === "AUTHORITY";

  useEffect(() => {
    // defer the localStorage read to avoid hydration mismatch AND sync setState in effect
    const raf = requestAnimationFrame(() => {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === "1");
    });
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  const toggleCollapse = () => {
    setCollapsed((c) => {
      window.localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      return !c;
    });
  };

  const go = (v: View) => {
    setView(v);
    setMobileOpen(false);
  };

  return (
    <div className="min-h-screen bg-background">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-[#6A00F4] focus:px-4 focus:py-2 focus:text-white">
        Skip to content
      </a>

      {/* ---------------- vertical sidebar (desktop) ---------------- */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 hidden flex-col border-r border-border bg-card/80 backdrop-blur-md transition-[width] duration-300 lg:flex",
          collapsed ? "w-[76px]" : "w-[268px]"
        )}
      >
        <div className={cn("flex h-16 shrink-0 items-center border-b border-border px-4", collapsed && "justify-center px-2")}>
          <button onClick={() => go("home")} className="group flex items-center gap-2.5" aria-label="HazardLensAI dashboard">
            <BrandMark className="size-9 transition-transform group-hover:scale-105" compact={collapsed} />
            {!collapsed && <BrandWordmark />}
          </button>
          {!collapsed && <span className="flex-1" />}
          <button
            onClick={toggleCollapse}
            className="hidden rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground lg:block"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <PanelLeft className="size-4" aria-hidden /> : <ChevronLeft className="size-4" aria-hidden />}
          </button>
        </div>
        <SidebarBody collapsed={collapsed} onNavigate={go} />
        <div className={cn("border-t border-border p-3", collapsed && "px-2")}>
          {user && (
            <button
              onClick={() => go("dashboard")}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-lg p-2 text-left transition-colors hover:bg-secondary",
                collapsed && "justify-center"
              )}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-[#6A00F4]/10 text-xs font-bold text-[#6A00F4]">
                {user.name.slice(0, 1).toUpperCase()}
              </span>
              {!collapsed && (
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold">{user.name}</span>
                  <span className="block truncate text-[10px] text-muted-foreground">{roleLabel(role)}</span>
                </span>
              )}
            </button>
          )}
        </div>
      </aside>

      {/* ---------------- content column ---------------- */}
      <div className={cn("flex min-h-screen flex-col transition-[padding] duration-300", collapsed ? "lg:pl-[76px]" : "lg:pl-[268px]")}>
        <header
          className={cn(
            "sticky top-0 z-30 border-b border-border/80 backdrop-blur-md transition-shadow",
            scrolled ? "bg-background/90 shadow-[0_2px_24px_rgba(28,21,48,0.06)]" : "bg-background/75"
          )}
        >
          <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
            <div className="flex min-w-0 items-center gap-2">
              {/* mobile: drawer trigger */}
              <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                <SheetTrigger asChild>
                  <button className="rounded-md p-2 text-muted-foreground hover:bg-secondary lg:hidden" aria-label="Open navigation menu">
                    <Menu className="size-5" aria-hidden />
                  </button>
                </SheetTrigger>
                <SheetContent side="left" className="w-[280px] p-0" aria-describedby={undefined}>
                  <SheetTitle className="sr-only">Navigation</SheetTitle>
                  <div className="flex h-full flex-col">
                    <div className="flex h-16 items-center border-b border-border px-4">
                      <button onClick={() => go("home")} className="flex items-center gap-2.5" aria-label="HazardLensAI dashboard">
                        <BrandMark className="size-9" />
                        <BrandWordmark />
                      </button>
                    </div>
                    <SidebarBody collapsed={false} onNavigate={go} />
                  </div>
                </SheetContent>
              </Sheet>
              <h2 className="truncate font-display text-lg font-semibold tracking-tight text-foreground">
                {PAGE_TITLES[view] ?? "HazardLensAI"}
              </h2>
            </div>

            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => go("report")}
                className="hidden bg-[#6A00F4] hover:bg-[#5a00d1] sm:inline-flex"
              >
                <PencilLine className="size-4" aria-hidden /> Report a Hazard
              </Button>
              {canManage && (
                <Button
                  size="sm"
                  onClick={() => go("queue")}
                  variant="outline"
                  className="hidden border-border bg-card sm:inline-flex"
                >
                  <ShieldCheck className="size-4" aria-hidden /> Hazard Queue
                </Button>
              )}

              {user && (
                <>
                  <button
                    className="relative rounded-md p-2 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
                    onClick={() => {
                      void refreshUnread();
                      go("dashboard");
                      toast.info("Notification center lives inside My Reports.");
                    }}
                  >
                    <Bell className="size-5" aria-hidden />
                    {unread > 0 && (
                      <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-[#C83E4D] text-[10px] font-bold text-white">
                        {unread > 9 ? "9+" : unread}
                      </span>
                    )}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className="flex items-center gap-2 rounded-full border border-border bg-card py-1 pl-1 pr-3 transition-colors hover:bg-secondary" aria-label="Account menu">
                        <span className="flex size-7 items-center justify-center rounded-full bg-[#6A00F4]/10 text-xs font-bold text-[#6A00F4]">
                          {user.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span className="hidden max-w-24 truncate text-sm font-medium md:block">{user.name.split(" ")[0]}</span>
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuLabel>
                        <span className="block truncate text-sm">{user.email}</span>
                        <span className="text-xs font-normal text-muted-foreground">{roleLabel(role)} account</span>
                      </DropdownMenuLabel>
                      <DropdownMenuSeparator />
                      {canManage && (
                        <DropdownMenuItem onClick={() => go("queue")}>
                          <ShieldCheck className="size-4" aria-hidden /> Hazard Queue
                        </DropdownMenuItem>
                      )}
                      {(role === "ADMIN" || role === "AUTHORITY" || role === "FIELD_WORKER") && (
                        <DropdownMenuItem onClick={() => go("work")}>
                          <ClipboardList className="size-4" aria-hidden /> Work Orders
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => go("dashboard")}>
                        <ClipboardList className="size-4" aria-hidden /> My Reports
                      </DropdownMenuItem>
                      {role === "ADMIN" && (
                        <DropdownMenuItem onClick={() => go("verify")}>
                          <BadgeCheck className="size-4" aria-hidden /> Resolution Verification
                        </DropdownMenuItem>
                      )}
                      {role === "ADMIN" && (
                        <DropdownMenuItem onClick={() => go("admin")}>
                          <Settings2 className="size-4" aria-hidden /> Administration
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => go("docs")}>
                        <BookOpen className="size-4" aria-hidden /> Documentation
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => {
                          void signOut();
                          toast.success("Signed out");
                        }}
                      >
                        Sign out
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </div>
          </div>
        </header>

        <main id="main" className="flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}
