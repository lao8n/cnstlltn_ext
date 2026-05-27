import type { TranscriptCue } from "./types";

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
