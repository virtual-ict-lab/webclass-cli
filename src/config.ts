import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError } from "./errors.ts";

export type Env = Record<string, string | undefined>;

export const DEFAULT_BASE_URL = "https://webclass.kosen-k.go.jp/webclass/";

export function configDir(env: Env = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "webclass");
}

export function stateDir(env: Env = process.env): string {
  return join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "webclass");
}

export interface Config {
  base_url: string;
}

/** Validate and normalize base_url with a trailing slash; require HTTPS except for localhost HTTP in tests. */
export function normalizeBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new UsageError(`Invalid base_url: ${raw}`);
  }
  const isLocal = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(isLocal && u.protocol === "http:")) {
    throw new UsageError("base_url must start with https://");
  }
  u.search = "";
  u.hash = "";
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  return u.href;
}

export function loadConfig(env: Env = process.env): Config {
  const path = join(configDir(env), "config.toml");
  let base = DEFAULT_BASE_URL;
  if (existsSync(path)) {
    const parsed = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof parsed.base_url === "string") base = parsed.base_url;
  }
  if (env.WEBCLASS_BASE_URL) base = env.WEBCLASS_BASE_URL;
  return { base_url: normalizeBaseUrl(base) };
}
