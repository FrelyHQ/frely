import * as React from "react";
import Link from "@web/navigation";
import { Button } from "@frely/ui/components/button";

export default function NotFound() {
  return (
    <section className="not-found-page" aria-labelledby="not-found-title">
      <div className="not-found-panel panel">
        <p className="eyebrow">404</p>
        <h1 id="not-found-title">Page not found</h1>
        <p className="muted">The User page you requested does not exist.</p>
        <div className="not-found-actions">
          <Button asChild>
            <Link href="/user">Return to User Home</Link>
          </Button>
        </div>
      </div>
    </section>
  );
}
