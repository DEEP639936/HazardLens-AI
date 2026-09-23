import type { Metadata, Viewport } from "next";
import { Bodoni_Moda, Manrope } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

const bodoni = Bodoni_Moda({
  variable: "--font-bodoni",
  subsets: ["latin"],
  display: "swap",
});

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "HazardLensAI — See the road. Prioritize the repair.",
    template: "%s · HazardLensAI",
  },
  description:
    "Detect road hazards with computer vision, map them with geospatial clustering, and prioritize maintenance with an explainable 0–100 repair score.",
  keywords: ["road safety", "pothole detection", "computer vision", "YOLO", "GIS", "civic technology", "maintenance prioritization"],
  authors: [{ name: "HazardLensAI" }],
  openGraph: {
    title: "HazardLensAI",
    description: "Vision-powered road hazard mapping and maintenance prioritization.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#6A00F4",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${bodoni.variable} ${manrope.variable} min-h-screen bg-background font-sans text-foreground antialiased`}>
        {children}
        <Toaster richColors position="top-right" toastOptions={{ classNames: { toast: "border-border" } }} />
      </body>
    </html>
  );
}
