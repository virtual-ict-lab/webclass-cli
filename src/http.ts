import { isLoginUrl } from "./detect.ts";
import { BlockedUrlError, CliError, HttpError, OperationUncertainError, SessionExpiredError, ParseError, redactUrl } from "./errors.ts";
import type { CookieJar } from "./session.ts";
import { cookieFingerprint, serializeCookies } from "./session.ts";
import { assertAllowed, assertLearningAllowed, assertMaterialAllowed, mayChangeRemoteState } from "./urlpolicy.ts";
import { VERSION } from "./version.ts";

export const USER_AGENT = `webclass-cli/${VERSION} (study CLI)`;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  baseUrl: string;
  access?: "read" | "learning" | "materials";
  cookies: CookieJar;
  /** Persisted identity retained only across server-issued cookie updates. */
  sessionIdentity?: string;
  fetch?: FetchLike;
  /** Minimum interval in milliseconds from the previous response to the next request; at least 1000 ms. */
  minIntervalMs?: number;
  /** Maximum number of retries, capped at 2. */
  maxRetries?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRedirects?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Called when Set-Cookie updates the cookie jar. */
  onCookiesUpdated?: (jar: CookieJar) => void;
  /** Tests only: disable the minimum interval floor. */
  unsafeAllowShortInterval?: boolean;
}

