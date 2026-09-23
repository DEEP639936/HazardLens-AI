// Client stores: hash-based view router + session.
"use client";
import { create } from "zustand";
import { api } from "./api";
import type { Role, SessionUser } from "./types";

export type View =
  | "home"
  | "map"
  | "detect"
  | "report"
  | "alerts"
  | "queue"
  | "work"
  | "verify"
  | "analytics"
  | "admin"
  | "docs"
  | "signin"
  | "signup"
  | "reset"
  | "dashboard";

const VALID_VIEWS: View[] = [
  "home", "map", "detect", "report", "alerts", "queue", "work", "verify", "analytics", "admin", "docs",
  "signin", "signup", "reset", "dashboard",
];

export function viewFromHash(): View {
  const h = (typeof window !== "undefined" ? window.location.hash : "").replace(/^#\/?/, "");
  return (VALID_VIEWS.includes(h as View) ? h : "home") as View;
}

/* ---------------- access model ----------------
 * Public website (signed-out visitors): marketing landing ("home") + auth pages only.
 * Every product surface renders exclusively inside the authenticated app shell.
 *
 * Role matrix (enforced in the UI here AND on every API route server-side):
 *   CITIZEN      : dashboard, live map, detect, report, alerts, docs, my reports
 *   FIELD_WORKER : everything a citizen has, plus Work Orders (own assignments)
 *   AUTHORITY    : citizen surfaces minus personal reporting is still allowed, plus
 *                  Hazard Queue, Work Orders and Analytics
 *   ADMIN        : everything, including the Administration console
 */
export const AUTH_VIEWS: View[] = ["signin", "signup", "reset"];

/** Administration console + resolution verification — ADMIN only. */
export const ADMIN_ONLY_VIEWS: View[] = ["admin", "verify"];

/** Management surfaces — AUTHORITY (and ADMIN). Work Orders additionally admit FIELD_WORKER. */
export const MANAGEMENT_VIEWS: View[] = ["queue", "work", "analytics"];

/** Views that require AUTHORITY/ADMIN. */
export function isManagementView(v: View): boolean {
  return MANAGEMENT_VIEWS.includes(v);
}

export function isAuthView(v: View): boolean {
  return AUTH_VIEWS.includes(v);
}

export function isProtectedView(v: View): boolean {
  return !isAuthView(v) && v !== "home";
}

export function isViewAllowedForRole(v: View, role: Role): boolean {
  if (role === "ADMIN") return true;
  if (ADMIN_ONLY_VIEWS.includes(v)) return false;
  if (isManagementView(v)) {
    if (v === "work") return role === "AUTHORITY" || role === "FIELD_WORKER";
    return role === "AUTHORITY";
  }
  return true;
}

export const VIEW_LABELS: Record<View, string> = {
  home: "the dashboard",
  map: "the live hazard map",
  detect: "the pothole detector",
  report: "hazard reporting",
  alerts: "hazard alerts",
  queue: "the hazard queue",
  work: "work orders",
  verify: "resolution verification",
  analytics: "analytics",
  admin: "administration",
  docs: "the documentation hub",
  signin: "sign in",
  signup: "account creation",
  reset: "password reset",
  dashboard: "your reports",
};

interface AppState {
  view: View;
  user: SessionUser | null;
  sessionLoading: boolean;
  unread: number;
  setView: (v: View) => void;
  loadSession: () => Promise<void>;
  refreshUnread: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const useApp = create<AppState>((set, get) => ({
  view: "home",
  user: null,
  sessionLoading: true,
  unread: 0,
  setView: (v) => {
    if (typeof window !== "undefined") {
      window.history.pushState(null, "", v === "home" ? "#" : `#/${v}`);
      window.scrollTo({ top: 0, behavior: "auto" });
    }
    set({ view: v });
  },
  loadSession: async () => {
    set({ sessionLoading: true });
    try {
      const data = await api<{ user: SessionUser | null }>("/api/auth/me");
      set({ user: data.user });
      if (data.user) void get().refreshUnread();
    } catch {
      set({ user: null });
    } finally {
      set({ sessionLoading: false });
    }
  },
  refreshUnread: async () => {
    try {
      const data = await api<{ unread: number }>("/api/users/me/notifications");
      set({ unread: data.unread });
    } catch {
      /* not signed in */
    }
  },
  signOut: async () => {
    try {
      await api("/api/auth/logout", { json: {} });
    } finally {
      set({ user: null, unread: 0 });
      get().setView("home");
    }
  },
}));

export function initHashRouting(): () => void {
  const onPop = () => {
    useApp.setState({ view: viewFromHash() });
  };
  window.addEventListener("popstate", onPop);
  return () => window.removeEventListener("popstate", onPop);
}
