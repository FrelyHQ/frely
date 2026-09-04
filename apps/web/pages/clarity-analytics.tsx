"use client";

import Clarity from "@microsoft/clarity";
import { usePathname } from "@web/navigation";
import { useEffect, useState } from "react";

const CLARITY_CONSENT_STORAGE_KEY = "friday_clarity_consent_v1";

type ClarityConsent = "granted" | "denied";

export function isClarityPath(pathname: string): boolean {
  return pathname === "/"
    || pathname === "/login"
    || pathname.startsWith("/login/")
    || pathname === "/register"
    || pathname.startsWith("/register/")
    || pathname === "/user"
    || pathname.startsWith("/user/");
}

export function claritySurface(pathname: string): "landing" | "login" | "register" | "user-console" {
  if (pathname === "/") return "landing";
  if (pathname === "/login" || pathname.startsWith("/login/")) return "login";
  if (pathname === "/register" || pathname.startsWith("/register/")) return "register";
  return "user-console";
}

export function clarityRelease(value: string): string {
  const release = value.trim();
  return /^(?:[0-9a-f]{40}|v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|dev)$/u.test(release) ? release : "unknown";
}

export function ClarityAnalytics({ projectId, release }: { projectId: string | null; release: string }) {
  const pathname = usePathname();
  const allowed = projectId !== null && isClarityPath(pathname);
  const [consent, setConsent] = useState<ClarityConsent | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!allowed) return;
    const stored = window.localStorage.getItem(CLARITY_CONSENT_STORAGE_KEY);
    setConsent(stored === "granted" || stored === "denied" ? stored : null);
    setLoaded(true);
  }, [allowed]);

  useEffect(() => {
    if (!allowed || consent !== "granted" || projectId === null) return;
    Clarity.init(projectId);
    Clarity.consentV2({ analytics_Storage: "granted", ad_Storage: "denied" });
    Clarity.setTag("release", clarityRelease(release));
    Clarity.setTag("surface", claritySurface(pathname));
  }, [allowed, consent, pathname, projectId, release]);

  if (!allowed || !loaded) return null;

  function chooseConsent(next: ClarityConsent) {
    const withdrawing = consent === "granted" && next === "denied";
    window.localStorage.setItem(CLARITY_CONSENT_STORAGE_KEY, next);
    setConsent(next);
    setEditing(false);
    if (withdrawing) {
      Clarity.consentV2({ analytics_Storage: "denied", ad_Storage: "denied" });
      Clarity.consent(false);
      window.location.reload();
    }
  }

  const showPrompt = consent === null || editing;

  return (
    <>
      {consent !== null && !showPrompt
        ? <button className="clarity-settings-trigger" type="button" onClick={() => setEditing(true)}>Analytics settings</button>
        : null}
      {showPrompt
        ? (
          <section className="clarity-consent" aria-label="Analytics preferences">
            <div>
              <strong>Analytics preferences</strong>
              <p>We use Microsoft Clarity session analytics to improve Frely. Advertising storage stays disabled.</p>
              <a href="https://privacy.microsoft.com/privacystatement" target="_blank" rel="noreferrer">Microsoft Privacy Statement</a>
            </div>
            <div className="clarity-consent-actions">
              <button type="button" onClick={() => chooseConsent("denied")}>Reject</button>
              <button className="clarity-consent-accept" type="button" onClick={() => chooseConsent("granted")}>Accept analytics</button>
            </div>
          </section>
        )
        : null}
    </>
  );
}
