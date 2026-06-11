import { GoogleGenAI, Type } from "@google/genai";
import { getSettings } from "@/lib/storage";
import { LLMNotes, type LLMNote, type TranscriptCue } from "@/lib/types";
import { cuesToPromptText, refineNoteTimestamps } from "@/lib/vtt";

const ROOT_SYSTEM_PROMPT = `You are an assistant that converts the transcript of a video into atomic, reusable knowledge-base notes for a personal mind map.

Rules:
- Each note is a single self-contained idea: argument, fact, definition, counter-argument, illustrative example, or open question.
- Notes must be drawn from what is actually said in the transcript. Do not invent.
- Note bodies are plain prose markdown. No leading heading. No bullet/number prefix. No filler like "the speaker says".
- LENGTH: each note body must be substantial — roughly 8–12 sentences. Cover the claim, supporting evidence, reasoning, nuance, and any caveats or qualifications stated in the transcript. Do not stop at a one- or two-sentence summary.
- When a direct quote sharpens the note, include one or two inline in quotation marks.
- Tags are short lowercase keywords useful for clustering (3-6 per note).
- TIMESTAMPS: start_seconds and end_seconds MUST be copied from the transcript line markers — use the integer inside (Ns) on the FIRST line the note draws from for start_seconds, and the integer on the LAST line for end_seconds. end_seconds must be greater than start_seconds. Never guess wall-clock times; never set start_seconds equal to end_seconds unless the note truly comes from a single cue line.
- flag is true when the transcript clearly contains more detail on this note than your summary captures.
- gold: set to true ONLY when a TOPIC GOAL is provided AND the note clearly (a) advances that goal AND (b) is not substantially covered by any note in the EXISTING NOTES list. If no topic goal or existing notes are provided, set gold=false for every note. Be selective — gold is for genuinely new, on-goal information; not for every interesting note.
- speaker is the named individual the idea is attributed to if clear, else null.

Aim for 5–10 candidate notes. Prefer fewer, richly detailed notes over many shallow ones.`;

const DRILL_SYSTEM_PROMPT = `You are expanding a single note from a knowledge base into more granular sub-notes, using the original transcript as the source of truth.

Rules:
- Produce 3-8 sub-notes that each cover detail the parent note compresses or omits.
- Sub-notes obey the same atomicity and formatting rules as the original notes (plain prose, no headings, no bullet prefixes, direct quotes when sharp).
- LENGTH: each sub-note body must be substantial — roughly 6–10 sentences of detailed prose drawn from the transcript. Do not produce thin one- or two-sentence summaries.
- TIMESTAMPS: copy start_seconds and end_seconds from the (Ns) markers on the first and last transcript lines each sub-note uses. end_seconds must exceed start_seconds and both must fall inside the parent's range.
- HARD CONSTRAINT: every sub-note's [start_seconds, end_seconds] must fall within the parent's range. Siblings may overlap each other but must all sit inside the parent's window.
- flag is true if a sub-note itself has more detail in the transcript worth drilling into further.
- gold: set to true ONLY when a TOPIC GOAL is provided AND the sub-note clearly (a) advances that goal AND (b) is not substantially covered by any note in the EXISTING NOTES list. Otherwise false.
- Do not restate the parent note. Each sub-note must add something the parent does not already say.`;

const MIN_ROOT_SENTENCES = 8;
const MIN_DRILL_SENTENCES = 6;

const NOTE_PROPS = {
  title: {
    type: Type.STRING,
    description: "Concise title for the note.",
  },
  content: {
    type: Type.STRING,
    description:
      "Detailed note body: 8-12 full sentences (~150-250 words). Plain prose markdown. Never a one- or two-sentence summary.",
  },
  claim_type: {
    type: Type.STRING,
    enum: ["argument", "fact", "definition", "counter", "example", "question"],
  },
  tags: { type: Type.ARRAY, items: { type: Type.STRING } },
  start_seconds: {
    type: Type.INTEGER,
    description:
      "Seconds from the (Ns) marker on the FIRST transcript line this note uses.",
  },
  end_seconds: {
    type: Type.INTEGER,
    description:
      "Seconds from the (Ns) marker on the LAST transcript line this note uses. Must be > start_seconds.",
  },
  flag: { type: Type.BOOLEAN },
  gold: {
    type: Type.BOOLEAN,
    description:
      "True ONLY if a topic goal is provided AND the note advances it AND isn't substantially covered by existing notes. Otherwise false.",
  },
  speaker: { type: Type.STRING, nullable: true },
};

const NOTES_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    notes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: NOTE_PROPS,
        required: [
          "title",
          "content",
          "claim_type",
          "tags",
          "start_seconds",
          "end_seconds",
          "flag",
          "gold",
          "speaker",
        ],
        propertyOrdering: [
          "title",
          "content",
          "claim_type",
          "tags",
          "start_seconds",
          "end_seconds",
          "flag",
          "gold",
          "speaker",
        ],
      },
    },
  },
  required: ["notes"],
};

async function getClient(): Promise<GoogleGenAI> {
  const { geminiApiKey } = await getSettings();
  if (!geminiApiKey) throw new Error("Gemini API key not configured.");
  return new GoogleGenAI({ apiKey: geminiApiKey });
}

function countSentences(text: string): number {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12).length;
}

function notesTooShort(notes: LLMNote[], minSentences: number): boolean {
  return notes.some((n) => countSentences(n.content) < minSentences);
}

