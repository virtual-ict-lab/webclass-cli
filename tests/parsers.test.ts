import { describe, expect, test } from "bun:test";
import { ParseError } from "../src/errors.ts";
import { parseCourse } from "../src/parsers/course.ts";
import { parseCourseList } from "../src/parsers/courses.ts";
import { jstLocalToIso, unixToJst } from "../src/parsers/util.ts";
import { fixture } from "./helpers.ts";

describe("course list (index.php)", () => {
  const list = parseCourseList(fixture("index.html"));

  test("snapshot", () => {
    expect({ ...list, entryLinks: [...list.entryLinks] }).toMatchSnapshot();
  });
  test("extracts IDs, names, and schedule slots, merging duplicate courses", () => {
    expect(list.courses).toHaveLength(1);
    expect(list.courses[0]).toEqual({
      id: "00x_000001",
      name: "00x_サンプル科目A",
      schedule: [
        { day: "月曜日", weekday: 1, period: 5 },
        { day: "月曜日", weekday: 1, period: 6 },
        { day: "水曜日", weekday: 3, period: 7 },
      ],
    });
  });
  test("extracts the selected semester, including uppercase SELECTED", () => {
    expect(list.year).toBe("2026");
    expect(list.semester).toBe("2");
    expect(list.semester_label).toBe("後期");
  });
  test("preserves the original entry link href", () => {
    expect(list.entryLinks.get("00x_000001")).toBe("/webclass/course.php/00x_000001/login?acs_=00000000");
  });
});

describe("course page (course.php/{id}/)", () => {
  const page = parseCourse(fixture("course.html"));
  const all = page.folders.flatMap((f) => f.contents);
  const byId = (id: string) => all.find((c) => c.id === id)!;

  test("snapshot", () => expect(page).toMatchSnapshot());

  test("extracts the course and folders", () => {
    expect(page.course).toEqual({ id: "00x_000001", name: "00x_サンプル科目A" });
    expect(page.folders.map((f) => f.name)).toEqual(["講義資料", "小テスト", "試験", "サンプル演習"]);
    expect(page.folders.map((f) => f.contents.length)).toEqual([2, 3, 3, 1]);
  });
  test("treats end-date 0 as no deadline", () => {
    const c = byId("d0000000000000000000000000000002");
    expect(c.end_date).toBeNull();
    expect(c.available_from).toBeNull();
    expect(c.exec_count).toBe(2);
    expect(c.category).toBe("資料");
  });
  test("extracts deadlines and availability in JST", () => {
    const c = byId("d000000000000000000000000000000f");
    expect(c.end_date).toBe("2027-02-08T08:30:59+09:00");
    expect(c.available_from).toBe("2026-04-18T08:30:00+09:00");
    expect(c.available_until).toBe("2027-02-08T08:30:00+09:00");
    expect(c.category).toBe("自習");
  });
  test("extracts unit contents despite malformed </tr></tr> markup", () => {
    expect(byId("d0000000000000000000000000000011").unit_contents).toEqual([
      "ユニット内の設問A",
      "ユニット内の設問B",
      "ユニット内の設問C",
      "ユニット内の設問D",
    ]);
  });
  test("recognizes new and unpublished items without links", () => {
    const c = byId("d0000000000000000000000000000009");
    expect(c.is_new).toBe(true);
    expect(c.openable).toBe(false);
    expect(c.name).toBe("サンプル小テストB");
    expect(byId("d000000000000000000000000000000c").is_new).toBe(false);
  });
  test("excludes execution URLs (do_contents) and acs_ from output", () => {
    const s = JSON.stringify(page);
    expect(s).not.toContain("do_contents");
    expect(s).not.toContain("acs_");
  });
  test("throws ParseError for unrelated HTML", () => {
    expect(() => parseCourse("<html><body>hello</body></html>")).toThrow(ParseError);
  });
});

describe("date conversion", () => {
  test("unixToJst", () => expect(unixToJst(1796544059)).toBe("2026-12-06T17:00:59+09:00"));
  test("jstLocalToIso", () => {
    expect(jstLocalToIso("2026/4/5 8:30")).toBe("2026-04-05T08:30:00+09:00");
    expect(jstLocalToIso("bad")).toBeNull();
  });
});
