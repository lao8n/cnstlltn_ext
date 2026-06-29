import { timedtextJson3ToCues, cuesToVtt } from "@/lib/vtt";
import type { SessionPayload, TranscriptCue, VideoMeta } from "@/lib/types";

const BUTTON_ID = "notetaker-fab";

function isWatchPage(): boolean {
  return /^\/watch/.test(location.pathname);
}

function getVideoId(): string | null {
  return new URLSearchParams(location.search).get("v");
}

interface EngagementPanel {
  engagementPanelSectionListRenderer?: {
    targetId?: string;
    panelIdentifier?: string;
    content?: {
      continuationItemRenderer?: {
        continuationEndpoint?: {
          getTranscriptEndpoint?: {
            params?: string;
          };
        };
      };
    };
  };
}

interface PlayerResponse {
  videoDetails?: {
    videoId?: string;
    title?: string;
    author?: string;
    lengthSeconds?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: {
        baseUrl: string;
        languageCode: string;
        kind?: string;
      }[];
    };
  };
  engagementPanels?: EngagementPanel[];
}

interface MainWorldPayload {
  playerResponse: PlayerResponse | null;
  innertubeContext: unknown;
  innertubeApiKey: string | null;
}

function readMainWorldPayload(): Promise<MainWorldPayload | null> {
  return new Promise((resolve) => {
    const token = `__notetaker_${Math.random().toString(36).slice(2)}`;

    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== window) return;
      const data = ev.data;
      if (
        !data ||
        data.type !== "NOTETAKER_PLAYER_RESPONSE" ||
        data.token !== token
      ) {
        return;
      }
      window.removeEventListener("message", onMessage);
      resolve((data.payload as MainWorldPayload) ?? null);
    };
    window.addEventListener("message", onMessage);

    window.postMessage(
      { type: "NOTETAKER_REQUEST_PLAYER_RESPONSE", token },
      "*",
    );

    setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, 1500);
  });
}

// Build the `params` blob YouTube's get_transcript endpoint expects when the
// engagement panel isn't in the player response. The blob is a protobuf:
//   message { 1: { 1: <videoId> } }
// then base64url-encoded.
function makeTranscriptParams(videoId: string): string {
  const idBytes = new TextEncoder().encode(videoId);
  if (idBytes.length > 127) throw new Error("video ID too long");
  // Inner: field 1, wire type 2 (len-delim): [0x0a, len, ...idBytes]
  const inner = new Uint8Array(2 + idBytes.length);
  inner[0] = 0x0a;
  inner[1] = idBytes.length;
  inner.set(idBytes, 2);
  // Outer wrap: field 1, wire type 2 around inner
  if (inner.length > 127) throw new Error("inner params too long");
  const outer = new Uint8Array(2 + inner.length);
  outer[0] = 0x0a;
  outer[1] = inner.length;
  outer.set(inner, 2);
  let bin = "";
  for (const b of outer) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function findTranscriptParams(playerResp: PlayerResponse | null): string | null {
  const panels = playerResp?.engagementPanels ?? [];
  for (const panel of panels) {
    const r = panel.engagementPanelSectionListRenderer;
    if (!r) continue;
    const id = (r.targetId ?? r.panelIdentifier ?? "").toLowerCase();
    if (!id.includes("transcript")) continue;
    const params =
      r.content?.continuationItemRenderer?.continuationEndpoint
        ?.getTranscriptEndpoint?.params;
    if (params) return params;
  }
  return null;
}

interface InnertubeTranscriptResponse {
  actions?: {
    updateEngagementPanelAction?: {
      content?: {
        transcriptRenderer?: {
          content?: {
            transcriptSearchPanelRenderer?: {
              body?: {
                transcriptSegmentListRenderer?: {
                  initialSegments?: {
                    transcriptSegmentRenderer?: {
                      startMs?: string;
                      endMs?: string;
                      snippet?: { runs?: { text?: string }[]; simpleText?: string };
                    };
                  }[];
                };
              };
            };
          };
        };
      };
    };
  }[];
}

function parseInnertubeTranscript(
  json: InnertubeTranscriptResponse,
): TranscriptCue[] {
  const initialSegments =
    json?.actions?.[0]?.updateEngagementPanelAction?.content?.transcriptRenderer
      ?.content?.transcriptSearchPanelRenderer?.body
      ?.transcriptSegmentListRenderer?.initialSegments ?? [];
  const cues: TranscriptCue[] = [];
  for (const seg of initialSegments) {
    const r = seg.transcriptSegmentRenderer;
    if (!r) continue;
    const startMs = parseInt(r.startMs ?? "0", 10);
    const endMs = parseInt(r.endMs ?? "0", 10);
    const runs = r.snippet?.runs ?? [];
    const text = (
      runs.map((run) => run.text ?? "").join("") ||
      r.snippet?.simpleText ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    cues.push({
      startSeconds: startMs / 1000,
      endSeconds: endMs / 1000,
      text,
    });
  }
  return cues;
}

async function fetchTranscriptViaInnertube(args: {
  params: string;
  apiKey: string;
  context: unknown;
}): Promise<TranscriptCue[]> {
  const url = `https://www.youtube.com/youtubei/v1/get_transcript?key=${encodeURIComponent(
    args.apiKey,
  )}&prettyPrint=false`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      context: args.context,
      params: args.params,
    }),
  });
  if (!resp.ok) {
    throw new Error(`InnerTube get_transcript ${resp.status}`);
  }
  const json = (await resp.json()) as InnertubeTranscriptResponse;
  return parseInnertubeTranscript(json);
}

