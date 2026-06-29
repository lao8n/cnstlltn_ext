import { Readability } from "@mozilla/readability";
import { ulid } from "ulid";
import type { VideoMeta } from "./types";

export interface ExtractedArticle {
  videoMeta: VideoMeta;
  text: string;
}

// Injected into the page via chrome.scripting (serialised — NO imports/closure).
// It only ships raw material back; Readability runs in the side panel.
function grabPage(): {
  html: string;
  url: string;
  title: string;
  selection: string;
} {
  return {
    html: document.documentElement.outerHTML,
    url: location.href,
    title: document.title,
    selection: window.getSelection()?.toString() ?? "",
  };
}

async function grabActiveTab(): Promise<ReturnType<typeof grabPage>> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) throw new Error("No active tab to extract from.");
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: grabPage,
  });
  const r = res?.result as ReturnType<typeof grabPage> | undefined;
  if (!r) throw new Error("Could not read the page.");
  return r;
}

function metaContent(doc: Document, selectors: string[]): string | null {
  for (const sel of selectors) {
    const v = doc.querySelector<HTMLMetaElement>(sel)?.content?.trim();
    if (v) return v;
  }
  return null;
}

// Pull author/published/site from JSON-LD Article nodes when present.
function readJsonLd(doc: Document): {
  author?: string;
  published?: string;
  site?: string;
} {
  const out: { author?: string; published?: string; site?: string } = {};
  for (const s of Array.from(
    doc.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]'),
  )) {
    try {
      const data = JSON.parse(s.textContent || "null");
      const nodes = Array.isArray(data)
        ? data
        : [data, ...((data && data["@graph"]) ?? [])];
      for (const n of nodes) {
        if (!n || typeof n !== "object") continue;
        const t = n["@type"];
        const isArticle =
          typeof t === "string"
            ? /article|blogposting|newsarticle/i.test(t)
            : Array.isArray(t) && t.some((x) => /article/i.test(String(x)));
        if (!isArticle) continue;
        if (!out.published && typeof n.datePublished === "string")
          out.published = n.datePublished;
        if (!out.author) {
          const a = n.author;
          if (typeof a === "string") out.author = a;
          else if (a && typeof a.name === "string") out.author = a.name;
          else if (Array.isArray(a) && a[0]?.name) out.author = a[0].name;
        }
        if (!out.site && typeof n.publisher?.name === "string")
          out.site = n.publisher.name;
      }
    } catch {
      /* ignore malformed ld+json */
    }
  }
  return out;
}

// Stable-ish id from the URL, for the source filename / source_id.
function syntheticId(url: string): string {
  try {
    const u = new URL(url);
    const slug = (u.hostname + u.pathname)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
    return slug || ulid();
  } catch {
    return ulid();
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Whole-article (Readability) or current selection from the active tab.
export async function extractActivePage(
  mode: "article" | "selection",
): Promise<ExtractedArticle> {
  const page = await grabActiveTab();
  const doc = new DOMParser().parseFromString(page.html, "text/html");

  // Read metadata BEFORE Readability (it mutates the doc).
  const jsonLd = readJsonLd(doc);
  const published =
    jsonLd.published ??
    metaContent(doc, [
      'meta[property="article:published_time"]',
      'meta[name="article:published_time"]',
      'meta[name="date"]',
    ]);
  const author =
    jsonLd.author ??
    metaContent(doc, [
      'meta[name="author"]',
      'meta[property="article:author"]',
    ]) ??
    "";
  const site =
    jsonLd.site ??
    metaContent(doc, ['meta[property="og:site_name"]']) ??
    hostOf(page.url);

  let title =
    metaContent(doc, ['meta[property="og:title"]']) ?? page.title ?? "";
  let text: string;

  if (mode === "selection") {
    text = page.selection.trim();
    if (!text) throw new Error("No text selected on the page.");
  } else {
    const article = new Readability(doc).parse();
    text = (article?.textContent ?? "").trim();
    if (article?.title) title = article.title;
    if (!text) {
      throw new Error(
        "Couldn't extract the article — try selecting the text, or paste it.",
      );
    }
  }

  return {
    videoMeta: {
      videoId: syntheticId(page.url),
      url: page.url,
      title: title.trim() || page.title,
      channel: author || site,
      durationSeconds: null,
      type: mode === "selection" ? "web" : "article",
      site,
      author,
      published: published ?? null,
    },
    text,
  };
}

// Build a source from pasted text (no page access needed).
export function buildPastedArticle(args: {
  text: string;
  title: string;
  url: string;
}): ExtractedArticle {
  const url = args.url.trim();
  const site = url ? hostOf(url) : "";
  return {
    videoMeta: {
      videoId: url ? syntheticId(url) : ulid(),
      url,
      title: args.title.trim() || "Pasted note",
      channel: site,
      durationSeconds: null,
      type: "web",
      site,
      author: "",
      published: null,
    },
    text: args.text.trim(),
  };
}
