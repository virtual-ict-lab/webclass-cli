import { loadConfig, type Env } from "./config.ts";
import { isLoggedInPage, looksLikeLoginPage } from "./detect.ts";
import { CliError, ExitCode, NotLoggedInError, SessionExpiredError } from "./errors.ts";
import { WebClassClient, type ClientOptions, type Page } from "./http.ts";
import { parseCourse, type Content } from "./parsers/course.ts";
import { parseCourseList, type CourseListPage } from "./parsers/courses.ts";
import { resolveCookies, saveSession } from "./session.ts";

export function makeClient(env: Env = process.env, extra: Partial<ClientOptions> = {}): WebClassClient {
  const cfg = loadConfig(env);
  const resolved = resolveCookies(env);
  if (!resolved) throw new NotLoggedInError();
  return new WebClassClient({
    baseUrl: cfg.base_url,
    cookies: resolved.cookies,
    // Do not persist cookies supplied through an environment variable.
    onCookiesUpdated: resolved.source === "file" ? (jar) => saveSession(jar, env) : undefined,
    ...extra,
  });
}

function requireLoggedIn(page: Page): Page {
  if (!isLoggedInPage(page.body)) throw new SessionExpiredError({ reason: "No logout link found" });
  return page;
}

// ---- status ----

export interface StatusResult {
  logged_in: true;
  checked: string[];
  keep: { http_status: number; content_type: string; bytes: number };
}

export async function status(client: WebClassClient, opts: { deep?: boolean } = {}): Promise<StatusResult> {
  const keep = await client.get("session.php/keep");
  if (looksLikeLoginPage(keep.body)) throw new SessionExpiredError({ reason: "Received a login page" });
  const checked = ["session.php/keep"];
  if (opts.deep) {
    requireLoggedIn(await client.get("index.php"));
    checked.push("index.php");
  }
  return {
    logged_in: true,
    checked,
    keep: { http_status: keep.status, content_type: keep.contentType, bytes: Buffer.byteLength(keep.body) },
  };
}

// ---- courses ----

export interface TermOptions {
  year?: string;
  semester?: string;
}

/**
 * Fetch the course list. When year/semester is specified, submit the page's term form (GET)
 * using browser semantics: replace the action query with form values.
 */
export async function fetchCourseList(client: WebClassClient, term: TermOptions = {}): Promise<CourseListPage> {
  const top = requireLoggedIn(await client.get("index.php"));
  return switchTerm(client, { ...parseCourseList(top.body), pageUrl: top.url }, top.url, term);
}

/** Submit the term form from a fetched course list to retrieve a different term. */
async function switchTerm(
  client: WebClassClient,
  list: CourseListPage,
  pageUrl: URL,
  term: TermOptions,
): Promise<CourseListPage> {
  const wantYear = term.year ?? list.year ?? "all";
  const wantSem = term.semester ?? list.semester ?? "all";
  if (!(term.year || term.semester) || (wantYear === list.year && wantSem === list.semester)) return list;
  const action = new URL(list.formAction ?? "index.php", pageUrl);
  action.search = new URLSearchParams({ year: wantYear, semester: wantSem }).toString();
  const page = requireLoggedIn(await client.get(action));
  return { ...parseCourseList(page.body), pageUrl: page.url };
}

export function coursesResult(list: CourseListPage) {
  return {
    year: list.year,
    semester: list.semester,
    semester_label: list.semester_label,
    courses: list.courses,
  };
}

// ---- course ----

async function enterCourse(client: WebClassClient, list: CourseListPage, id: string) {
  const link = list.entryLinks.get(id);
  if (!link) return null;
  const page = requireLoggedIn(await client.get(link));
  const parsed = parseCourse(page.body);
  if (parsed.course.id && parsed.course.id !== id) {
    throw new CliError("UNEXPECTED_PAGE", `Received a page for a different course (${parsed.course.id})`, ExitCode.PARSE);
  }
  return parsed;
}

export async function course(client: WebClassClient, id: string, term: TermOptions = {}) {
  let list = await fetchCourseList(client, term);
  if (!list.entryLinks.has(id) && !term.year && !term.semester) {
    list = await switchTerm(client, list, list.pageUrl ?? client.resolve("index.php"), { year: "all", semester: "all" });
  }
  const parsed = await enterCourse(client, list, id);
  if (!parsed) {
    throw new CliError("COURSE_NOT_FOUND", `Course ${id} is not in the course list (check its ID with webclass courses)`, ExitCode.ERROR);
  }
  return { course: { id, name: parsed.course.name }, folders: parsed.folders };
}

// ---- deadlines ----

export interface DeadlineItem extends Content {
  course_id: string;
  course_name: string;
  folder_name: string;
  seconds_left: number;
}

export async function deadlines(
  client: WebClassClient,
  opts: TermOptions & { days: number; now?: number },
) {
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  const limit = now + opts.days * 86400;
  const list = await fetchCourseList(client, opts);
  const items: DeadlineItem[] = [];
  const errors: { course_id: string; code: string; message: string }[] = [];
  for (const c of list.courses) {
    try {
      const page = await enterCourse(client, list, c.id);
      if (!page) continue;
      for (const f of page.folders) {
        for (const ct of f.contents) {
          if (ct.end_date_unix === null || ct.end_date_unix < now || ct.end_date_unix > limit) continue;
          items.push({
            course_id: c.id,
            course_name: c.name,
            folder_name: f.name,
            ...ct,
            seconds_left: ct.end_date_unix - now,
          });
        }
      }
    } catch (e) {
      // Stop on expired sessions or policy violations; record other errors per course and continue.
      if (e instanceof CliError && (e.exitCode === ExitCode.SESSION || e.exitCode === ExitCode.BLOCKED)) throw e;
      errors.push({
        course_id: c.id,
        code: e instanceof CliError ? e.code : "ERROR",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  items.sort((a, b) => a.end_date_unix! - b.end_date_unix! || a.course_id.localeCompare(b.course_id));
  return {
    generated_at: new Date(now * 1000).toISOString(),
    days: opts.days,
    year: list.year,
    semester: list.semester,
    courses_scanned: list.courses.length,
    items,
    errors,
  };
}
