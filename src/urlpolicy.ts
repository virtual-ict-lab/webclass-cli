import { BlockedUrlError, redactUrl } from "./errors.ts";

/**
 * URL access policy.
 *
 * 1. Allow only the same origin and paths under base_url.
 * 2. Reject denylisted pages with side effects; the denylist takes precedence over the allowlist.
 * 3. Reject paths outside the allowlist of read-only pages needed by this CLI.
 *
 * Normalize percent encoding, case, duplicate slashes, and dot segments before checking paths.
 */

interface Rule {
  re: RegExp;
  reason: string;
}

/** Evaluate normalized, lowercase paths relative to base_url. */
export const DENY_RULES: readonly Rule[] = [
  { re: /logout/, reason: "logout (invalidates the session)" },
  { re: /(^|\/)do_contents\.php/, reason: "start content or reset its state" },
  { re: /(^|\/)do_[^/]*\.php/, reason: "do_*.php performs actions" },
  { re: /(^|\/)show_frame\.php/, reason: "test or content execution page" },
  { re: /(^|\/)show_info\.php/, reason: "test or content execution page" },
  { re: /(^|\/)show_[^/]*\.php/, reason: "show_*.php performs actions" },
  { re: /_frame\.php/, reason: "*_frame.php is an execution frame" },
];

/** Reject these query parameter names, which trigger do_contents side effects. */
export const DENY_QUERY_PARAMS: readonly string[] = ["reset_status", "set_contents_id"];

export const ALLOW_RULES: readonly Rule[] = [
  { re: /^$/, reason: "home page" },
  { re: /^index\.php\/?$/, reason: "course list" },
  { re: /^session\.php\/keep$/, reason: "session keepalive" },
  { re: /^course\.php\/[^/]+\/login$/, reason: "course entry (timetable link)" },
  { re: /^course\.php\/[^/]+\/?$/, reason: "course page" },
  { re: /^information\.php\/?$/, reason: "announcements" },
  { re: /^information\.php\/course\/[^/]+\/?$/, reason: "course announcements" },
  { re: /^messages\.php\/inbox$/, reason: "messages" },
  { re: /^messages\.php\/course\/[^/]+\/inbox$/, reason: "course messages" },
];

function decodeFully(s: string): string {
  let cur = s;
  for (let i = 0; i < 5; i++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return cur;
    }
    if (next === cur) return cur;
    cur = next;
  }
  return cur;
}

/** Normalize a path for policy checks. */
export function normalizePath(pathname: string): string {
  let p = decodeFully(pathname).replace(/\\/g, "/").toLowerCase();
  p = p.replace(/\/{2,}/g, "/");
  // Resolve ../ segments introduced by decoding.
  p = new URL(p.startsWith("/") ? p : `/${p}`, "http://x").pathname;
  return decodeFully(p).replace(/\/{2,}/g, "/");
}

export type PolicyResult = { ok: true; rule: string } | { ok: false; reason: string };

export function checkUrl(target: URL, base: URL): PolicyResult {
  if (target.protocol !== base.protocol || target.host !== base.host) {
    return { ok: false, reason: "origin differs from base_url" };
  }
  if (target.username || target.password) return { ok: false, reason: "URL contains credentials" };

  const full = normalizePath(target.pathname);
  const basePath = normalizePath(base.pathname);
  if (!full.startsWith(basePath)) return { ok: false, reason: "path is outside base_url" };
  const rel = full.slice(basePath.length);

  for (const rule of DENY_RULES) {
    if (rule.re.test(rel) || rule.re.test(full)) return { ok: false, reason: `denylist: ${rule.reason}` };
  }
  const query = decodeFully(target.search).toLowerCase();
  for (const param of DENY_QUERY_PARAMS) {
    if (new RegExp(`[?&]${param}=`).test(query)) return { ok: false, reason: `denylist: query parameter ${param}` };
  }
  for (const rule of ALLOW_RULES) {
    if (rule.re.test(rel)) return { ok: true, rule: rule.reason };
  }
  return { ok: false, reason: "path is not allowlisted" };
}

export function assertAllowed(target: URL, base: URL): void {
  const r = checkUrl(target, base);
  if (!r.ok) throw new BlockedUrlError(redactUrl(target.pathname + target.search), r.reason);
}

/** Classify an already-allowed request before sending it, including every redirect hop. */
export function mayChangeRemoteState(target: URL, base: URL, method: 'GET'|'POST'): boolean {
  if (method === 'POST') return true;
  if (checkUrl(target, base).ok) return false;
  const root = normalizePath(base.pathname).replace(/\/$/, '') + '/';
  const relative = normalizePath(target.pathname).slice(root.length);
  // Attachments, viewers, and result lookups do not start or save an attempt.
  return !/^(?:data\/course\/|loadit\.php$|mbl\.php\/question_results(?:\/answer)?\/?$)/.test(relative);
}

/** Routes observed during live learning operations. Keep these separate because GET requests can also change state. */
export function assertLearningAllowed(target: URL, base: URL, method: "GET" | "POST"): void {
  const full = normalizePath(target.pathname);
  const root = normalizePath(base.pathname).replace(/\/$/, "") + "/";
  if (target.origin !== base.origin || target.username || target.password || !full.startsWith(root) || /logout/i.test(full)) {
    throw new BlockedUrlError(target.pathname, "learning operation origin or path restriction");
  }
  const rel = full.slice(root.length);
  const learning = /^(?:do_contents\.php|show_frame\.php|show_info\.php|qstn_frame\.php|reslt_frame\.php|mbl\.php\/(?:questions\/?|questions\/api|question_results\/?|question_results\/answer))$/;
  const writable = /^(?:show_info\.php|mbl\.php\/questions\/?|mbl\.php\/questions\/api)$/;
  if (method === "POST" ? writable.test(rel) : learning.test(rel)) return;
  if (method === "GET") return assertAllowed(target, base);
  throw new BlockedUrlError(target.pathname, "path is not allowlisted for POST");
}

/** Allow only material pages and attachments; exclude quiz execution pages. */
export function assertMaterialAllowed(target: URL, base: URL, method: 'GET'|'POST'): void {
  const full=normalizePath(target.pathname);const root=normalizePath(base.pathname).replace(/\/$/,'')+'/';
  if(target.origin!==base.origin||target.username||target.password||!full.startsWith(root)||/logout/i.test(full))throw new BlockedUrlError(target.pathname,'material origin or path restriction');
  const rel=full.slice(root.length);
  if(method==='POST'){
    if(/^(?:show_info\.php|mbl\.php\/textbooks\/?)$/.test(rel))return;
  }else{
    if(/^data\/course\/[^/]+\/[^/]+\/.+/.test(rel))return;
    if(rel==='loadit.php'){
      const file=target.searchParams.get('file');
      if(file){const asset=new URL(file,base);if(asset.origin!==base.origin||!normalizePath(asset.pathname).startsWith(root+'data/course/'))throw new BlockedUrlError(target.pathname,'file is not a material attachment');}
      if(!['','providePDF','pdfViewer'].includes(target.searchParams.get('action')??''))throw new BlockedUrlError(target.pathname,'unsupported viewer action');
      return;
    }
    if(/^(?:do_contents\.php|show_info\.php|show_frame\.php|txtbk_frame\.php|mbl\.php\/textbooks\/?)$/.test(rel))return;
    return assertAllowed(target,base);
  }
  throw new BlockedUrlError(target.pathname,'path is not allowlisted for material POST requests');
}
