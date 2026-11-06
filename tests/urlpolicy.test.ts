import { describe, expect, test } from "bun:test";
import { BlockedUrlError } from "../src/errors.ts";
import { assertAllowed, checkUrl } from "../src/urlpolicy.ts";
import { BASE, fixture, html, redirect, testClient } from "./helpers.ts";

const base = new URL(BASE);
const ok = (p: string) => checkUrl(new URL(p, base), base).ok;

describe("denylist", () => {
  const denied = [
    "/webclass/logout.php",
    "/webclass/logout.php?acs_=1a2b3c4d",
    "/webclass/course.php/00x_000001/logout",
    "/webclass/course.php/00x_000001/logout?acs_=5e6f7a8b",
    "/webclass/do_contents.php?reset_status=1&set_contents_id=d0000000000000000000000000000002",
    "/webclass/do_contents.php",
    "/webclass/show_frame.php?set_contents_id=x",
    "/webclass/show_info.php",
    "/webclass/reslt_frame.php?acs_=5e6f7a8b",
    // Bypass attempts
    "/webclass/LOGOUT.php",
    "/webclass/%6Cogout.php",
    "/webclass/%256Cogout.php",
    "/webclass//logout.php",
    "/webclass/index.php/../logout.php",
    "/webclass/index.php/%2e%2e/logout.php",
    "/webclass/Do_Contents.php",
    "/webclass/course.php/00x_000001/LogOut",
    // Reject side-effect parameters even on allowed paths
    "/webclass/index.php?set_contents_id=abc",
    "/webclass/course.php/x/?reset_status=1",
  ];
  for (const p of denied) {
    test(`denied: ${p}`, () => {
      const r = checkUrl(new URL(p, base), base);
      expect(r.ok).toBe(false);
      expect(() => assertAllowed(new URL(p, base), base)).toThrow(BlockedUrlError);
    });
  }
});

describe("allowlist", () => {
  for (const p of [
    "/webclass/",
    "/webclass/index.php",
    "/webclass/index.php/?acs_=1a2b3c4d",
    "/webclass/index.php?year=2026&semester=2",
    "/webclass/session.php/keep",
    "/webclass/course.php/00x_000001/login?acs_=1a2b3c4d",
    "/webclass/course.php/00x_000001/",
    "/webclass/information.php/?acs_=1a2b3c4d",
    "/webclass/information.php/course/00x_000001/",
    "/webclass/messages.php/inbox?acs_=1a2b3c4d",
    "/webclass/messages.php/course/00x_000001/inbox",
  ]) {
    test(`allowed: ${p}`, () => expect(ok(p)).toBe(true));
  }

  for (const p of [
    "/webclass/user.php/config",
    "/webclass/login.php?top_menu=1",
    "/webclass/course.php/00x_000001/contents/abc/",
    "/webclass/scormResultView.php",
    "/other/index.php",
    "https://evil.example.com/webclass/index.php",
    "http://webclass.example.test/webclass/index.php",
  ]) {
    test(`outside the allowlist: ${p}`, () => expect(ok(p)).toBe(false));
  }
});

describe("client enforces the denylist before network requests", () => {
  test("does not fetch denied URLs", async () => {
    const { client, calls } = testClient(() => html("x"));
    await expect(client.get("logout.php")).rejects.toBeInstanceOf(BlockedUrlError);
    await expect(client.get("/webclass/do_contents.php?reset_status=1")).rejects.toBeInstanceOf(BlockedUrlError);
    expect(calls.length).toBe(0);
  });

  test("does not follow redirects to denied URLs", async () => {
    const { client, calls } = testClient((u) =>
      u.pathname === "/webclass/index.php" ? redirect("/webclass/logout.php") : html("x"),
    );
    await expect(client.get("index.php")).rejects.toBeInstanceOf(BlockedUrlError);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/webclass/index.php"]);
  });

  test("rejects every dangerous link in the fixture", () => {
    const hrefs = [...fixture("course.html").matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
    const dangerous = hrefs.filter((h) => /logout|do_contents|_frame\.php/.test(h));
    expect(dangerous.length).toBeGreaterThan(0);
    for (const h of dangerous) expect(ok(h.replace(/&amp;/g, "&"))).toBe(false);
  });
});
