import { getSurfaceRuntime } from "@frely/observability/client-runtime";
import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

export function AdminRootErrorComponent() {
  const router = useRouter();
  useEffect(() => {
    getSurfaceRuntime()?.failActiveSurface();
  }, []);
  return (
    <section className="error-shell" role="alert">
      <h1>Unable to load Admin</h1>
      <p>The request could not be completed.</p>
      <button type="button" onClick={() => void router.invalidate()}>Try again</button>
    </section>
  );
}
