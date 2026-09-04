declare const __FRIDAY_RELAY_ADMIN_VERSION__: string;

export const ADMIN_VERSION = typeof __FRIDAY_RELAY_ADMIN_VERSION__ === "string"
  ? __FRIDAY_RELAY_ADMIN_VERSION__
  : process.env.FRIDAY_RELAY_ADMIN_VERSION ?? "unknown";
