import { parse } from "node-html-parser";
import { cleanText, text } from "./util.ts";

export interface ScheduleSlot {
  /** Weekday label exactly as shown in the table header. */
  day: string;
  /** 0=Sunday, 1=Monday, ..., 6=Saturday; null if unrecognized. */
  weekday: number | null;
  /** Class period, starting at 1. */
  period: number;
}

export interface CourseSummary {
  id: string;
  name: string;
  schedule: ScheduleSlot[];
}

export interface CourseListPage {
  year: string | null;
  semester: string | null;
  semester_label: string | null;
  years_available: string[];
  courses: CourseSummary[];
  /** ID -> entry link, preserving the HTML href; do not expose it because it contains acs_. */
  entryLinks: Map<string, string>;
  /** Action URL of the term selection GET form. */
  formAction: string | null;
  /** Source URL, set by the command layer. */
  pageUrl?: URL;
}

const WEEKDAYS: Record<string, number> = { 日: 0, 月: 1, 火: 2, 水: 3, 木: 4, 金: 5, 土: 6 };
const COURSE_LINK = /\/course\.php\/([^/?#]+)\/login(?:[?#]|$)/;

function weekdayOf(label: string): number | null {
  const c = label.trim().charAt(0);
  return c in WEEKDAYS ? WEEKDAYS[c]! : null;
}

function courseName(raw: string): string {
  return cleanText(raw).replace(/^»\s*/, "");
}

export function parseCourseList(html: string): CourseListPage {
  const root = parse(html);
  const courses = new Map<string, CourseSummary>();
  const entryLinks = new Map<string, string>();

  const ensure = (id: string, name: string, href: string): CourseSummary => {
    let c = courses.get(id);
    if (!c) {
      c = { id, name, schedule: [] };
      courses.set(id, c);
    }
    if (!entryLinks.has(id)) entryLinks.set(id, href);
    return c;
  };

  // Timetable.
  const table = root.querySelector("#schedule-table");
  if (table) {
    const days = table.querySelectorAll("thead th").slice(1).map((th) => text(th));
    for (const tr of table.querySelectorAll("tbody tr")) {
      const cells = tr.childNodes.filter(
        (n): n is import("node-html-parser").HTMLElement =>
          "tagName" in n && /^t[dh]$/i.test((n as { tagName?: string }).tagName ?? ""),
      );
      const periodAttr = tr.getAttribute("data-class_order");
      const period = Number(periodAttr ?? text(cells[0]).replace(/\D/g, ""));
      cells.slice(1).forEach((td, i) => {
        for (const a of td.querySelectorAll("a[href]")) {
          const href = a.getAttribute("href") ?? "";
          const m = href.match(COURSE_LINK);
          if (!m) continue;
          const day = days[i] ?? "";
          const c = ensure(m[1]!, courseName(a.textContent), href);
          if (!c.schedule.some((s) => s.day === day && s.period === period)) {
            c.schedule.push({ day, weekday: weekdayOf(day), period });
          }
        }
      });
    }
  }

  // Also collect courses outside the timetable, such as list entries.
  for (const a of root.querySelectorAll('a[href*="/course.php/"]')) {
    const href = a.getAttribute("href") ?? "";
    const m = href.match(COURSE_LINK);
    if (!m) continue;
    const heading = a.querySelector("h4");
    ensure(m[1]!, courseName(heading ? heading.textContent : a.textContent), href);
  }

  const yearSel = root.querySelector('select[name="year"]');
  const semSel = root.querySelector('select[name="semester"]');
  const selected = (sel: typeof yearSel) =>
    sel?.querySelectorAll("option").find((o) => o.hasAttribute("selected")) ?? null;
  const yearOpt = selected(yearSel);
  const semOpt = selected(semSel);

  return {
    year: yearOpt?.getAttribute("value") ?? null,
    semester: semOpt?.getAttribute("value") ?? null,
    semester_label: semOpt ? text(semOpt) : null,
    years_available: (yearSel?.querySelectorAll("option") ?? [])
      .map((o) => o.getAttribute("value") ?? "")
      .filter((v) => /^\d{4}$/.test(v)),
    courses: [...courses.values()].map((c) => ({
      ...c,
      schedule: c.schedule.sort((a, b) => (a.weekday ?? 9) - (b.weekday ?? 9) || a.period - b.period),
    })),
    entryLinks,
    formAction: root.querySelector('form[name="condition"]')?.getAttribute("action") ?? null,
  };
}
