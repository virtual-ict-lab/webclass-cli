#!/usr/bin/env bun
/**
 * Fixture anonymization script.
 *
 *   bun scripts/anonymize.ts <input.html> <output.html> [--name name]... [--pattern regex]...
 *   bun scripts/anonymize.ts --check tests/fixtures/*.html [--name name]...
 *
 * Check for leaks after anonymization; exit with code 1 without writing output if any are found.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { anonymizeHtml, findLeaks } from "../src/anonymize.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string", multiple: true },
    pattern: { type: "string", multiple: true },
    check: { type: "boolean" },
  },
});
const names = values.name ?? [];

if (values.check) {
  let bad = 0;
  for (const f of positionals) {
    const leaks = findLeaks(readFileSync(f, "utf8"), names);
    for (const l of leaks) console.error(`${f}: ${l}`);
    bad += leaks.length;
  }
  if (bad) process.exit(1);
  console.error(`OK: ${positionals.length} files`);
  process.exit(0);
}

const [input, output] = positionals;
if (!input || !output) {
  console.error("usage: bun scripts/anonymize.ts <input.html> <output.html> [--name name]... [--pattern re]...");
  process.exit(2);
}
const out = anonymizeHtml(readFileSync(input, "utf8"), { names, patterns: values.pattern });
const leaks = findLeaks(out, names);
if (leaks.length) {
  for (const l of leaks) console.error(l);
  process.exit(1);
}
writeFileSync(output, out);
console.error(`wrote ${output}`);
