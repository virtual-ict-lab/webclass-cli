import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { type Env, stateDir } from "./config.ts";
import { UsageError } from "./errors.ts";

export type CookieJar = Record<string, string>;

export interface Session {
  cookies: CookieJar;
  saved_at: string;
  identity?: string;
}

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Parse a cookie string pasted by the user.
 * Accept `name=value; name2=value2` (the Cookie header value from DevTools), ignoring an optional leading `Cookie:`.
 * Never include cookie values in error messages.
 */
export function parseCookieInput(raw: string): CookieJar {
  let s = raw.trim();
  s = s.replace(/^cookie\s*:\s*/i, "");
  const jar: CookieJar = {};
  for (const part of s.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq <= 0) {
      throw new UsageError("Provide cookies as `name=value; name2=value2` by pasting the Cookie header value");
    }
    const name = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    if (!COOKIE_NAME.test(name)) throw new UsageError("Cookie name contains invalid characters");
    if (/[\r\n]/.test(value)) throw new UsageError("Cookie values cannot contain line breaks");
    jar[name] = value;
  }
  if (Object.keys(jar).length === 0) throw new UsageError("Cookie input is empty");
  return jar;
}

export function serializeCookies(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

/** Match legacy attempt identities when migrating a saved session. */
export function cookieFingerprint(cookies: CookieJar): string {
  return createHash("sha256").update(cookies.WBT_Session ?? serializeCookies(cookies)).digest("hex");
}

function sessionIdentity(session: Session): string {
  return typeof session.identity === "string" && /^[a-f0-9]{64}$/.test(session.identity)
    ? session.identity : cookieFingerprint(session.cookies);
}

export function sessionPath(env: Env = process.env): string {
  return join(stateDir(env), "session.json");
}

export function saveSession(cookies: CookieJar, env: Env = process.env, now = new Date()): string {
  return withSessionLock(env, () => writeSession(cookies, cookieFingerprint(cookies), env, now));
}

/** Serialize every credential change, including the comparison before a server cookie update. */
function withSessionLock<T>(env: Env, operation: () => T): T {
  const dir = stateDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "session.lock");
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new UsageError(`Another session update is running. Retry after it finishes. After a crash, confirm the owning process has stopped before removing ${lock}`);
  }
  try {
    writeFileSync(fd, String(process.pid));
    return operation();
  } finally {
    try { closeSync(fd); } finally { rmSync(lock); }
  }
}

/** Caller must hold the session lock. */
function writeSession(cookies: CookieJar, identity: string, env: Env, now = new Date()): string {
  const path = sessionPath(env);
  const tmp = `${path}.${process.pid}.tmp`;
  const data: Session = { cookies, identity, saved_at: now.toISOString() };
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
  return path;
}

/** Preserve identity only for server updates to the session this client loaded. */
export function updateSessionCookies(cookies: CookieJar, expected: { cookies: CookieJar; identity: string }, env: Env): string {
  return withSessionLock(env, () => {
    const current = loadSession(env);
    const canonical = (jar: CookieJar) => JSON.stringify(Object.entries(jar).sort(([a], [b]) => a.localeCompare(b)));
    if (!current || sessionIdentity(current) !== expected.identity || canonical(current.cookies) !== canonical(expected.cookies)) {
      throw new UsageError("The saved session changed while this client was running; reload it before continuing");
    }
    const identity = cookies.WBT_Session ? expected.identity : cookieFingerprint(cookies);
    writeSession(cookies, identity, env);
    return identity;
  });
}

export function loadSession(env: Env = process.env): Session | null {
  const path = sessionPath(env);
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Session;
    if (!data || typeof data.cookies !== "object" || Object.keys(data.cookies).length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

export function clearSession(env: Env = process.env): boolean {
  return withSessionLock(env, () => {
    const path = sessionPath(env);
    if (!existsSync(path)) return false;
    rmSync(path);
    return true;
  });
}

export interface ResolvedCookies {
  cookies: CookieJar;
  source: "env" | "file";
  identity?: string;
}

/** Prefer WEBCLASS_COOKIE when set; otherwise use the saved session. */
export function resolveCookies(env: Env = process.env): ResolvedCookies | null {
  if (env.WEBCLASS_COOKIE && env.WEBCLASS_COOKIE.trim()) {
    return { cookies: parseCookieInput(env.WEBCLASS_COOKIE), source: "env" };
  }
  const s = loadSession(env);
  return s ? { cookies: s.cookies, source: "file", identity: sessionIdentity(s) } : null;
}
