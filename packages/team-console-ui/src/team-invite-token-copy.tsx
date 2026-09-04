"use client";

import React, { useEffect, useRef, useState } from "react";
import { Tooltip } from "@frely/ui/components/tooltip";
import { teamInviteRegistrationUrl } from "./team-invite-registration-url.js";

type CopyState = "idle" | "copied" | "failed";

export function TeamInviteTokenCopy({ inviteToken, publicBaseUrl }: { inviteToken: string; publicBaseUrl: string }) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<number | null>(null);
  const inviteUrl = teamInviteRegistrationUrl(publicBaseUrl, inviteToken);

  useEffect(() => () => {
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
  }, []);

  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard is unavailable");
      await navigator.clipboard.writeText(inviteUrl);
      showState("copied");
    } catch {
      showState("failed");
    }
  };

  const showState = (state: CopyState) => {
    setCopyState(state);
    if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1500);
  };

  const tooltip = copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy full invitation link";
  const accessibleLabel = copyState === "copied" ? `Invitation link copied for token ${inviteToken}` : copyState === "failed" ? `Invitation link copy failed for token ${inviteToken}` : `Copy full invitation link for token ${inviteToken}`;
  return <Tooltip content={tooltip}><button type="button" className="rounded-[4px] text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={accessibleLabel} onClick={() => void copy()}><code>{inviteToken}</code></button></Tooltip>;
}