function pickCaptionTrack(
  tracks: { baseUrl: string; languageCode: string; kind?: string }[],
): { baseUrl: string } | null {
  if (!tracks?.length) return null;
  const en = tracks.filter((t) => t.languageCode.startsWith("en"));
  const manual = en.find((t) => t.kind !== "asr");
  if (manual) return { baseUrl: manual.baseUrl };
  if (en[0]) return { baseUrl: en[0].baseUrl };
  return { baseUrl: tracks[0].baseUrl };
}

async function fetchTranscriptCues(
  baseUrl: string,
): Promise<TranscriptCue[]> {
  const url = setQueryParam(baseUrl, "fmt", "json3");
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch transcript (${resp.status}).`);
  }
  const body = await resp.text();
  if (!body.trim()) {
    throw new Error("timedtext returned an empty body");
  }
  const json = JSON.parse(body);
  return timedtextJson3ToCues(json);
}

function setQueryParam(url: string, key: string, value: string): string {
  try {
    const u = new URL(url, location.origin);
    u.searchParams.set(key, value);
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    return url + sep + key + "=" + value;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readSegmentsFromDom(): TranscriptCue[] {
  // YouTube (2025+) renders transcript segments as <transcript-segment-view-model>
  // with class ytwTranscriptSegmentViewModelHost. Older layouts used
  // ytd-transcript-segment-renderer; we try the new shape first, then the legacy one.
  const segments = document.querySelectorAll<HTMLElement>(
    "transcript-segment-view-model, ytd-transcript-segment-renderer",
  );
  if (!segments.length) return [];
  const cues: TranscriptCue[] = [];
  segments.forEach((el) => {
    const timeEl =
      el.querySelector(".ytwTranscriptSegmentViewModelTimestamp") ??
      el.querySelector(".segment-timestamp") ??
      el.querySelector('[class*="Timestamp"], [class*="timestamp"]');
    const textEl =
      el.querySelector('span[role="text"]') ??
      el.querySelector(".ytAttributedStringHost") ??
      el.querySelector(".segment-text") ??
      el.querySelector("yt-formatted-string");
    if (!timeEl || !textEl) return;
    const seconds = parseTimestamp(timeEl.textContent?.trim() ?? "0:00");
    cues.push({
      startSeconds: seconds,
      endSeconds: seconds + 4,
      text: (textEl.textContent ?? "").replace(/\s+/g, " ").trim(),
    });
  });
  for (let i = 0; i < cues.length - 1; i++) {
    cues[i].endSeconds = cues[i + 1].startSeconds;
  }
  return cues;
}

function dumpTranscriptDomState(): void {
  for (const q of [
    "transcript-segment-view-model",
    ".ytwTranscriptSegmentViewModelHost",
    "ytd-transcript-segment-renderer",
    "ytd-engagement-panel-section-list-renderer",
    '[target-id*="transcript"]',
  ]) {
    const n = document.querySelectorAll(q).length;
    if (n > 0) logd(`probe match  ${q} -> ${n}`);
  }
}

// Robust fallback: find any container whose children look like transcript
// segments (each child's text starts with a "M:SS" or "H:MM:SS" timestamp).
// Doesn't depend on YouTube-specific element names.
function readSegmentsByPattern(): TranscriptCue[] {
  const tsRe = /^((?:\d{1,2}:)?\d{1,2}:\d{2})\s+(.+)$/s;
  const tsHead = /^(?:\d{1,2}:)?\d{1,2}:\d{2}$/;
  let bestContainer: HTMLElement | null = null;
  let bestCount = 0;

  // First, try short-circuit: look for siblings whose text starts with M:SS.
  const all = document.querySelectorAll<HTMLElement>("div, section, ul, ol");
  for (const el of Array.from(all)) {
    const kids = el.children;
    if (kids.length < 3) continue;
    let hits = 0;
    for (let i = 0; i < Math.min(kids.length, 50); i++) {
      const t = (kids[i] as HTMLElement).textContent?.trim() ?? "";
      if (tsRe.test(t)) hits++;
    }
    if (hits > bestCount) {
      bestCount = hits;
      bestContainer = el;
    }
  }
  if (!bestContainer || bestCount < 3) return [];

  const cues: TranscriptCue[] = [];
  for (const child of Array.from(bestContainer.children)) {
    const text = (child as HTMLElement).textContent?.trim() ?? "";
    const m = text.match(tsRe);
    if (!m) {
      // Two-element layout: timestamp in one span, body in next span/div
      const tsEl = child.querySelector<HTMLElement>(
        'span, div, [class*="time"], [class*="timestamp"]',
      );
      if (!tsEl) continue;
      const tsText = tsEl.textContent?.trim() ?? "";
      if (!tsHead.test(tsText)) continue;
      const rest = text.replace(tsText, "").replace(/\s+/g, " ").trim();
      if (!rest) continue;
      cues.push({
        startSeconds: parseTimestamp(tsText),
        endSeconds: parseTimestamp(tsText) + 4,
        text: rest,
      });
      continue;
    }
    cues.push({
      startSeconds: parseTimestamp(m[1]),
      endSeconds: parseTimestamp(m[1]) + 4,
      text: m[2].replace(/\s+/g, " ").trim(),
    });
  }
  for (let i = 0; i < cues.length - 1; i++) {
    cues[i].endSeconds = cues[i + 1].startSeconds;
  }
  logd("readSegmentsByPattern matched", { container: bestContainer.tagName + (bestContainer.id ? "#" + bestContainer.id : ""), cues: cues.length });
  return cues;
}

function fireRealClick(el: HTMLElement): void {
  const inner =
    el.matches("button, [role='button']")
      ? el
      : el.querySelector<HTMLElement>("button, [role='button']") ?? el;
  try {
    inner.click();
  } catch {}
  for (const type of [
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
  ]) {
    inner.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        button: 0,
      }),
    );
  }
  logd("fired click on", {
    tag: inner.tagName,
    label:
      inner.getAttribute("aria-label") ??
      inner.textContent?.trim().slice(0, 60),
    matchedSame: inner === el,
  });
}

function logd(msg: string, extra?: unknown): void {
  if (extra !== undefined) console.log(`cnstlltn: ${msg}`, extra);
  else console.log(`cnstlltn: ${msg}`);
}

function findTranscriptToggleButton(): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    'button, tp-yt-paper-item, tp-yt-paper-button, yt-button-shape, ytd-button-renderer, [role="button"], a',
  );
  for (const el of Array.from(candidates)) {
    const label = (
      el.getAttribute("aria-label") ??
      el.getAttribute("title") ??
      el.textContent ??
      ""
    )
      .toLowerCase()
      .trim();
    if (!label) continue;
    if (/^(show|open)\s+transcript$/.test(label)) return el;
    if (/\btranscript\b/.test(label) && label.length < 40) {
      // Avoid grabbing huge descriptive blocks that happen to mention "transcript".
      return el;
    }
  }
  return null;
}

function clickDescriptionExpanders(): number {
  const sels = [
    "ytd-text-inline-expander tp-yt-paper-button#expand",
    "ytd-text-inline-expander #expand",
    "#description-inline-expander #expand",
    "#description tp-yt-paper-button#expand",
    "tp-yt-paper-button#expand",
  ];
  const seen = new Set<HTMLElement>();
  for (const sel of sels) {
    document.querySelectorAll<HTMLElement>(sel).forEach((el) => {
      if (!seen.has(el)) {
        seen.add(el);
        try {
          el.click();
        } catch {}
      }
    });
  }
  return seen.size;
}

async function openAndScrapeTranscript(): Promise<TranscriptCue[]> {
  let cues = readSegmentsFromDom();
  if (cues.length) {
    logd("transcript already open, scraped segments", cues.length);
    return cues;
  }
  cues = readSegmentsByPattern();
  if (cues.length) {
    logd("transcript already open (pattern match)", cues.length);
    return cues;
  }

  let btn = findTranscriptToggleButton();
  logd("initial transcript-button search", btn ? "found" : "not found");

  if (!btn) {
    const expanded = clickDescriptionExpanders();
    logd("clicked description expanders", expanded);
    for (let i = 0; i < 20; i++) {
      await sleep(150);
      btn = findTranscriptToggleButton();
      if (btn) {
        logd("found transcript button after expand, waited ms", i * 150);
        break;
      }
    }
  }

  if (!btn) {
    logd("no transcript button found after expanding description");
    return [];
  }

  logd("clicking transcript button", {
    label:
      btn.getAttribute("aria-label") ?? btn.textContent?.trim().slice(0, 60),
    tag: btn.tagName,
  });
  fireRealClick(btn);

  for (let i = 0; i < 40; i++) {
    await sleep(150);
    cues = readSegmentsFromDom();
    if (cues.length) {
      logd("segments rendered after click, ms", i * 150);
      return cues;
    }
    cues = readSegmentsByPattern();
    if (cues.length) {
      logd("segments rendered after click (pattern), ms", i * 150);
      return cues;
    }
    if (i === 4 || i === 14 || i === 39) dumpTranscriptDomState();
  }
  logd("segments never appeared after click; aborting");
  return [];
}

function parseTimestamp(ts: string): number {
  const parts = ts.split(":").map((p) => parseInt(p, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

async function extractTranscript(): Promise<{
  cues: TranscriptCue[];
  videoMeta: VideoMeta;
}> {
  const main = await readMainWorldPayload();
  const playerResp = main?.playerResponse ?? null;
  const videoId = playerResp?.videoDetails?.videoId ?? getVideoId() ?? "";
  if (!videoId) throw new Error("Could not determine video ID.");

  const videoMeta: VideoMeta = {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title:
      playerResp?.videoDetails?.title ??
      document.title.replace(/ - YouTube$/, ""),
    channel: playerResp?.videoDetails?.author ?? "",
    durationSeconds: playerResp?.videoDetails?.lengthSeconds
      ? parseInt(playerResp.videoDetails.lengthSeconds, 10)
      : null,
  };

  // Primary: open the transcript panel via the description chip and scrape
  // the rendered `transcript-segment-view-model` elements. We previously tried
  // calling /youtubei/v1/get_transcript directly, but YT's "Precondition check
  // failed" requires a per-request SAPISIDHASH header that's brittle to
  // replicate. DOM scrape avoids all that.
  const domCues = await openAndScrapeTranscript();
  if (domCues.length) return { cues: domCues, videoMeta };

  // 3. timedtext (mostly broken due to PoT, kept as last resort)
  const tracks =
    playerResp?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const pick = pickCaptionTrack(tracks);
  if (pick) {
    try {
      const cues = await fetchTranscriptCues(pick.baseUrl);
      if (cues.length) return { cues, videoMeta };
    } catch (err) {
      console.warn("cnstlltn: timedtext fetch failed", err);
    }
  }

  throw new Error(
    "No transcript available. Open the transcript panel manually or paste text in the side panel.",
  );
}

// Cheap metadata read — NO transcript panel, no scraping. Used to keep the
// side panel's displayed video in sync as the user navigates between videos.
async function readVideoMetaCheap(): Promise<VideoMeta | null> {
  const videoId = getVideoId();
  if (!videoId) return null;
  const main = await readMainWorldPayload();
  // Only trust the player response if it's for THIS video — it can lag behind
  // SPA navigation. Otherwise fall back to the (always-current) document title.
  const det = main?.playerResponse?.videoDetails;
  const fresh = det && det.videoId === videoId ? det : undefined;
  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: fresh?.title ?? document.title.replace(/ - YouTube$/, ""),
    channel: fresh?.author ?? "",
    durationSeconds: fresh?.lengthSeconds
      ? parseInt(fresh.lengthSeconds, 10)
      : null,
  };
}

async function pushVideoMeta(): Promise<void> {
  if (!isWatchPage()) return;
  try {
    const videoMeta = await readVideoMetaCheap();
    if (videoMeta) {
      await chrome.runtime.sendMessage({ type: "SET_VIDEO_META", videoMeta });
    }
  } catch (err) {
    console.warn("cnstlltn: pushVideoMeta failed", err);
  }
}

function ensureButton() {
  if (!isWatchPage()) {
    document.getElementById(BUTTON_ID)?.remove();
    return;
  }
  if (document.getElementById(BUTTON_ID)) return;

  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  // Constellation glyph (white asterism) + wordmark — matches the extension icon.
  btn.innerHTML = `
    <svg width="16" height="16" viewBox="0 0 100 100" aria-hidden="true" style="display:block">
      <g stroke="#ffffff" stroke-opacity="0.55" stroke-width="4" stroke-linecap="round">
        <line x1="30" y1="34" x2="71" y2="27"/>
        <line x1="71" y1="27" x2="74" y2="71"/>
        <line x1="74" y1="71" x2="34" y2="73"/>
        <line x1="34" y1="73" x2="30" y2="34"/>
      </g>
      <g fill="#ffffff">
        <circle cx="30" cy="34" r="11"/>
        <circle cx="71" cy="27" r="8.5"/>
        <circle cx="74" cy="71" r="9.5"/>
        <circle cx="34" cy="73" r="8.5"/>
      </g>
    </svg>
    <span>cnstlltn</span>`;
  Object.assign(btn.style, {
    position: "fixed",
    right: "20px",
    bottom: "20px",
    zIndex: "2147483647",
    display: "inline-flex",
    alignItems: "center",
    gap: "8px",
    padding: "10px 16px",
    background: "#4285F4",
    color: "#ffffff",
    border: "none",
    borderRadius: "9999px",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(60,64,67,0.35)",
    fontFamily: "system-ui, -apple-system, sans-serif",
  } as Partial<CSSStyleDeclaration>);

  btn.addEventListener("click", () => {
    // Open the side panel synchronously while we still hold the user gesture —
    // chrome.sidePanel.open() rejects if called after any `await`. We no longer
    // scrape the transcript here; that's deferred until the user clicks
    // "Generate notes from this video". We just push cheap metadata so the
    // panel shows the current video right away.
    chrome.runtime
      .sendMessage({ type: "OPEN_SIDE_PANEL" })
      .catch((err) => console.warn("cnstlltn: open-panel send failed", err));
    void pushVideoMeta();
  });

  document.body.appendChild(btn);
}

// Generate-time transcript extraction: the side panel asks us to scrape the
// transcript for the current video, then we store it as the session.
chrome.runtime.onMessage.addListener((rawMsg, _sender, sendResponse) => {
  if ((rawMsg as { type?: string })?.type !== "EXTRACT_TRANSCRIPT") return false;
  (async () => {
    try {
      const { cues, videoMeta } = await extractTranscript();
      const transcriptVtt = cuesToVtt(cues);
      const payload: SessionPayload = { cues, videoMeta, transcriptVtt };
      const resp = await chrome.runtime.sendMessage({
        type: "TRANSCRIPT_READY",
        payload,
      });
      if (!resp?.ok) throw new Error(resp?.error ?? "Background did not respond.");
      sendResponse({ ok: true, result: { cues: cues.length } });
    } catch (err) {
      console.error("cnstlltn: extract failed", err);
      sendResponse({ ok: false, error: (err as Error).message });
    }
  })();
  return true; // async sendResponse
});

function init() {
  const onNav = () => {
    setTimeout(() => {
      ensureButton();
      // Keep the side panel's displayed video in sync with the current one.
      void pushVideoMeta();
    }, 300);
  };
  ensureButton();
  void pushVideoMeta();
  document.addEventListener("yt-navigate-finish", onNav);
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onNav();
    }
  });
  observer.observe(document, { subtree: true, childList: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
