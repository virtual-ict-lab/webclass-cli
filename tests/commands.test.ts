import { describe, expect, test } from "bun:test";
import * as cmd from "../src/commands.ts";
import { SessionExpiredError } from "../src/errors.ts";
import { fixture, html, redirect, testClient } from "./helpers.ts";

/** Mock the observed server flow: course.php/{id}/login -> (200 + JS redirect) -> course.php/{id}/?acs_= */
function server(overrides: Record<string, () => Response> = {}) {
  return (u: URL) => {
    const key = u.pathname + u.search;
    for (const [k, f] of Object.entries(overrides)) if (key.startsWith(k)) return f();
    if (u.pathname === "/webclass/index.php") return html(fixture("index.html"));
    if (u.pathname === "/webclass/course.php/00x_000001/login") return html(fixture("course-login-jump.html"));
    if (u.pathname === "/webclass/course.php/00x_000001/") return html(fixture("course.html"));
    return undefined;
  };
}
const paths = (calls: { url: string }[]) => calls.map((c) => {
  const u = new URL(c.url);
  return u.pathname + u.search;
});

describe("courses", () => {
  test("fetches only the index for the default semester", async () => {
    const { client, calls } = testClient(server());
    const r = cmd.coursesResult(await cmd.fetchCourseList(client));
    expect(r.courses.map((c) => c.id)).toEqual(["00x_000001"]);
    expect(paths(calls)).toEqual(["/webclass/index.php"]);
  });
  test("submits semester selection using GET form rules, discarding acs_ from the action", async () => {
    const { client, calls } = testClient(server());
    await cmd.fetchCourseList(client, { year: "2025", semester: "1" });
    expect(paths(calls)).toEqual(["/webclass/index.php", "/webclass/index.php?year=2025&semester=1"]);
  });
  test("returns SESSION_EXPIRED for a page without a logout link", async () => {
    const { client } = testClient(() => html("<html><body>Welcome</body></html>"));
    await expect(cmd.fetchCourseList(client)).rejects.toBeInstanceOf(SessionExpiredError);
  });
});

describe("course", () => {
  test("follows the index entry link and parses the course page", async () => {
    const { client, calls } = testClient(server());
    const r = await cmd.course(client, "00x_000001");
    expect(r.course.name).toBe("00x_サンプル科目A");
    expect(r.folders).toHaveLength(4);
    expect(paths(calls)).toEqual([
      "/webclass/index.php",
      "/webclass/course.php/00x_000001/login?acs_=00000000",
      "/webclass/course.php/00x_000001/?acs_=00000000",
    ]);
  });
  test("searches all semesters before returning COURSE_NOT_FOUND", async () => {
    const { client, calls } = testClient(server());
    const err = await cmd.course(client, "nope").catch((e) => e);
    expect(err.code).toBe("COURSE_NOT_FOUND");
    expect(paths(calls)).toEqual(["/webclass/index.php", "/webclass/index.php?year=all&semester=all"]);
  });
});

describe("deadlines", () => {
  // 2026-11-09 12:00 JST
  const now = Date.parse("2026-11-09T12:00:00+09:00");

  test("returns deadlines within the requested period in ascending order", async () => {
    const { client } = testClient(server());
    const r = await cmd.deadlines(client, { days: 30, now });
    expect(r.items.map((i) => [i.name, i.end_date])).toEqual([["期限付きのサンプル資料", "2026-12-06T17:00:59+09:00"]]);
    expect(r.items[0]!.course_id).toBe("00x_000001");
    expect(r.items[0]!.folder_name).toBe("試験");
    expect(r.errors).toEqual([]);
  });
  test("excludes expired items and items without deadlines", async () => {
    const { client } = testClient(server());
    const r = await cmd.deadlines(client, { days: 365, now });
    const names = r.items.map((i) => i.name);
    expect(names).not.toContain("期限切れのサンプル資料"); // Ended on 2026-10-31
    expect(names).not.toContain("サンプル資料A"); // No deadline
    const ends = r.items.map((i) => i.end_date_unix!);
    expect(ends).toEqual([...ends].sort((a, b) => a - b));
    expect(names.at(-1)).toBe("サンプル添付資料");
  });
  test("aborts the entire operation if the session expires", async () => {
    const { client } = testClient(
      server({ "/webclass/course.php/00x_000001/login": () => redirect("/webclass/login.php") }),
    );
    await expect(cmd.deadlines(client, { days: 7, now })).rejects.toBeInstanceOf(SessionExpiredError);
  });
  test("records a course parsing failure in errors and continues", async () => {
    const { client } = testClient(server({ "/webclass/course.php/00x_000001/": () => html('<a href="/webclass/logout.php">x</a>') }));
    const r = await cmd.deadlines(client, { days: 7, now });
    expect(r.errors.map((e) => e.code)).toEqual(["PARSE_ERROR"]);
  });
});
