import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { anonymizeHtml, findLeaks } from "../src/anonymize.ts";
import { fixture } from "./helpers.ts";

describe("anonymization", () => {
  test("replaces user displays, IDs, acs_, email, and repeated names", () => {
    const src = `<span>12_3AB45:山田　花子</span><a href="/x?a=1&acs_=1a2b3c4d">x</a>
      <p>山田　花子 さん</p><p>花子</p>{"url":"\\/webclass\\/carte.php?acs_=5e6f7a8b"} hanako@example.org`;
    const out = anonymizeHtml(src);
    expect(out).toContain("00_0XX00:匿名　太郎");
    expect(out).not.toContain("山田");
    expect(out).not.toContain("花子");
    expect(out).not.toContain("12_3AB45");
    expect(out).not.toContain("1a2b3c4d");
    expect(out).not.toContain("5e6f7a8b");
    expect(out).toContain("user@example.com");
    expect(findLeaks(out)).toEqual([]);
  });
  test("replaces lowercase user IDs from inbox user columns", () => {
    const out = anonymizeHtml("<td>12_x34567</td>");
    expect(out).toBe("<td>00_0XX00</td>");
  });
  test("replaces additional names supplied through --name", () => {
    expect(anonymizeHtml("担当: 佐藤 一郎", { names: ["佐藤 一郎"] })).toBe("担当: ANON_NAME_1");
  });
  test("preserves course and content IDs", () => {
    const s = "/webclass/course.php/00x_000001/ d0000000000000000000000000000002 data-end-date=\"1802043059\"";
    expect(anonymizeHtml(s)).toBe(s);
  });
  test("repository fixtures contain no leaks", () => {
    const dir = join(import.meta.dir, "fixtures");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".html"))) {
      expect({ f, leaks: findLeaks(fixture(f)) }).toEqual({ f, leaks: [] });
    }
  });
  test("public fixtures contain only dummy course, content, and authentication identifiers", () => {
    const dir = join(import.meta.dir, "fixtures");
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".html"))) {
      const decoded = fixture(f).replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => decodeURIComponent(encoded))
        .replace(/\\u([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/\\\//g, "/");
      const ids = decoded.match(/\b\d{2}[a-z]_\d+\b/gi) ?? [];
      expect({ f, unexpected: ids.filter((id) => id !== "00x_000001") }).toEqual({ f, unexpected: [] });
      const opaque = decoded.match(/\b[0-9a-f]{32}\b/gi) ?? [];
      expect({ f, unexpected: opaque.filter((id) => !/^(?:0{32}|d0{27}[0-9a-f]{4})$/.test(id)) })
        .toEqual({ f, unexpected: [] });
      for (const match of decoded.matchAll(/["']acs_["']\s*:\s*["']([^"']*)/g)) {
        expect({ f, token: match[1] }).toEqual({ f, token: "00000000" });
      }
      expect(decoded).not.toMatch(/(?:WBT_Session|SimpleSAML(?:AuthToken)?)\s*[=:]\s*["']?[a-z0-9_]{16,}/i);
    }
  });
});
