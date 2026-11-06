import { type HTMLElement, parse } from "node-html-parser";
import { ParseError } from "../errors.ts";
import { cleanText, jstLocalToIso, text, unixToJst } from "./util.ts";

export interface Content {
  id: string;
  name: string;
  /** Category label exactly as displayed, such as material, self-study, or unit. */
  category: string | null;
  folder_id: string | null;
  /** Deadline from data-end-date; 0 means no deadline and becomes null. */
  end_date: string | null;
  end_date_unix: number | null;
  /** Availability period in JST. */
  available_from: string | null;
  available_until: string | null;
  exec_count: number;
  resubmit_available: boolean;
  is_new: boolean;
  /** Whether the content name is a link, meaning it can currently be opened. */
  openable: boolean;
  /** Names of child content items in a unit. */
  unit_contents: string[];
}

export interface Folder {
  id: string | null;
  name: string;
  contents: Content[];
}

export interface CoursePage {
  course: { id: string | null; name: string | null };
  folders: Folder[];
}

const PERIOD = /(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2})\s*-\s*(\d{4}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2})/;

function intAttr(el: HTMLElement, name: string): number {
  const n = Number.parseInt(el.getAttribute(name) ?? "", 10);
  return Number.isFinite(n) ? n : 0;
}

function availability(sec: HTMLElement): { from: string | null; until: string | null } {
  for (const label of sec.querySelectorAll('[class*="contentDetailListItemLabel"]')) {
    if (text(label) !== "利用可能期間") continue;
    const data = label.parentNode?.querySelector('[class*="contentDetailListItemData"]');
    const m = text(data).match(PERIOD);
    if (m) return { from: jstLocalToIso(m[1]!), until: jstLocalToIso(m[2]!) };
  }
  return { from: null, until: null };
}

function parseContent(sec: HTMLElement, root: HTMLElement): Content {
  const id = sec.getAttribute("data-contents-id") ?? "";
  const end = intAttr(sec, "data-end-date");
  const nameEl = sec.querySelector(".cm-contentsList_contentName");
  const unitBox = root.getElementById(`scenarioContents-${id}`) ?? sec.querySelector(`[id="scenarioContents-${id}"]`);
  const unit = (unitBox?.querySelectorAll("td") ?? []).map((td) => text(td)).filter(Boolean);
  const { from, until } = availability(sec);
  const fallbackName = cleanText(
    nameEl?.querySelectorAll("a, div").filter((e) => !e.classList.contains("cl-contentsList_new")).at(-1)?.textContent,
  );
  return {
    id,
    name: cleanText(sec.getAttribute("data-contents-name")) || fallbackName,
    category: text(sec.querySelector(".cl-contentsList_categoryLabel")) || null,
    folder_id: sec.getAttribute("data-parent-folder-id") || null,
    end_date: end > 0 ? unixToJst(end) : null,
    end_date_unix: end > 0 ? end : null,
    available_from: from,
    available_until: until,
    exec_count: intAttr(sec, "data-exec-count"),
    resubmit_available: sec.getAttribute("data-resubmit-available") === "1",
    is_new: !!sec.querySelector(".cl-contentsList_new"),
    openable: !!nameEl?.querySelector("a[href]"),
    unit_contents: unit,
  };
}

export function parseCourse(html: string): CoursePage {
  const root = parse(html);
  const nameLink = root.querySelector("a.course-name");
  const idFromLink = nameLink?.getAttribute("href")?.match(/\/course\.php\/([^/?#]+)/)?.[1] ?? null;

  const folderSections = root.querySelectorAll("section.cl-contentsList_folder[data-folder-id]");
  const contentSections = root.querySelectorAll("section[data-contents-id]");
  if (!nameLink && folderSections.length === 0 && contentSections.length === 0) {
    throw new ParseError("Unrecognized course page structure (content list not found)");
  }

  const folders: Folder[] = folderSections.map((f) => ({
    id: f.getAttribute("data-folder-id") ?? null,
    name: text(f.querySelector(".panel-title")),
    contents: [],
  }));
  const byId = new Map(folders.map((f) => [f.id, f]));
  let orphan: Folder | null = null;

  for (const sec of contentSections) {
    const c = parseContent(sec, root);
    let folder = byId.get(c.folder_id);
    if (!folder) {
      orphan ??= { id: null, name: "(No folder)", contents: [] };
      folder = orphan;
    }
    folder.contents.push(c);
  }
  if (orphan) folders.push(orphan);

  return { course: { id: idFromLink, name: nameLink ? text(nameLink) : null }, folders };
}
