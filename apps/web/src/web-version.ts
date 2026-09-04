declare const __FRIDAY_RELAY_WEB_VERSION__: string;

export const WEB_VERSION = typeof __FRIDAY_RELAY_WEB_VERSION__ === "string"
  ? __FRIDAY_RELAY_WEB_VERSION__
  : process.env.FRIDAY_RELAY_WEB_VERSION ?? "unknown";
