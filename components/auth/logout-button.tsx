"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { Button, type ButtonProps } from "@/components/ui/button";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

interface LogoutButtonProps {
  className?: string;
  label?: string;
  variant?: ButtonProps["variant"];
}

export function LogoutButton({
  className,
  label = "Sign out",
  variant = "outline",
}: LogoutButtonProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const handleLogout = async () => {
    setIsLoading(true);

    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();

    try {
      // Clear any Supabase auth tokens that may remain in browser storage.
      const lsKeys = Object.keys(localStorage || {});
      lsKeys.forEach((k) => {
        if (k.startsWith("supabase") || k.startsWith("sb-") || k.includes("auth")) {
          localStorage.removeItem(k);
        }
      });
    } catch (e) {
      // ignore storage clearing errors
    }

    router.push("/login");
    router.refresh();
  };

  return (
    <Button
      type="button"
      variant={variant}
      className={cn("w-full rounded-xl", className)}
      onClick={handleLogout}
      disabled={isLoading}
    >
      {isLoading ? "Signing out..." : label}
    </Button>
  );
}
