import { RegisterInvite } from "../../features/register";
import { AuthShell } from "../auth-shell";
import { LandingEntryHandoff } from "../landing-entry-handoff";
import type { RegisterPageData } from "./page.server";

export default function RegisterPage({ data }: { data: RegisterPageData }) {
  if (data.kind === "landing") {
    return <AuthShell width="md"><LandingEntryHandoff teamName={data.teamName} state={data.state} action={data.action} /></AuthShell>;
  }
  if (data.kind === "registration") {
    return (
      <AuthShell width="md">
        <RegisterInvite
          registrationEntry={data.registrationEntry}
          teamName={data.teamName}
          memberInvitesEnabled={false}
          inviteEmailDomainRestricted={false}
          currentUserEmail={null}
        />
      </AuthShell>
    );
  }
  return (
    <AuthShell width="md">
      <RegisterInvite
        {...(data.inviteToken ? { inviteToken: data.inviteToken } : {})}
        teamName={data.teamName}
        memberInvitesEnabled={data.memberInvitesEnabled}
        inviteEmailDomainRestricted={data.inviteEmailDomainRestricted}
        currentUserEmail={data.currentUserEmail}
      />
    </AuthShell>
  );
}
