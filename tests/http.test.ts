import { describe, expect, test } from "bun:test";
import { HttpError, SessionExpiredError } from "../src/errors.ts";
import { USER_AGENT, WebClassClient, jsJumpTarget } from "../src/http.ts";
import { BlockedUrlError } from "../src/errors.ts";
import { BASE, fixture, html, redirect, testClient } from "./helpers.ts";

describe("WebClassClient", () => {
  test("uses GET, manual redirects, a dedicated user agent, and cookies", async () => {
    const { client, calls } = testClient(() => html("ok"));
    await client.get("session.php/keep");
    const init = calls[0]!.init;
    expect(init.method).toBe("GET");
    expect(init.redirect).toBe("manual");
    const h = init.headers as Record<string, string>;
    expect(h["User-Agent"]).toBe(USER_AGENT);
    expect(h["User-Agent"]).toStartWith("webclass-cli/");
    expect(h.Cookie).toBe("WBT_Session=SECRET-COOKIE-VALUE");
  });

  test("does not expose unnecessary HTTP methods", () => {
    const proto = Object.getOwnPropertyNames(WebClassClient.prototype);
    for (const m of ["put", "delete", "patch", "request"]) expect(proto).not.toContain(m);
  });

  test("enforces at least one second between requests even with a smaller minIntervalMs", async () => {
    let clock = 0;
    const starts: number[] = [];
    const client = new WebClassClient({
      baseUrl: BASE,
      cookies: { a: "b" },
      minIntervalMs: 10,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      fetch: async () => {
        starts.push(clock);
        clock += 200; // The response takes 200 ms
        return html("ok");
      },
    });
    await Promise.all([client.get("index.php"), client.get("index.php"), client.get("index.php")]);
    expect(starts.length).toBe(3);
    for (let i = 1; i < starts.length; i++) {
      // Wait at least 1000 ms after the previous request completes (start + 200)
      expect(starts[i]! - (starts[i - 1]! + 200)).toBeGreaterThanOrEqual(1000);
    }
  });

  test("serializes concurrent calls", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const client = new WebClassClient({
      baseUrl: BASE,
      cookies: { a: "b" },
      sleep: async () => {},
      fetch: async () => {
        inflight++;
        maxInflight = Math.max(maxInflight, inflight);
        await Bun.sleep(1);
        inflight--;
        return html("ok");
      },
    });
    await Promise.all([1, 2, 3, 4].map(() => client.get("index.php")));
    expect(maxInflight).toBe(1);
  });

  test("retries 5xx responses at most twice, for three total attempts", async () => {
    const { client, calls } = testClient(() => html("err", 503));
    await expect(client.get("index.php")).rejects.toBeInstanceOf(HttpError);
    expect(calls.length).toBe(3);
  });

  test("retries network errors at most twice and excludes cookies from errors", async () => {
    const { client, calls } = testClient(() => {
      throw new Error("connect failed SECRET-COOKIE-VALUE");
    });
    const err = await client.get("index.php?acs_=deadbeef").catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(calls.length).toBe(3);
    const text = JSON.stringify(err.toJSON()) + err.message;
    expect(text).not.toContain("SECRET-COOKIE-VALUE");
    expect(text).not.toContain("deadbeef");
  });

  test("does not retry 4xx responses", async () => {
    const { client, calls } = testClient(() => html("nf", 404));
    await expect(client.get("index.php")).rejects.toBeInstanceOf(HttpError);
    expect(calls.length).toBe(1);
  });

  test("follows redirects within the allowlist", async () => {
    const { client, calls } = testClient((u) =>
      u.pathname.endsWith("/login") ? redirect("/webclass/course.php/00x_1/") : html("course"),
    );
    const page = await client.get("course.php/00x_1/login?acs_=1");
    expect(page.url.pathname).toBe("/webclass/course.php/00x_1/");
    expect(calls.length).toBe(2);
  });

  test("uses updated Set-Cookie values on subsequent requests and invokes the callback", async () => {
    let updated: Record<string, string> | null = null;
    let n = 0;
    const seen: string[] = [];
    const client = new WebClassClient({
      baseUrl: BASE,
      cookies: { S: "old" },
      sleep: async () => {},
      onCookiesUpdated: (j) => (updated = j),
      fetch: async (_u, init) => {
        seen.push((init.headers as Record<string, string>).Cookie!);
        return n++ === 0 ? html("ok", 200, { "set-cookie": "S=new; path=/; HttpOnly" }) : html("ok");
      },
    });
    await client.get("index.php");
    await client.get("index.php");
    expect(seen).toEqual(["S=old", "S=new"]);
    expect(updated!).toEqual({ S: "new" });
  });
});

describe("session expiration detection through redirects", () => {
  for (const [label, loc] of [
    ["login.php", "/webclass/login.php?auth=1"],
    ["Microsoft IdP", "https://login.microsoftonline.com/xxx/saml2"],
    ["Shibboleth", "/Shibboleth.sso/Login"],
  ] as const) {
    test(`redirect to ${label} returns SESSION_EXPIRED (exit 3)`, async () => {
      const { client, calls } = testClient(() => redirect(loc));
      const err = await client.get("index.php").catch((e) => e);
      expect(err).toBeInstanceOf(SessionExpiredError);
      expect(err.exitCode).toBe(3);
      expect(calls.length).toBe(1); // Do not visit the login page or IdP, or forward cookies to them
    });
  }

  test("401 → SESSION_EXPIRED", async () => {
    const { client } = testClient(() => html("", 401));
    await expect(client.get("index.php")).rejects.toBeInstanceOf(SessionExpiredError);
  });
});

describe("JavaScript redirect pages observed on the server", () => {
  test("follows JavaScript redirects from course.php/{id}/login", async () => {
    const { client, calls } = testClient((u) =>
      u.pathname.endsWith("/login") ? html(fixture("course-login-jump.html")) : html("<html>course</html>"),
    );
    const page = await client.get("course.php/00x_000001/login?acs_=1");
    expect(page.url.pathname).toBe("/webclass/course.php/00x_000001/");
    expect(page.url.searchParams.get("acs_")).toBe("00000000");
    expect(calls.length).toBe(2);
  });
  test("returns SESSION_EXPIRED for a PageJump to login.php without visiting it", async () => {
    const { client, calls } = testClient(() => html(fixture("pagejump-expired.html")));
    await expect(client.get("index.php")).rejects.toBeInstanceOf(SessionExpiredError);
    expect(calls.length).toBe(1);
  });
  test("applies the URL policy to JavaScript redirect targets", async () => {
    const { client, calls } = testClient(() => html('<script>window.location.href="/webclass/logout.php"</script>'));
    await expect(client.get("index.php")).rejects.toBeInstanceOf(BlockedUrlError);
    expect(calls.length).toBe(1);
  });
  test("ignores location assignments inside larger regular pages", () => {
    expect(jsJumpTarget(fixture("course.html"))).toBeNull();
    expect(jsJumpTarget(fixture("index.html"))).toBeNull();
  });
});
