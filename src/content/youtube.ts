import { timedtextJson3ToCues, cuesToVtt } from "@/lib/vtt";
import type { SessionPayload, TranscriptCue, VideoMeta } from "@/lib/types";

const BUTTON_ID = "notetaker-fab";

function isWatchPage(): boolean {
  return /^\/watch/.test(location.pathname);
}

function getVideoId(): string | null {
  return new URLSearchParams(location.search).get("v");
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
}

function readPlayerResponseFromPage(): Promise<PlayerResponse | null> {
  return new Promise((resolve) => {
    const token = `__notetaker_${Math.random().toString(36).slice(2)}`;

    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== window) return;
      const data = ev.data;
      if (!data || data.token !== token) return;
      window.removeEventListener("message", onMessage);
      resolve(data.payload ?? null);
    };
    window.addEventListener("message", onMessage);

    const script = document.createElement("script");
    script.textContent = `
      (function(){
        try {
          var pr = window.ytInitialPlayerResponse || null;
          window.postMessage({ token: ${JSON.stringify(token)}, payload: pr }, '*');
        } catch (e) {
          window.postMessage({ token: ${JSON.stringify(token)}, payload: null }, '*');
        }
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();

    setTimeout(() => {
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, 1500);
  });
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
  const sep = baseUrl.includes("?") ? "&" : "?";
  const url = baseUrl + sep + "fmt=json3";
  const resp = await fetch(url, { credentials: "include" });
  if (!resp.ok) {
    throw new Error(`Failed to fetch transcript (${resp.status}).`);
  }
  const json = await resp.json();
  return timedtextJson3ToCues(json);
}

async function scrapeTranscriptFromDom(): Promise<TranscriptCue[]> {
  const segments = document.querySelectorAll(
    "ytd-transcript-segment-renderer",
  );
  if (!segments.length) return [];
  const cues: TranscriptCue[] = [];
  segments.forEach((el) => {
    const timeEl = el.querySelector(".segment-timestamp");
    const textEl = el.querySelector(".segment-text");
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
  const playerResp = await readPlayerResponseFromPage();
  const videoId = playerResp?.videoDetails?.videoId ?? getVideoId() ?? "";
  if (!videoId) throw new Error("Could not determine video ID.");

  const videoMeta: VideoMeta = {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: playerResp?.videoDetails?.title ?? document.title.replace(/ - YouTube$/, ""),
    channel: playerResp?.videoDetails?.author ?? "",
    durationSeconds: playerResp?.videoDetails?.lengthSeconds
      ? parseInt(playerResp.videoDetails.lengthSeconds, 10)
      : null,
  };

  const tracks =
    playerResp?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const pick = pickCaptionTrack(tracks);
  if (pick) {
    try {
      const cues = await fetchTranscriptCues(pick.baseUrl);
      if (cues.length) return { cues, videoMeta };
    } catch (err) {
      console.warn("notetaker: timedtext fetch failed, trying DOM", err);
    }
  }

  const domCues = await scrapeTranscriptFromDom();
  if (domCues.length) return { cues: domCues, videoMeta };

  throw new Error(
    "No transcript available. Open the transcript panel manually or paste text in the side panel.",
  );
}

function ensureButton() {
  if (!isWatchPage()) {
    document.getElementById(BUTTON_ID)?.remove();
    return;
  }
  if (document.getElementById(BUTTON_ID)) return;

  const btn = document.createElement("button");
  btn.id = BUTTON_ID;
  btn.textContent = "📝 Notetaker";
  Object.assign(btn.style, {
    position: "fixed",
    right: "20px",
    bottom: "20px",
    zIndex: "2147483647",
    padding: "10px 14px",
    background: "#0f172a",
    color: "#f8fafc",
    border: "1px solid #334155",
    borderRadius: "9999px",
    fontSize: "13px",
    fontWeight: "600",
    cursor: "pointer",
    boxShadow: "0 6px 16px rgba(0,0,0,0.25)",
    fontFamily: "system-ui, -apple-system, sans-serif",
  } as Partial<CSSStyleDeclaration>);

  btn.addEventListener("click", async () => {
    const original = btn.textContent;
    btn.textContent = "📝 extracting…";
    btn.setAttribute("disabled", "true");
    try {
      const { cues, videoMeta } = await extractTranscript();
      const transcriptVtt = cuesToVtt(cues);
      const payload: SessionPayload = { cues, videoMeta, transcriptVtt };
      const resp = await chrome.runtime.sendMessage({
        type: "TRANSCRIPT_READY",
        payload,
      });
      if (!resp?.ok) {
        throw new Error(resp?.error ?? "Background did not respond.");
      }
      btn.textContent = "📝 opened in side panel";
      setTimeout(() => {
        btn.textContent = original;
        btn.removeAttribute("disabled");
      }, 2000);
    } catch (err) {
      console.error("notetaker: extract failed", err);
      btn.textContent = "📝 failed — see console";
      setTimeout(() => {
        btn.textContent = original;
        btn.removeAttribute("disabled");
      }, 3000);
    }
  });

  document.body.appendChild(btn);
}

function init() {
  ensureButton();
  document.addEventListener("yt-navigate-finish", () => {
    setTimeout(ensureButton, 300);
  });
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(ensureButton, 300);
    }
  });
  observer.observe(document, { subtree: true, childList: true });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
