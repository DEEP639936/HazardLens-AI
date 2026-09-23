// next/dynamic wrapper with a shared loading skeleton (client-only chunks).
"use client";
import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";

export function dynamicImport<T extends React.ComponentType<unknown>>(loader: () => Promise<{ default: T }>): T {
  return dynamic(loader, {
    ssr: false,
    loading: () => (
      <div className="flex h-full w-full items-center justify-center bg-muted/40">
        <div className="w-full max-w-md space-y-3 p-8">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      </div>
    ),
  }) as T;
}
