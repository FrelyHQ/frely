"use client";

import { Button } from "@frely/ui/components/button";
import { Tooltip } from "@frely/ui/components/tooltip";
import { useState } from "react";

export function CopyApiKeyButton({ value, unavailableLabel = "Unavailable" }: { value?: string | null | undefined; unavailableLabel?: string }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const canCopy = Boolean(value);

  async function copyValue() {
    if (!value) return;

    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setFailed(false);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setFailed(true);
      window.setTimeout(() => setFailed(false), 1500);
    }
  }

  return (
    <Tooltip content={canCopy ? "Copy API key" : unavailableLabel} wrapTrigger={!canCopy}>
      <Button
        className="copy-key-button"
        type="button"
        variant="secondary"
        onClick={() => void copyValue()}
        disabled={!canCopy}
      >
        {failed ? "Failed" : copied ? "Copied" : "Copy"}
      </Button>
    </Tooltip>
  );
}
