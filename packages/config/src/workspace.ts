import { accessSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  defaultConfigFileName,
  loadConfig,
  loadConfigSync,
  type AppConfig
} from "./index.js";

export async function loadWorkspaceConfig(path = process.env.FRIDAY_RELAY_CONFIG): Promise<AppConfig> {
  return loadConfig(path ?? await findWorkspaceConfigPath());
}

export function loadWorkspaceConfigSync(path = process.env.FRIDAY_RELAY_CONFIG): AppConfig {
  return loadConfigSync(path ?? findWorkspaceConfigPathSync());
}

async function findWorkspaceConfigPath(): Promise<string> {
  let directory = process.cwd();
  while (true) {
    const candidate = resolve(directory, "data", defaultConfigFileName);
    try {
      await access(candidate);
      return candidate;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return resolve(process.cwd(), "data", defaultConfigFileName);
      directory = parent;
    }
  }
}

function findWorkspaceConfigPathSync(): string {
  let directory = process.cwd();
  while (true) {
    const candidate = resolve(directory, "data", defaultConfigFileName);
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return resolve(process.cwd(), "data", defaultConfigFileName);
      directory = parent;
    }
  }
}