/** Treat larger pages as regular pages rather than JavaScript redirects. */
const JUMP_PAGE_MAX_BYTES = 2048;
const JS_JUMP = /(?:window\.)?(?:top\.)?location(?:\.href)?\s*=\s*(["'])([^"']+)\1/;

/**
 * Return the target of a small JavaScript redirect page, as observed at course.php/{id}/login and expired-session PageJump pages.
 */
export function jsJumpTarget(body: string): string | null {
  if (body.length > JUMP_PAGE_MAX_BYTES || /<(?:form|input|button|textarea|select)\b/i.test(body)) return null;
  const m = body.match(JS_JUMP);
  return m ? m[2]!.replace(/&amp;/g, "&") : null;
}

export interface Page {
  url: URL;
  status: number;
  contentType: string;
  body: string;
  data?: Uint8Array;
  contentDisposition?: string;
  stoppedAtLogin?: boolean;
  /** Whether this request chain sent a state-changing request before receiving this page. */
  stateChangeSent?: boolean;
}

/** Keep response parsing in the same uncertainty boundary as its request chain. */
export function verifyPage<T>(page: Page, inspect: (page: Page) => T): T {
  try { return inspect(page); }
  catch (error) {
    if (page.stateChangeSent) throw error instanceof OperationUncertainError ? error : new OperationUncertainError();
    throw error;
  }
}

/**
 * WebClass client. Read-only by default; permit GET/POST for learning operations.
 * - Serialize requests and wait at least one second after each response before sending the next request.
 * - Follow redirects manually, checking the URL policy at every hop.
 * - Retry only network errors, 5xx, and 429 responses, at most twice.
 */
export class WebClassClient {
  readonly base: URL;
  readonly sessionFingerprint: string;
  readonly access: "read" | "learning" | "materials";
  private jar: CookieJar;
  private readonly fetchImpl: FetchLike;
  private readonly minInterval: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly maxRedirects: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onCookiesUpdated?: (jar: CookieJar) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequestEnd = Number.NEGATIVE_INFINITY;
  requestCount = 0;
  mutationCount = 0;

  constructor(opts: ClientOptions) {
    this.base = new URL(opts.baseUrl);
    this.access = opts.access ?? "read";
    this.jar = { ...opts.cookies };
    this.sessionFingerprint = opts.sessionIdentity ?? cookieFingerprint(opts.cookies);
    this.fetchImpl = opts.fetch ?? ((i, init) => fetch(i, init));
    const interval = opts.minIntervalMs ?? 1000;
    this.minInterval = opts.unsafeAllowShortInterval ? interval : Math.max(this.access !== "read" ? 2000 : 1000, interval);
    this.maxRetries = Math.min(2, Math.max(0, opts.maxRetries ?? 2));
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxResponseBytes = opts.maxResponseBytes ?? 100 * 1024 * 1024;
    this.maxRedirects = opts.maxRedirects ?? 12;
    this.sleep = opts.sleep ?? ((ms) => Bun.sleep(ms));
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
    this.onCookiesUpdated = opts.onCookiesUpdated;
  }

  resolve(target: string | URL): URL {
    return new URL(String(target), this.base);
  }

  /** Perform a GET, follow redirects, and return the final page. */
  get(target: string | URL): Promise<Page> {
    return this.enqueue(target, "GET");
  }

  post(target: string | URL, body: URLSearchParams | FormData, options: { stopAtLogin?: boolean } = {}): Promise<Page> {
    return this.enqueue(target, "POST", body, false, options.stopAtLogin === true && this.access === "materials");
  }

  async getBytes(target: string | URL): Promise<Page & {data:Uint8Array}> {
    const page=await this.getResource(target);
    return verifyPage(page,()=>{
      if(!page.data)throw new ParseError("Received HTML instead of a file");
      return page as Page & {data:Uint8Array};
    });
  }

  /** Distinguish attachment bytes from an HTML viewer without corrupting binary data. */
  getResource(target: string | URL): Promise<Page> {
    return this.enqueue(target,"GET",undefined,true);
  }

  private enqueue(target: string | URL, method: "GET" | "POST", body?: URLSearchParams | FormData, binary=false, stopAtLogin=false): Promise<Page> {
    const run = async () => {
      const before = this.mutationCount;
      try {
        const page = await this.doRequest(this.resolve(target), method, body, binary, stopAtLogin);
        return { ...page, stateChangeSent: this.mutationCount > before };
      }
      catch (e) {
        if (this.mutationCount > before) throw new OperationUncertainError();
        throw e;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async doRequest(start: URL, method: "GET" | "POST", body?: URLSearchParams | FormData, binary=false, stopAtLogin=false): Promise<Page> {
    let url = start;
    for (let hop = 0; hop <= this.maxRedirects; hop++) {
      if (this.access === "materials") assertMaterialAllowed(url,this.base,method);
      else if (this.access === "learning") assertLearningAllowed(url, this.base, method);
      else {
        assertAllowed(url, this.base);
        if (method !== "GET") throw new BlockedUrlError(url.pathname, "POST is unavailable in a read-only client");
      }
      const res = await this.fetchWithRetry(url, method, body);
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (method === "POST" && ![301, 302, 303].includes(res.status)) {
          await res.body?.cancel().catch(() => undefined);
          throw new OperationUncertainError();
        }
        if (res.status === 301 || res.status === 302 || res.status === 303) { method = "GET"; body = undefined; }
        await res.body?.cancel().catch(() => undefined);
        if (!loc) throw new HttpError(`Redirect without a Location header (${res.status})`, { url: redactUrl(url.pathname) });
        const next = new URL(loc, url);
        if (isLoginUrl(next, this.base)) {
          if(stopAtLogin && next.origin===this.base.origin) return {url,status:res.status,contentType:res.headers.get("content-type")??"",body:"",stoppedAtLogin:true};
          throw new SessionExpiredError({ redirected_to: next.host === this.base.host ? redactUrl(next.pathname) : next.host });
        }
        url = next;
        continue;
      }
      const contentType=res.headers.get("content-type")??"";
      if (res.status === 401 || res.status >= 400) {
        await res.body?.cancel().catch(() => undefined);
        if (res.status === 401) throw new SessionExpiredError({ status: 401 });
        throw new HttpError(`HTTP ${res.status}`, { status: res.status, url: redactUrl(url.pathname + url.search) });
      }
      let data:Uint8Array|undefined;
      let responseBody:string;
      const bytes=await this.readResponseBytes(res);
      if(binary){
        const prefix=new TextDecoder().decode(bytes.subarray(0,512)).trimStart();
        if(/html/i.test(contentType)||/^<(?:!doctype|html|script|head|body)/i.test(prefix))responseBody=new TextDecoder().decode(bytes);
        else {data=bytes;responseBody='';}
      }else responseBody=new TextDecoder().decode(bytes);
      // WebClass uses HTTP 200 with JavaScript (location.href=...) for navigation. Treat small jump pages as redirects.
      const jump = jsJumpTarget(responseBody);
      if (jump !== null) {
        const next = new URL(jump, url);
        if (isLoginUrl(next, this.base)) {
          if(stopAtLogin && next.origin===this.base.origin) return {url,status:res.status,contentType,body:responseBody,stoppedAtLogin:true};
          throw new SessionExpiredError({ redirected_to: next.host === this.base.host ? redactUrl(next.pathname) : next.host });
        }
        url = next;
        method = "GET"; body = undefined;
        continue;
      }
      return { url, status: res.status, contentType, body: responseBody, data, contentDisposition: res.headers.get("content-disposition") ?? undefined };
    }
    throw new HttpError("Too many redirects", { url: redactUrl(start.pathname) });
  }

  private async readResponseBytes(res: Response): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = res.body?.getReader();
    try {
      if (reader) while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > this.maxResponseBytes) {
          await reader.cancel().catch(() => undefined);
          throw new HttpError('Response exceeds the maximum size');
        }
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return bytes;
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new HttpError('Could not read the response body');
    } finally {
      reader?.releaseLock();
      this.lastRequestEnd = this.now();
    }
  }

  private async waitTurn(): Promise<void> {
    const jitter = this.access !== "read" ? Math.floor(Math.max(0, Math.min(1, this.random())) * 1000) : 0;
    const wait = this.lastRequestEnd + this.minInterval + jitter - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  private async fetchWithRetry(url: URL, method: "GET" | "POST", body?: URLSearchParams | FormData): Promise<Response> {
    let lastError: unknown;
    const retries = this.access !== "read" ? 0 : this.maxRetries;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.waitTurn();
      let res: Response;
      try {
        this.requestCount++;
        if (mayChangeRemoteState(url, this.base, method)) this.mutationCount++;
        res = await this.fetchImpl(url.href, {
          method,
          body,
          redirect: "manual",
          headers: {
            "User-Agent": USER_AGENT,
            ...(body instanceof URLSearchParams ? { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" } : {}),
            Accept: "text/html,application/xhtml+xml,*/*;q=0.8",
            "Accept-Language": "ja",
            Cookie: serializeCookies(this.jar),
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        lastError = e;
        this.lastRequestEnd = this.now();
        if (e instanceof CliError) throw e;
        continue;
      }
      this.lastRequestEnd = this.now();
      try { this.absorbSetCookie(res); }
      catch (error) { await res.body?.cancel().catch(() => undefined); throw error; }
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        await res.body?.cancel().catch(() => undefined);
        await this.sleep(1000 * (attempt + 1));
        continue;
      }
      return res;
    }
    // Return only the error name to avoid exposing cookies in the cause message.
    const kind = lastError instanceof Error ? lastError.name : "Error";
    throw new HttpError(`Network error (${kind})`, { url: redactUrl(url.pathname), attempts: retries + 1 });
  }

  private absorbSetCookie(res: Response): void {
    const lines = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    let changed = false;
    for (const line of lines) {
      const first = line.split(";")[0] ?? "";
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      const expired = /max-age=0\b/i.test(line) || value === "" || value === "deleted";
      if (expired) {
        if (name in this.jar) {
          delete this.jar[name];
          changed = true;
        }
      } else if (this.jar[name] !== value) {
        this.jar[name] = value;
        changed = true;
      }
    }
    if (changed && this.onCookiesUpdated) this.onCookiesUpdated({ ...this.jar });
  }
}
