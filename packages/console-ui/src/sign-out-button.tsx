"use client";

import { LogOut } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@frely/ui/components/button";
import { Tooltip } from "@frely/ui/components/tooltip";
import { cn } from "@frely/ui/lib/utils";
import { signOut } from "./sign-out.js";

export function ConsoleSignOutButton({ className, loginHref }: { className?: string; loginHref: string }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: signOut,
    retry: false,
    onSuccess: () => {
      queryClient.clear();
      window.location.assign(loginHref);
    }
  });

  return (
    <>
      <Tooltip content={mutation.error ? "Sign out failed. Try again." : "Sign out"}>
        <Button className={cn(className)} type="button" variant="ghost" size="icon" aria-label="Sign out" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
          <LogOut aria-hidden="true" />
        </Button>
      </Tooltip>
      {mutation.error ? <span className="sr-only" role="alert">Sign out failed. Try again.</span> : null}
    </>
  );
}
