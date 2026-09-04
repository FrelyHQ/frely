import { RequestLogsView } from "../../../features/logs/components/request-logs-view";
import type { AdminPageData } from "./page.server";

export default function RequestLogsPage({ data: loaded }: { data: AdminPageData }) {
  if (!loaded) return null;
  const { state, logs } = loaded;
  return <RequestLogsView logs={logs} state={state} />;
}
