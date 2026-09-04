import { TeamDirectory } from "./team-directory";
import type { TeamPageData } from "./page.server";

export default function TeamPage({ data }: { data: TeamPageData }) {
  return <TeamDirectory directory={data.directory} />;
}
