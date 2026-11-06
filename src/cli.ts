#!/usr/bin/env bun
import { materialsCommand } from "./materials-cli.ts";
import { learningCommand } from "./learning-cli.ts";
import { parseArgs } from "node:util";
import * as cmd from "./commands.ts";
import { CliError, ExitCode, UsageError } from "./errors.ts";
import { clearSession, parseCookieInput, saveSession, sessionPath } from "./session.ts";
import { VERSION } from "./version.ts";

const HELP = `webclass ${VERSION} — KOSEN WebClass CLI

Usage: webclass <command> [options]

Commands:
  materials                                        List and download course materials
  quiz / report                                    Quizzes and report submissions (see --help)
  login [--cookie <value> | --stdin] [--no-verify]    Save cookies (default: WEBCLASS_COOKIE)
  forget                                           Remove the saved local session
  status [--deep]                                   Check the session
  courses [--year 2026|all] [--semester 1|2|3|all]     List courses
  course <id> [--year ...] [--semester ...]          List course folders and contents
  deadlines [--days N] [--year ...] [--semester ...]  List upcoming deadlines in order

Common options:
  --pretty   Format JSON output
  --human    Show human-readable text
  -h, --help / -v, --version

Exit codes: 0 success / 1 general error / 2 usage error / 3 login required / 4 network error / 5 URL blocked / 6 parse error / 7 uncertain operation
`;

type Out = { json: unknown; human: () => string };

function fmtDate(iso: string | null): string {
  return iso ? iso.replace("T", " ").replace(/:\d{2}\+09:00$/, "") : "-";
}

async function readStdin(): Promise<string> {
  return (await new Response(Bun.stdin.stream()).text()).trim();
}

function validateTerm(v: { year?: string; semester?: string }) {
  if (v.year !== undefined && !/^(\d{4}|all)$/.test(v.year)) throw new UsageError("--year must be a four-digit year or all");
  if (v.semester !== undefined && !/^(1|2|3|all)$/.test(v.semester)) throw new UsageError("--semester must be 1, 2, 3, or all");
  return { year: v.year, semester: v.semester };
}

async function run(argv: string[]): Promise<Out | null> {
  if (argv[0] === "materials") return materialsCommand(argv.slice(1));
  if (argv[0] === "quiz" || argv[0] === "report") return learningCommand(argv[0], argv.slice(1));
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      pretty: { type: "boolean" },
      human: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      cookie: { type: "string" },
      stdin: { type: "boolean" },
      "no-verify": { type: "boolean" },
      deep: { type: "boolean" },
      year: { type: "string" },
      semester: { type: "string" },
      days: { type: "string" },
    },
  });
  const [command, ...rest] = positionals;
  if (values.version) {
    console.log(VERSION);
    return null;
  }
  if (values.help || !command) {
    console.log(HELP);
    return null;
  }

  switch (command) {
    case "login": {
      let raw: string | undefined;
      if (values.cookie !== undefined && values.stdin) throw new UsageError("--cookie and --stdin cannot be used together");
      if (values.stdin) raw = await readStdin();
      else if (values.cookie !== undefined) raw = values.cookie;
      else raw = process.env.WEBCLASS_COOKIE;
      if (!raw) throw new UsageError("Provide cookies through --cookie, --stdin, or WEBCLASS_COOKIE");
      const jar = parseCookieInput(raw);
      const path = saveSession(jar);
      const names = Object.keys(jar);
      let verified: boolean | null = null;
      if (!values["no-verify"]) {
        // Verify the newly saved cookies, ignoring any environment override.
        const env = { ...process.env, WEBCLASS_COOKIE: undefined };
        await cmd.status(cmd.makeClient(env), { deep: true });
        verified = true;
      }
      return {
        json: { saved: true, path, cookie_names: names, verified },
        human: () => `Saved: ${path} (cookies: ${names.join(", ")})${verified ? " / session verified" : ""}`,
      };
    }
    case "forget": {
      const removed = clearSession();
      return { json: { removed, path: sessionPath() }, human: () => (removed ? "Removed" : "No saved session") };
    }
    case "status": {
      const r = await cmd.status(cmd.makeClient(), { deep: values.deep });
      return { json: r, human: () => `Logged in (checked: ${r.checked.join(", ")})` };
    }
    case "courses": {
      const term = validateTerm(values);
      const r = cmd.coursesResult(await cmd.fetchCourseList(cmd.makeClient(), term));
      return {
        json: r,
        human: () =>
          [`Year ${r.year ?? "?"} ${r.semester_label ?? ""}`]
            .concat(
              r.courses.map(
                (c) => `${c.id}\t${c.name}\t${c.schedule.map((s) => `${s.day.charAt(0)}${s.period}`).join(",")}`,
              ),
            )
            .join("\n"),
      };
    }
    case "course": {
      const id = rest[0];
      if (!id) throw new UsageError("Provide a course ID: course <id>");
      const term = validateTerm(values);
      const r = await cmd.course(cmd.makeClient(), id, term);
      return {
        json: r,
        human: () => {
          const lines = [`${r.course.name ?? id}`];
          for (const f of r.folders) {
            lines.push(`■ ${f.name}`);
            for (const c of f.contents) {
              const flags = [c.is_new ? "New" : "", c.openable ? "" : "(unavailable)"].filter(Boolean).join(" ");
              lines.push(`  [${c.category ?? "?"}] ${c.name}  Deadline: ${fmtDate(c.end_date)} Uses: ${c.exec_count} ${flags}`.trimEnd());
              for (const u of c.unit_contents) lines.push(`      - ${u}`);
            }
          }
          return lines.join("\n");
        },
      };
    }
    case "deadlines": {
      const days = values.days === undefined ? 7 : Number(values.days);
      if (!Number.isFinite(days) || days < 0) throw new UsageError("--days must be a non-negative number");
      const term = validateTerm(values);
      const r = await cmd.deadlines(cmd.makeClient(), { ...term, days });
      return {
        json: r,
        human: () =>
          r.items.length === 0
            ? `No deadlines within ${days} days`
            : r.items
                .map((i) => `${fmtDate(i.end_date)}  ${i.course_name} / ${i.name} [${i.category ?? "?"}]${i.exec_count ? " (previously accessed)" : ""}`)
                .join("\n"),
      };
    }
    case "news":
    case "inbox":
      throw new CliError("NOT_IMPLEMENTED", `${command} is not implemented`, ExitCode.ERROR);
    default:
      throw new UsageError(`Unknown command: ${command} (see webclass --help)`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const pretty = argv.includes("--pretty");
  const human = argv.includes("--human");
  try {
    const out = await run(argv);
    if (!out) return;
    if (human) console.log(out.human());
    else console.log(JSON.stringify(out.json, null, pretty ? 2 : undefined));
  } catch (e) {
    let err: CliError;
    if (e instanceof CliError) err = e;
    else if (e instanceof Error && "code" in e && String((e as { code: unknown }).code).startsWith("ERR_PARSE_ARGS")) {
      err = new UsageError(e.message);
    } else {
      err = new CliError("ERROR", e instanceof Error ? e.message : String(e), ExitCode.ERROR);
    }
    if (human) console.error(`Error: ${err.message}`);
    else console.error(JSON.stringify({ error: err.toJSON() }, null, pretty ? 2 : undefined));
    process.exitCode = err.exitCode;
  }
}

await main();
