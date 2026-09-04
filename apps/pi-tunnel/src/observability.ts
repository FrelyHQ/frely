export type PiTunnelRole = "activation" | "client" | "node" | "service";
export type PiTunnelLogAction = "activate" | "authorize" | "close" | "connect" | "listen" | "reject";
export type PiTunnelLogResult = "allowed" | "denied" | "failed" | "success";

export interface PiTunnelSafeLog {
  readonly event: "pi_tunnel.lifecycle";
  readonly role: PiTunnelRole;
  readonly action: PiTunnelLogAction;
  readonly result: PiTunnelLogResult;
  readonly errorCode?: string;
  readonly closeCode?: number;
  readonly bytes?: number;
}

export type PiTunnelLogger = (entry: PiTunnelSafeLog) => void;

export class PiTunnelMetrics {
  private readonly counters = {
    activationAllowed: 0,
    activationDenied: 0,
    nodeConnections: 0,
    clientConnections: 0,
    authorizationAllowed: 0,
    authorizationDenied: 0,
    opaqueBytesForwarded: 0,
    protocolRejections: 0,
    connectionRejections: 0,
    backpressureRejections: 0,
  };

  increment(name: Exclude<keyof typeof this.counters, "opaqueBytesForwarded">): void {
    this.counters[name] += 1;
  }

  addOpaqueBytes(bytes: number): void {
    this.counters.opaqueBytesForwarded += bytes;
  }

  snapshot(): Readonly<{
    activation_allowed: number;
    activation_denied: number;
    node_connections: number;
    client_connections: number;
    authorization_allowed: number;
    authorization_denied: number;
    opaque_bytes_forwarded: number;
    protocol_rejections: number;
    connection_rejections: number;
    backpressure_rejections: number;
  }> {
    return {
      activation_allowed: this.counters.activationAllowed,
      activation_denied: this.counters.activationDenied,
      node_connections: this.counters.nodeConnections,
      client_connections: this.counters.clientConnections,
      authorization_allowed: this.counters.authorizationAllowed,
      authorization_denied: this.counters.authorizationDenied,
      opaque_bytes_forwarded: this.counters.opaqueBytesForwarded,
      protocol_rejections: this.counters.protocolRejections,
      connection_rejections: this.counters.connectionRejections,
      backpressure_rejections: this.counters.backpressureRejections,
    };
  }
}

export const defaultPiTunnelLogger: PiTunnelLogger = (entry) => {
  console.log(JSON.stringify(entry));
};
