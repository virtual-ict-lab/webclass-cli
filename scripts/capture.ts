#!/usr/bin/env bun
/**
 * Fetch a live page, anonymize it, and save it as a development fixture.
 * Never write raw HTML to disk. Use the same GET-only client, URL policy, and one-second interval as the CLI.
 *
 *   bun scripts/capture.ts <path> <output-file> [--name name]...
 *   Example: bun scripts/capture.ts index.php index.html
 *       bun scripts/capture.ts --via-course 00x_000001 course-full.html   # Follow the course entry link on the home page.
 *       bun scripts/capture.ts --link information.php news.html           # Follow a link on the home page.
 *       bun scripts/capture.ts --from course.php/00x_000001/ --link information.php/course news-course.html
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { anonymizeHtml, findLeaks } from "../src/anonymize.ts";
import { makeClient } from "../src/commands.ts";
import { parseCourseList } from "../src/parsers/courses.ts";
import { parse } from "node-html-parser";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string", multiple: true },
    "via-course": { type: "string" },
    link: { type: "string" },
    from: { type: "string" },
  },
});
const client = makeClient();
let target: string;
let outName: string;

if (values["via-course"] || values.link) {
  [outName] = positionals as [string];
  const top = await client.get(values.from ?? "index.php");
  if (values["via-course"]) {
    const href = parseCourseList(top.body).entryLinks.get(values["via-course"]);
    if (!href) throw new Error("Course not found");
    target = href;
  } else {
    const needle = values.link!;
    const a = parse(top.body)
      .querySelectorAll("a[href]")
      .find((a) => (a.getAttribute("href") ?? "").includes(needle));
    if (!a) throw new Error(`No link containing ${needle} found on the home page`);
    target = a.getAttribute("href")!;
  }
} else {
  [target, outName] = positionals as [string, string];
}
if (!target || !outName) {
  console.error("usage: bun scripts/capture.ts <path> <out.html> | --via-course <id> <out.html> | --link <substr> <out.html>");
  process.exit(2);
}

const page = await client.get(target);
const names = values.name ?? [];
const out = anonymizeHtml(page.body, { names });
const leaks = findLeaks(out, names);
if (leaks.length) {
  for (const l of leaks) console.error(l);
  console.error("Not saving because anonymization leaks were found");
  process.exit(1);
}
const path = join(import.meta.dir, "..", "tests", "fixtures", outName);
writeFileSync(path, out);
console.error(`wrote ${path} (status ${page.status}, final ${page.url.pathname}, ${out.length} bytes)`);
console.error("Review the output for remaining personal information, including teacher and other student names, and recapture it with --name if needed");
