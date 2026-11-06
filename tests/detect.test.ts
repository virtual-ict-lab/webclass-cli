import { describe, expect, test } from "bun:test";
import * as cmd from "../src/commands.ts";
import { hasLogoutLink, isLoggedInPage, looksLikeLoginPage } from "../src/detect.ts";
import { SessionExpiredError } from "../src/errors.ts";
import { fixture, html, testClient } from "./helpers.ts";

describe("login state detection from HTML", () => {
  test("recognizes the course list as logged in", () => {
    expect(hasLogoutLink(fixture("index.html"))).toBe(true);
    expect(isLoggedInPage(fixture("index.html"))).toBe(true);
  });
  test("recognizes course pages as logged in using logout.php instead of course.php/*/logout", () => {
    expect(isLoggedInPage(fixture("course.html"))).toBe(true);
  });
  test("recognizes login pages as logged out", () => {
    expect(looksLikeLoginPage(fixture("login-page.synthetic.html"))).toBe(true);
    expect(isLoggedInPage(fixture("login-page.synthetic.html"))).toBe(false);
  });
  test("recognizes the observed HTTP 200 PageJump to login.php as logged out", () => {
    expect(looksLikeLoginPage(fixture("pagejump-expired.html"))).toBe(true);
    expect(isLoggedInPage(fixture("pagejump-expired.html"))).toBe(false);
  });
  test("does not mistake the course-list link (login.php?top_menu=1) for a login page", () => {
    expect(looksLikeLoginPage(fixture("index.html"))).toBe(false);
  });
  test("does not treat a page with only course.php/*/logout as logged in", () => {
    expect(hasLogoutLink('<a href="/webclass/course.php/x/logout">x</a>')).toBe(false);
  });
});

describe("status", () => {
  test("reports logged in when keep succeeds", async () => {
    const { client, calls } = testClient(() => html("", 200));
    const r = await cmd.status(client);
    expect(r.logged_in).toBe(true);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/webclass/session.php/keep"]);
  });
  test("returns SESSION_EXPIRED when keep returns an HTTP 200 PageJump", async () => {
    const { client } = testClient(() => html(fixture("pagejump-expired.html")));
    const err = await cmd.status(client).catch((e) => e);
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect(err.exitCode).toBe(3);
  });
  test("returns SESSION_EXPIRED when keep returns a login page", async () => {
    const { client } = testClient(() => html(fixture("login-page.synthetic.html")));
    await expect(cmd.status(client)).rejects.toBeInstanceOf(SessionExpiredError);
  });
  test("--deep returns SESSION_EXPIRED when index.php has no logout link", async () => {
    const { client } = testClient((u) => (u.pathname.endsWith("keep") ? html("") : html("<p>no</p>")));
    await expect(cmd.status(client, { deep: true })).rejects.toBeInstanceOf(SessionExpiredError);
  });
  test("--deep succeeds when the course list is returned", async () => {
    const { client } = testClient((u) => (u.pathname.endsWith("keep") ? html("") : html(fixture("index.html"))));
    expect((await cmd.status(client, { deep: true })).checked).toEqual(["session.php/keep", "index.php"]);
  });
});
