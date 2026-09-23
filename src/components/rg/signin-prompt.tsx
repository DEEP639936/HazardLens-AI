"use client";
// Shared gate: prompts visitors to authenticate for role-protected views.
import { Button } from "@/components/ui/button";
import { useApp } from "@/lib/rg/store";
import { LockKeyhole } from "lucide-react";

export function SignInPrompt({ message }: { message: string }) {
  const setView = useApp((s) => s.setView);
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-[#6A00F4]/10 text-[#6A00F4]">
        <LockKeyhole className="size-6" aria-hidden />
      </div>
      <h1 className="mt-5 font-display text-3xl">Sign in required</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>
      <div className="mt-7 flex justify-center gap-3">
        <Button className="bg-[#6A00F4] hover:bg-[#5a00d1]" onClick={() => setView("signin")}>
          Sign in
        </Button>
        <Button variant="outline" className="border-border" onClick={() => setView("signup")}>
          Create account
        </Button>
      </div>
    </div>
  );
}
