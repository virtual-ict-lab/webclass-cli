import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike } from "../src/http.ts";
import { WebClassClient } from "../src/http.ts";

export const BASE = "https://webclass.example.test/webclass/";

export function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "fixtures", name), "utf8");
}

export interface Call {
  url: string;
  init: RequestInit;
}

export type Route = (url: URL) => Response | Promise<Response> | undefined;

/** Mock fetch responses through a route function and record every call. */
export function mockFetch(route: Route) {
  const calls: Call[] = [];
  const fn: FetchLike = async (input, init) => {
    calls.push({ url: input, init });
    const res = await route(new URL(input));
    if (!res) return new Response("not found", { status: 404 });
    return res;
  };
  return { fn, calls };
}

export function html(body: string, status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=UTF-8", ...headers } });
}

export function redirect(location: string, status = 302) {
  return new Response(null, { status, headers: { location } });
}

/** Client with a virtual clock; sleep only advances the clock. */
export function testClient(route: Route, opts: { cookies?: Record<string, string>; maxRetries?: number } = {}) {
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const { fn, calls } = mockFetch(route);
  const client = new WebClassClient({
    baseUrl: BASE,
    cookies: opts.cookies ?? { WBT_Session: "SECRET-COOKIE-VALUE" },
    fetch: fn,
    maxRetries: opts.maxRetries,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { client, calls, sleeps, advance: (ms: number) => (clock += ms) };
}