async function callNoteGenerator(args: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  minSentences: number;
}): Promise<LLMNote[]> {
  const ai = await getClient();
  let userPrompt = args.userPrompt;

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await ai.models.generateContent({
      model: args.model,
      contents: userPrompt,
      config: {
        systemInstruction: args.systemPrompt,
        responseMimeType: "application/json",
        responseSchema: NOTES_SCHEMA,
      },
    });
    const raw = response.text;
    if (!raw) throw new Error("Gemini returned no content.");
    const parsed = JSON.parse(raw);
    const validated = LLMNotes.parse(parsed);
    if (!notesTooShort(validated.notes, args.minSentences)) {
      return validated.notes;
    }
    userPrompt =
      args.userPrompt +
      `\n\nRETRY — your previous output was too short. Every "content" field MUST be at least ${args.minSentences} complete sentences (~150+ words each). Expand with reasoning, evidence, quotes, and nuance from the transcript. Do not return one- or two-sentence summaries.`;
  }

  throw new Error(
    `Gemini returned notes that were too short (need ~${args.minSentences} sentences each). Try gemini-2.5-flash instead of flash-lite in Settings.`,
  );
}

function goldContextBlock(args: {
  topicGoal?: string | null;
  existingNotes?: { title: string; content: string }[] | null;
}): string {
  const hasGoal = !!args.topicGoal?.trim();
  const hasExisting = (args.existingNotes?.length ?? 0) > 0;
  if (!hasGoal && !hasExisting) return "";
  const parts: string[] = [];
  if (hasGoal) parts.push(`TOPIC GOAL: ${args.topicGoal!.trim()}`);
  if (hasExisting) {
    parts.push(
      "EXISTING NOTES IN THIS TOPIC (title + body — anything substantially covered here should NOT be marked gold):",
    );
    for (const n of args.existingNotes!) {
      parts.push(`- ${n.title}\n  ${n.content.replace(/\s+/g, " ").trim()}`);
    }
  }
  parts.push(
    "Use these to decide each candidate's gold flag. Otherwise leave it false.",
  );
  return "\n\n" + parts.join("\n");
}

export async function generateRootNotes(args: {
  cues: TranscriptCue[];
  videoTitle: string;
  channel: string;
  topicGoal?: string | null;
  existingNotes?: { title: string; content: string }[] | null;
}): Promise<LLMNote[]> {
  const { model } = await getSettings();
  const transcriptText = cuesToPromptText(args.cues);
  const userPrompt = `Video title: ${args.videoTitle}
Channel: ${args.channel}

Transcript (each line is one cue, prefixed with [mm:ss] (seconds)):
${transcriptText}

Produce candidate notes following the rules in the system message.

CRITICAL: each note "content" must be 8-12 full sentences (~150-250 words). One-sentence summaries are not acceptable.

TIMESTAMPS: for each note, set start_seconds and end_seconds from the (Ns) integers on the first and last transcript lines you used — not from [mm:ss] display times.${goldContextBlock(args)}`;
  const notes = await callNoteGenerator({
    systemPrompt: ROOT_SYSTEM_PROMPT,
    userPrompt,
    model,
    minSentences: MIN_ROOT_SENTENCES,
  });
  return refineNoteTimestamps(notes, args.cues);
}

export async function generateDrillNotes(args: {
  cues: TranscriptCue[];
  videoTitle: string;
  channel: string;
  parentTitle: string;
  parentContent: string;
  parentStartSeconds: number;
  parentEndSeconds: number;
  topicGoal?: string | null;
  existingNotes?: { title: string; content: string }[] | null;
}): Promise<LLMNote[]> {
  const { model } = await getSettings();
  // Slice the transcript to the parent's window (with a small buffer) so the
  // model focuses on the relevant span and so we save tokens.
  const sliceStart = Math.max(0, args.parentStartSeconds - 5);
  const sliceEnd = args.parentEndSeconds + 5;
  const slicedCues = args.cues.filter(
    (c) => c.endSeconds >= sliceStart && c.startSeconds <= sliceEnd,
  );
  const transcriptText = cuesToPromptText(
    slicedCues.length ? slicedCues : args.cues,
  );
  const userPrompt = `Video title: ${args.videoTitle}
Channel: ${args.channel}

Parent note title: ${args.parentTitle}
Parent note body:
${args.parentContent}

Parent time range: [${args.parentStartSeconds}, ${args.parentEndSeconds}] seconds. Every sub-note's start_seconds and end_seconds MUST fall inside this range.

Transcript slice covering the parent's window:
${transcriptText}

Produce sub-notes drilling into the parent, following the rules in the system message.

CRITICAL: each sub-note "content" must be 6-10 full sentences (~120-200 words). One-sentence summaries are not acceptable.

TIMESTAMPS: copy (Ns) integers from the transcript lines — stay inside [${args.parentStartSeconds}, ${args.parentEndSeconds}].${goldContextBlock(args)}`;
  const slicedForSnap = slicedCues.length ? slicedCues : args.cues;
  const notes = await callNoteGenerator({
    systemPrompt: DRILL_SYSTEM_PROMPT,
    userPrompt,
    model,
    minSentences: MIN_DRILL_SENTENCES,
  });
  return refineNoteTimestamps(notes, slicedForSnap, {
    minSeconds: args.parentStartSeconds,
    maxSeconds: args.parentEndSeconds,
  });
}
