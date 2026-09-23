"use client";
// PublicShell — chrome for the PUBLIC marketing website and auth screens.
// Deliberately feature-free: no product tools are reachable from here. Visitors see the
// story of the platform; every "use it" affordance routes through Sign in / Get started.
import { cn } from "@/lib/utils";
import { useApp } from "@/lib/rg/store";
import { BrandMark, BrandWordmark } from "@/components/rg/brand";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import {
  ArrowRight,
  FolderDown,
  LockKeyhole,
  Menu,
} from "lucide-react";
import { useEffect, useState } from "react";

const SECTION_LINKS = [
  { id: "detections", label: "Detections" },
  { id: "how", label: "How it works" },
  { id: "priorities", label: "Priorities" },
  { id: "field-notes", label: "Field notes" },
];

function Wordmark({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="group flex items-center gap-2.5" aria-label="HazardLensAI — overview">
      <BrandMark className="size-9 transition-transform group-hover:scale-105" />
      <BrandWordmark />
    </button>
  );
}

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function PublicShell({
  children,
  variant = "marketing",
}: {
  children: React.ReactNode;
  variant?: "marketing" | "auth";
}) {
  const { setView } = useApp();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <a
        href="#public-main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-[#6A00F4] focus:px-4 focus:py-2 focus:text-white"
      >
        Skip to content
      </a>

      {/* ---------------- public top bar ---------------- */}
      <header
        className={cn(
          "sticky top-0 z-40 border-b border-border/70 backdrop-blur-md transition-shadow",
          scrolled ? "bg-background/90 shadow-[0_2px_24px_rgba(28,21,48,0.06)]" : "bg-background/80"
        )}
      >
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <Wordmark onClick={() => setView("home")} />

          {variant === "marketing" ? (
            <>
              <nav aria-label="Marketing sections" className="hidden items-center gap-1 md:flex">
                {SECTION_LINKS.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => scrollToSection(s.id)}
                    className="rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                  >
                    {s.label}
                  </button>
                ))}
              </nav>

              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="border-border bg-card" onClick={() => setView("signin")}>
                  Sign in
                </Button>
                <Button
                  size="sm"
                  className="hidden bg-[#6A00F4] hover:bg-[#5a00d1] sm:inline-flex"
                  onClick={() => setView("signup")}
                >
                  Get started <ArrowRight className="size-4" aria-hidden />
                </Button>
                {/* mobile section menu */}
                <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
                  <SheetTrigger asChild>
                    <button
                      className="rounded-md p-2 text-muted-foreground hover:bg-secondary md:hidden"
                      aria-label="Open sections menu"
                    >
                      <Menu className="size-5" aria-hidden />
                    </button>
                  </SheetTrigger>
                  <SheetContent side="right" className="w-[280px] p-0" aria-describedby={undefined}>
                    <SheetTitle className="sr-only">Sections</SheetTitle>
                    <div className="flex h-full flex-col">
                      <div className="flex h-16 items-center border-b border-border px-4">
                        <Wordmark onClick={() => { setMenuOpen(false); setView("home"); }} />
                      </div>
                      <nav aria-label="Marketing sections" className="flex flex-1 flex-col gap-1 p-3">
                        {SECTION_LINKS.map((s) => (
                          <button
                            key={s.id}
                            onClick={() => {
                              setMenuOpen(false);
                              // wait for the drawer to close so the scroll lands correctly
                              requestAnimationFrame(() => scrollToSection(s.id));
                            }}
                            className="rounded-lg px-3 py-2.5 text-left text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                          >
                            {s.label}
                          </button>
                        ))}
                        <div className="my-3 h-px bg-border" aria-hidden />
                        <Button className="w-full bg-[#6A00F4] hover:bg-[#5a00d1]" onClick={() => { setMenuOpen(false); setView("signup"); }}>
                          Get started <ArrowRight className="size-4" aria-hidden />
                        </Button>
                        <Button variant="outline" className="mt-2 w-full border-border" onClick={() => { setMenuOpen(false); setView("signin"); }}>
                          Sign in
                        </Button>
                        <Button asChild variant="outline" className="mt-2 w-full border-[#6A00F4]/30 bg-[#6A00F4]/[0.06] text-[#6A00F4] hover:bg-[#6A00F4]/[0.12]">
                          <a href="/api/project/download" download>
                            <FolderDown className="size-4" aria-hidden /> Download project (.zip)
                          </a>
                        </Button>
                        <p className="mt-4 flex items-start gap-1.5 px-1 text-[11px] leading-relaxed text-muted-foreground">
                          <LockKeyhole className="mt-0.5 size-3 shrink-0" aria-hidden />
                          The live map, pothole scanner, hazard reporting and dashboards unlock after sign-in.
                        </p>
                      </nav>
                    </div>
                  </SheetContent>
                </Sheet>
              </div>
            </>
          ) : (
            /* auth variant — minimal: back to the public overview */
            <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-foreground" onClick={() => setView("home")}>
              <ArrowRight className="size-4 rotate-180" aria-hidden /> Back to overview
            </Button>
          )}
        </div>
      </header>

      {/* ---------------- page content ---------------- */}
      <main id="public-main" className="flex-1">
        {children}
      </main>
    </div>
  );
}
