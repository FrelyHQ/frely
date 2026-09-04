import { AuthShell } from "../auth-shell";
import { LandingEntryHandoff } from "../landing-entry-handoff";
import { WebLoginForm } from "./web-login-form";
import type { WebLoginPageData } from "./page.server";

export default function WebLoginPage({ data }: { data: WebLoginPageData }) {
  if (data.kind === "landing") {
    return <AuthShell><LandingEntryHandoff teamName={data.teamName} state={data.state} action={data.action} /></AuthShell>;
  }
  return (
    <AuthShell>
      <WebLoginForm
        next={data.next}
        registrationHref={data.registrationHref}
        registrationPrompt={data.registrationPrompt}
        registrationLabel="Register an account"
      />
    </AuthShell>
  );
}
