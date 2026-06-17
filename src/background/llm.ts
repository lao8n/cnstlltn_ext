import { GoogleGenAI, Type } from "@google/genai";
import { getSettings } from "@/lib/storage";
import { LLMNotes, type LLMNote, type TranscriptCue } from "@/lib/types";
import { cuesToPromptText, refineNoteTimestamps } from "@/lib/vtt";

const ROOT_SYSTEM_PROMPT = `You are an assistant that converts the transcript of a video into atomic, reusable knowledge-base notes for a personal mind map.

Rules:
- Each note is a single self-contained idea: argument, fact, definition, counter-argument, illustrative example, or open question.
- Notes must be drawn from what is actually said in the transcript. Do not invent.
- Note bodies are plain prose markdown. No leading heading. No bullet/number prefix. No filler like "the speaker says".
- LENGTH: keep each note concise — roughly 80–100 words (about 4–6 sentences), and never more than ~120 words. Capture the core claim plus its single most important piece of supporting evidence, reasoning, or caveat from the transcript. Omit padding and restatement; a tight note is better than an exhaustive one.
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
- LENGTH: keep each sub-note concise — roughly 60–80 words (about 3–5 sentences), and never more than ~100 words. Focus on one specific detail drawn from the transcript; omit padding.
- TIMESTAMPS: copy start_seconds and end_seconds from the (Ns) markers on the first and last transcript lines each sub-note uses. end_seconds must exceed start_seconds and both must fall inside the parent's range.
- HARD CONSTRAINT: every sub-note's [start_seconds, end_seconds] must fall within the parent's range. Siblings may overlap each other but must all sit inside the parent's window.
- flag is true if a sub-note itself has more detail in the transcript worth drilling into further.
- gold: set to true ONLY when a TOPIC GOAL is provided AND the sub-note clearly (a) advances that goal AND (b) is not substantially covered by any note in the EXISTING NOTES list. Otherwise false.
- Do not restate the parent note. Each sub-note must add something the parent does not already say.`;

const MIN_ROOT_WORDS = 50;
const MIN_DRILL_WORDS = 35;

const NOTE_PROPS = {
  title: {
    type: Type.STRING,
    description: "Concise title for the note.",
  },
  content: {
    type: Type.STRING,
    description:
      "Concise note body: ~80-100 words (about 4-6 sentences), never more than ~120. Plain prose markdown. Core idea plus key support; no padding.",
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

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function notesTooShort(notes: LLMNote[], minWords: number): boolean {
  return notes.some((n) => countWords(n.content) < minWords);
}

async function callNoteGenerator(args: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  minWords: number;
}): Promise<LLMNote[]> {
  const ai = await getClient();
  let userPrompt = args.userPrompt;
  let lastNotes: LLMNote[] | null = null;

  // We request concise notes in the prompt and give the model one retry nudge
  // only if a note comes back implausibly thin. Length is a soft preference,
  // not a hard requirement — if the model still returns a short note we use it
  // anyway rather than failing the whole run.
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
    lastNotes = validated.notes;
    if (!notesTooShort(validated.notes, args.minWords)) {
      return validated.notes;
    }
    userPrompt =
      args.userPrompt +
      `\n\nRETRY — some notes were too thin. Every "content" field MUST be at least ${args.minWords} words of substantive prose (the core claim plus its key support or caveat). Stay concise — do not pad — but do not return one-line summaries.`;
  }

  // Still short after the retry nudge — accept what we have instead of erroring.
  return lastNotes ?? [];
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

CRITICAL: keep each note "content" concise — about 80–100 words (4–6 sentences) and no more than ~120 words. Capture the core idea, not an exhaustive summary.

TIMESTAMPS: for each note, set start_seconds and end_seconds from the (Ns) integers on the first and last transcript lines you used — not from [mm:ss] display times.${goldContextBlock(args)}`;
  const notes = await callNoteGenerator({
    systemPrompt: ROOT_SYSTEM_PROMPT,
    userPrompt,
    model,
    minWords: MIN_ROOT_WORDS,
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

CRITICAL: keep each sub-note "content" concise — about 60–80 words (3–5 sentences) and no more than ~100 words.

TIMESTAMPS: copy (Ns) integers from the transcript lines — stay inside [${args.parentStartSeconds}, ${args.parentEndSeconds}].${goldContextBlock(args)}`;
  const slicedForSnap = slicedCues.length ? slicedCues : args.cues;
  const notes = await callNoteGenerator({
    systemPrompt: DRILL_SYSTEM_PROMPT,
    userPrompt,
    model,
    minWords: MIN_DRILL_WORDS,
  });
  return refineNoteTimestamps(notes, slicedForSnap, {
    minSeconds: args.parentStartSeconds,
    maxSeconds: args.parentEndSeconds,
  });
}
