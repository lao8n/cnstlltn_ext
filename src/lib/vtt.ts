import type { LLMNote, TranscriptCue } from "./types";

function pad(n: number, width = 2): string {
  return n.toString().padStart(width, "0");
}

function secondsToVttTimestamp(s: number): string {
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = Math.floor(s % 60);
  const millis = Math.round((s - Math.floor(s)) * 1000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

function secondsToShortTimestamp(s: number): string {
  const minutes = Math.floor(s / 60);
  const seconds = Math.floor(s % 60);
  return `${pad(minutes)}:${pad(seconds)}`;
}

export function cuesToVtt(cues: TranscriptCue[]): string {
  const lines = ["WEBVTT", ""];
  for (const cue of cues) {
    lines.push(
      `${secondsToVttTimestamp(cue.startSeconds)} --> ${secondsToVttTimestamp(cue.endSeconds)}`,
    );
    lines.push(cue.text.replace(/\r?\n/g, " ").trim());
    lines.push("");
  }
  return lines.join("\n");
}

function findCueIndexAt(cues: TranscriptCue[], seconds: number): number {
  const idx = cues.findIndex(
    (c) => c.startSeconds <= seconds && c.endSeconds >= seconds,
  );
  if (idx >= 0) return idx;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < cues.length; i++) {
    const dist = Math.min(
      Math.abs(cues[i].startSeconds - seconds),
      Math.abs(cues[i].endSeconds - seconds),
    );
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

/** Snap LLM timestamps to real cue boundaries so start/end match the video. */
export function refineNoteTimestamps(
  notes: LLMNote[],
  cues: TranscriptCue[],
  bounds?: { minSeconds: number; maxSeconds: number },
): LLMNote[] {
  if (!cues.length) return notes;
  const lastEnd = Math.ceil(cues[cues.length - 1].endSeconds);

  return notes.map((note) => {
    let start = Math.max(0, Math.min(note.start_seconds ?? 0, lastEnd));
    let end = Math.max(0, Math.min(note.end_seconds ?? lastEnd, lastEnd));

    if (bounds) {
      start = Math.max(bounds.minSeconds, start);
      end = Math.min(bounds.maxSeconds, end);
    }

    const startIdx = findCueIndexAt(cues, start);
    const endIdx = findCueIndexAt(cues, end);
    const lo = Math.min(startIdx, endIdx);
    const hi = Math.max(startIdx, endIdx);

    start = Math.floor(cues[lo].startSeconds);
    end = Math.ceil(cues[hi].endSeconds);

    if (bounds) {
      start = Math.max(bounds.minSeconds, start);
      end = Math.min(bounds.maxSeconds, end);
    }
    if (end <= start) {
      end = Math.min(
        bounds?.maxSeconds ?? lastEnd,
        Math.ceil(cues[lo].endSeconds),
      );
    }
    if (end <= start) end = start + 1;

    return { ...note, start_seconds: start, end_seconds: end };
  });
}

export function cuesToPromptText(cues: TranscriptCue[]): string {
  const buf: string[] = [];
  for (const cue of cues) {
    const t = secondsToShortTimestamp(cue.startSeconds);
    buf.push(`[${t}] (${Math.round(cue.startSeconds)}s) ${cue.text}`);
  }
  return buf.join("\n");
}

interface TimedTextJson3 {
  events?: {
    tStartMs?: number;
    dDurationMs?: number;
    segs?: { utf8?: string }[];
  }[];
}

export function timedtextJson3ToCues(json: TimedTextJson3): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  for (const ev of json.events ?? []) {
    const startMs = ev.tStartMs ?? 0;
    const durMs = ev.dDurationMs ?? 0;
    const text = (ev.segs ?? [])
      .map((s) => s.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    cues.push({
      startSeconds: startMs / 1000,
      endSeconds: (startMs + durMs) / 1000,
      text,
    });
  }
  return cues;
}
