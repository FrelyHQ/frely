import type { ColumnDef } from "@frely/console-ui/data-table";
import { PipelinePluginChips } from "@frely/console-ui/pipeline-plugin-chips";
import { Button } from "@frely/ui/components/button";
import { BrowserTime } from "@frely/ui/components/browser-time";
import { Tooltip } from "@frely/ui/components/tooltip";
import { StatusBadge } from "../../../pages/owner/_components/ui";
import type { RequestLogRow } from "../lib/request-log-display";

export interface RequestLogTableActions {
  copyId: (id: string) => void;
  openCapture: (mode: "raw" | "error", row: RequestLogRow) => void;
}

export function requestLogColumns(actions: RequestLogTableActions): Array<ColumnDef<RequestLogRow, unknown>> {
  return [
    { id: "time", header: "Time", accessorKey: "time", enableSorting: false, cell: ({ row }) => <div className="request-log-time-cell"><BrowserTime value={row.original.startedAt} seconds /><Tooltip content="Copy request ID"><button type="button" className="request-log-id-copy" onClick={() => actions.copyId(row.original.id)}><code>{row.original.id}</code></button></Tooltip></div> },
    { id: "status", header: "Status", accessorKey: "status", enableSorting: false, cell: ({ row }) => <StatusBadge tone={row.original.statusTone}>{row.original.status}</StatusBadge> },
    { id: "error", header: "Error", accessorKey: "errorCode", enableSorting: false, cell: ({ row }) => <Button type="button" variant="link" className="request-log-cell-button" onClick={() => actions.openCapture("error", row.original)}><code>{row.original.errorCode}</code></Button> },
    { id: "path", header: "Request Path", accessorKey: "requestPath", enableSorting: false, cell: ({ row }) => <Tooltip content="View raw request and response"><Button type="button" variant="link" className="request-log-cell-button" onClick={() => actions.openCapture("raw", row.original)}><code>{row.original.requestPath}</code></Button></Tooltip> },
    { id: "ingressHostname", header: "Ingress Host", accessorKey: "ingressHostname", enableSorting: false, cell: ({ row }) => <code>{row.original.ingressHostname}</code> },
    { id: "ingressRouteId", header: "Ingress Route", accessorKey: "ingressRouteId", enableSorting: false, cell: ({ row }) => <code>{row.original.ingressRouteId}</code> },
    { id: "provider", header: "Provider", accessorKey: "provider", enableSorting: false },
    { id: "model", header: "Model", accessorKey: "model", enableSorting: false },
    {
      id: "pipelinePlugins",
      header: "Pipeline Plugins",
      accessorKey: "pipelinePlugins",
      enableSorting: false,
      cell: ({ row }) => <PipelinePluginChips plugins={row.original.pipelinePlugins} summary />
    },
    { id: "apiKey", header: "API Key", accessorKey: "apiKey", enableSorting: false },
    { id: "owner", header: "Owner", accessorFn: (row) => `${row.user} ${row.team}`, enableSorting: false, cell: ({ row }) => <div><div>{row.original.user}</div><span className="muted">{row.original.team}</span></div> },
    { id: "duration", header: "Duration", accessorKey: "duration", enableSorting: false }
  ];
}
