import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { UsageError } from "../src/errors.ts";
import { clearSession, loadSession, parseCookieInput, resolveCookies, saveSession, serializeCookies } from "../src/session.ts";

let dir: string;
let env: Record<string, string | undefined>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wc-test-"));
  env = { XDG_STATE_HOME: join(dir, "state"), XDG_CONFIG_HOME: join(dir, "config") };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("parseCookieInput", () => {
  test("parses Cookie header syntax", () => {
    expect(parseCookieInput("A=1; B=x=y ;C=")).toEqual({ A: "1", B: "x=y", C: "" });
    expect(parseCookieInput("Cookie: A=1")).toEqual({ A: "1" });
  });
  test("rejects invalid syntax without including values in errors", () => {
    for (const bad of ["", "justavalue-SECRET", "=v", "a b=c"]) {
      const e = (() => {
        try {
          parseCookieInput(bad);
        } catch (err) {
          return err as Error;
        }
      })();
      expect(e).toBeInstanceOf(UsageError);
      expect(e!.message).not.toContain("SECRET");
    }
  });
  test("serialize", () => expect(serializeCookies({ A: "1", B: "2" })).toBe("A=1; B=2"));
});

describe("session storage (XDG)", () => {
  test("saves to $XDG_STATE_HOME/webclass/session.json with mode 0600", () => {
    const path = saveSession({ S: "v" }, env);
    expect(path).toBe(join(dir, "state", "webclass", "session.json"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "state", "webclass")).mode & 0o777).toBe(0o700);
    expect(loadSession(env)?.cookies).toEqual({ S: "v" });
  });
  test("preserves mode 0600 when overwriting", () => {
    saveSession({ S: "1" }, env);
    const path = saveSession({ S: "2" }, env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  test("gives WEBCLASS_COOKIE precedence over saved cookies", () => {
    saveSession({ S: "file" }, env);
    expect(resolveCookies(env)).toEqual({ cookies: { S: "file" }, source: "file", identity: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(resolveCookies({ ...env, WEBCLASS_COOKIE: "S=env" })).toEqual({ cookies: { S: "env" }, source: "env" });
  });
  test("clear", () => {
    saveSession({ S: "1" }, env);
    expect(clearSession(env)).toBe(true);
    expect(loadSession(env)).toBeNull();
    expect(clearSession(env)).toBe(false);
  });
});

describe("config", () => {
  test("uses the default base URL", () => expect(loadConfig(env).base_url).toBe("https://webclass.kosen-k.go.jp/webclass/"));
  test("loads base_url from config.toml", async () => {
    await Bun.write(join(dir, "config", "webclass", "config.toml"), 'base_url = "https://wc.example.jp/webclass"\n');
    expect(loadConfig(env).base_url).toBe("https://wc.example.jp/webclass/");
  });
  test("rejects HTTP URLs", () => {
    expect(() => loadConfig({ ...env, WEBCLASS_BASE_URL: "http://wc.example.jp/webclass/" })).toThrow(UsageError);
  });
});
