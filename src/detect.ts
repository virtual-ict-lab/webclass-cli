import { parse } from "node-html-parser";

/**
 * Detect expired sessions.
 * - A redirect to a login page (login.php, SAML, or an IdP on another origin) means the session has expired.
 * - Authenticated pages always link to `logout.php`; a missing link means the session has expired.
 */

export function isLoginUrl(url: URL, base: URL): boolean {
  if (url.host !== base.host || url.protocol !== base.protocol) return true; // Redirected to an IdP such as Microsoft.
  const p = url.pathname.toLowerCase();
  return /\/login\.php$/.test(p) || /shibboleth|saml|\/sso(\/|$)/.test(p);
}

export function hasLogoutLink(html: string): boolean {
  const root = parse(html);
  return root.querySelectorAll("a[href]").some((a) => /\/logout\.php(\?|$)/i.test(a.getAttribute("href") ?? ""));
}

/**
 * When a session expires, WebClass returns an HTTP 200 PageJump page that redirects to login.php with JavaScript.
 * The same applies to session.php/keep; observed live in tests/fixtures/pagejump-expired.html.
 */
export function isJumpToLogin(html: string): boolean {
  if (/location(\.href)?\s*=\s*["'][^"']*\/login\.php/i.test(html)) return true;
  if (/<meta[^>]+http-equiv=["']?refresh[^>]+login\.php/i.test(html)) return true;
  return false;
}

export function looksLikeLoginPage(html: string): boolean {
  if (isJumpToLogin(html)) return true;
  const root = parse(html);
  if (root.querySelector('input[type="password"]')) return true;
  if (root.querySelector('form[action*="login.php"]')) return true;
  if (root.querySelector('form[action*="SAML"], form[action*="saml"]')) return true;
  if (root.querySelector('input[name="SAMLRequest"], input[name="SAMLResponse"]')) return true;
  return false;
}

/** Check whether the HTML page is authenticated. */
export function isLoggedInPage(html: string): boolean {
  return hasLogoutLink(html) && !looksLikeLoginPage(html);
}
