import { AuditLogsView } from "../../../features/logs/components/audit-logs-view";
import type { AdminPageData } from "./page.server";

export default function AuditLogsPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { state, page, aggregate } = loaded;
  return <AuditLogsView {...aggregate} state={{ ...state, page: page.page }} />;
}
