import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { createId, nowIso, RelayError } from "@frely/core";
import type { ApplicationOperationPort } from "./application-operation-port.js";
import type { AuditActor } from "./audit.js";

export const PUBLIC_HOST_PAGE_SIZE = 20;
export const INTERNAL_GATEWAY_HOSTNAME = "gateway-srv";

export interface InstancePublicHost {
  id: string;
  hostname: string;
  enabled: boolean;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicHostCommandAudit {
  actor: AuditActor;
  requestId?: string | null;
}

export interface PublicHostCommands {
  create(input: { row: InstancePublicHost; audit: PublicHostCommandAudit }): Promise<InstancePublicHost>;
  update(input: { id: string; enabled: boolean; updatedByUserId: string; updatedAt: string; audit: PublicHostCommandAudit }): Promise<InstancePublicHost>;
  delete(input: { id: string; audit: PublicHostCommandAudit }): Promise<void>;
}

export interface InstancePublicHostPage {
  items: InstancePublicHost[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PublicHostPolicy {
  canonicalHostname: string;
  canonicalOrigin: string;
  reservedHostnames: ReadonlySet<string>;
}

export function createPublicHostPolicy(publicBaseUrl: string, reservedHostnames: readonly string[] = []): PublicHostPolicy {
  let url: URL;
  try {
    url = new URL(publicBaseUrl);
  } catch {
    throw new RelayError("public_host_hostname_invalid", "app.publicBaseUrl must be a valid URL", 500);
  }
  const canonicalHostname = normalizeAuthorityHostname(url.hostname);
  const normalizedReserved = new Set<string>([INTERNAL_GATEWAY_HOSTNAME]);
  for (const value of reservedHostnames) normalizedReserved.add(normalizePublicHostname(value));
  return {
    canonicalHostname,
    canonicalOrigin: url.origin,
    reservedHostnames: normalizedReserved
  };
}

export function normalizePublicHostname(value: unknown): string {
  if (typeof value !== "string") throw invalidHostname();
  const trimmed = value.trim();
  if (!trimmed || /[/:@?#,*\[\]]/u.test(trimmed)) throw invalidHostname();
  const withoutDot = trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
  if (!withoutDot || withoutDot.endsWith(".")) throw invalidHostname();
  const hostname = domainToASCII(withoutDot).toLowerCase();
  if (!hostname || hostname.length > 253 || isIP(hostname) !== 0) throw invalidHostname();
  if (
    hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
  ) {
    throw new RelayError("public_host_hostname_reserved", "This hostname is reserved for local or internal use", 400);
  }
  const labels = hostname.split(".");
  if (
    labels.length < 2
    || labels.some((label) => label.length < 1 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
    || /^\d+$/.test(labels.at(-1) ?? "")
  ) {
    throw invalidHostname();
  }
  return hostname;
}

export function parseHostHeader(headers: Headers): string {
  const value = headers.get("host");
  if (value === null || value.trim() === "") throw new RelayError("host_required", "Host header is required", 400);
  return normalizeAuthorityHostname(value);
}

export function normalizeAuthorityHostname(value: string): string {
  const authority = value.trim();
  if (!authority || /[,/@?#]/.test(authority)) throw new RelayError("host_invalid", "Host header is invalid", 400);
  let url: URL;
  try {
    url = new URL(`http://${authority}`);
  } catch {
    throw new RelayError("host_invalid", "Host header is invalid", 400);
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new RelayError("host_invalid", "Host header is invalid", 400);
  }
  if (url.port) {
    const port = Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new RelayError("host_invalid", "Host header is invalid", 400);
  }
  const rawHostname = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  const hostname = domainToASCII(rawHostname).toLowerCase();
  if (!hostname || hostname.length > 253) throw new RelayError("host_invalid", "Host header is invalid", 400);
  return hostname;
}

function invalidHostname(): RelayError {
  return new RelayError("public_host_hostname_invalid", "A valid public DNS hostname is required", 400);
}

function notFound(): RelayError {
  return new RelayError("public_host_not_found", "Public Host not found", 404);
}

function mapPublicHostConflict(error: unknown): unknown {
  if (error instanceof RelayError) return error;
  const message = error instanceof Error ? error.message : "";
  if (message.includes("instance_public_hosts.hostname")) {
    return new RelayError("public_host_hostname_conflict", "This hostname is already an instance public Host", 409, { conflictKind: "public_host" });
  }
  if (message.includes("hostname conflicts with domain_bindings")) {
    return new RelayError("public_host_hostname_conflict", "This hostname is already reserved by a DomainBinding", 409, { conflictKind: "domain_binding" });
  }
  return error;
}
