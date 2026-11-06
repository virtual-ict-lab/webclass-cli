/**
 * Anonymize HTML for fixtures.
 * - acs_ tokens -> 00000000
 * - WebClass user labels -> the dummy user ID and Japanese dummy name below.
 * - Student-like IDs (two digits, underscore, alphanumeric characters, final digit) -> 00_0XX00
 * - Email addresses -> user@example.com
 * - Explicit strings such as student or teacher names -> ANON_NAME_n
 */

export interface AnonymizeOptions {
  /** Additional strings to replace, such as names. */
  names?: string[];
  /** Additional regular expressions to replace, supplied as strings. */
  patterns?: string[];
}

export const DUMMY_USER_ID = "00_0XX00";
export const DUMMY_USER_NAME = "匿名　太郎";
export const DUMMY_ACS = "00000000";

const USER_ID = /\b\d{2}_[0-9A-Za-z]{2,}\d{2,}\b/g;
const USER_LABEL = /\b\d{2}_[0-9A-Za-z]{2,}\d{2,}:([^<"'\n]+)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ACS = /(acs_=)[0-9A-Za-z]+/g;
const ACS_JSON = /(["']acs_["']\s*:\s*["'])[^"']*/g;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function anonymizeHtml(html: string, opts: AnonymizeOptions = {}): string {
  let out = html;
  // Extract names from user labels and replace other occurrences on the page.
  const names = new Set((opts.names ?? []).map((n) => n.trim()).filter(Boolean));
  for (const m of out.matchAll(USER_LABEL)) {
    const n = m[1]?.trim();
    if (n && n !== DUMMY_USER_NAME) names.add(n);
  }
  out = out.replace(USER_LABEL, `${DUMMY_USER_ID}:${DUMMY_USER_NAME}`);
  let i = 0;
  for (const n of [...names].sort((a, b) => b.length - a.length)) {
    i++;
    out = out.replace(new RegExp(escapeRe(n), "g"), `ANON_NAME_${i}`);
    // Also match full-width and ASCII space variants.
    const parts = n.split(/[\s　]+/).filter((p) => p.length >= 2);
    for (const p of parts) out = out.replace(new RegExp(escapeRe(p), "g"), `ANON_NAME_${i}`);
  }
  out = out.replace(USER_ID, DUMMY_USER_ID);
  out = out.replace(EMAIL, "user@example.com");
  out = out.replace(ACS, `$1${DUMMY_ACS}`);
  out = out.replace(ACS_JSON, `$1${DUMMY_ACS}`);
  for (const p of opts.patterns ?? []) out = out.replace(new RegExp(p, "g"), "ANONYMIZED");
  return out;
}

/** Check for anonymization leaks; return any problems, or an empty array if none are found. */
export function findLeaks(html: string, forbidden: string[] = []): string[] {
  const problems: string[] = [];
  for (const m of html.matchAll(/acs_=([0-9A-Za-z]+)/g)) {
    if (m[1] !== DUMMY_ACS) problems.push(`Unredacted acs_ token: ${m[1]}`);
  }
  for (const m of html.matchAll(USER_ID)) {
    if (m[0] !== DUMMY_USER_ID) problems.push(`Unredacted student-like ID: ${m[0]}`);
  }
  for (const m of html.matchAll(EMAIL)) {
    if (m[0] !== "user@example.com") problems.push(`Unredacted email address: ${m[0]}`);
  }
  for (const f of forbidden) if (f && html.includes(f)) problems.push(`Unredacted specified string: ${f}`);
  return problems;
}
