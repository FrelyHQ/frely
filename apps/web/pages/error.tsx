"use client";

import { getSurfaceRuntime } from "@frely/observability/client-runtime";
import { Button } from "@frely/ui/components/button";
import { useEffect } from "react";

export default function ErrorBoundary({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    getSurfaceRuntime()?.failActiveSurface();
  }, []);
  return (
    <div className="notice-box notice-bad" role="alert">
      <p>The page could not be loaded.</p>
      <Button type="button" onClick={reset}>Try again</Button>
    </div>
  );
}
