import type { HTMLElement } from "node-html-parser";

/** Collapse consecutive whitespace and trim both ends, excluding nonbreaking and full-width spaces. */
export function cleanText(s: string | undefined | null): string {
  return (s ?? "").replace(/ /g, " ").replace(/[ \t\r\n]+/g, " ").trim();
}

export function text(el: HTMLElement | null | undefined): string {
  return cleanText(el?.textContent);
}

/** Convert UNIX seconds to an ISO 8601 string in JST (e.g. 2027-02-08T08:30:59+09:00). */
export function unixToJst(sec: number): string {
  const d = new Date((sec + 9 * 3600) * 1000);
  return d.toISOString().replace(/\.\d{3}Z$/, "+09:00");
}

/** Convert "2026/04/18 08:30" (JST) to "2026-04-18T08:30:00+09:00"; return null if invalid. */
export function jstLocalToIso(s: string): string | null {
  const m = s.trim().match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const pad = (v: string | undefined) => (v ?? "").padStart(2, "0");
  return `${y}-${pad(mo)}-${pad(d)}T${pad(h)}:${pad(mi)}:00+09:00`;
}

/** Return a path with acs_ removed for output; never expose session-specific tokens. */
export function stripAcs(href: string, base: string): string {
  const u = new URL(href, base);
  u.searchParams.delete("acs_");
  return u.pathname + (u.search === "?" ? "" : u.search);
}
