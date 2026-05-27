import { GoogleGenAI, Type } from "@google/genai";
import { getSettings } from "@/lib/storage";
import { LLMNotes, type LLMNote, type TranscriptCue } from "@/lib/types";
import { cuesToPromptText } from "@/lib/vtt";

const ROOT_SYSTEM_PROMPT = `You are an assistant that converts the transcript of a video into atomic, reusable knowledge-base notes for a personal mind map.

Rules:
- Each note is a single self-contained idea: argument, fact, definition, counter-argument, illustrative example, or open question.
- Notes must be drawn from what is actually said in the transcript. Do not invent.
- Note bodies are plain prose markdown. No leading heading. No bullet/number prefix. No filler like "the speaker says".
- When a direct quote sharpens the note, include it inline in quotation marks.
- Tags are short lowercase keywords useful for clustering (3-6 per note).
- start_seconds and end_seconds bracket the portion of the transcript the note is drawn from.
- flag is true when the transcript clearly contains more detail on this note than your summary captures.
- speaker is the named individual the idea is attributed to if clear, else null.

Aim for 5-12 candidate notes. Prefer fewer, denser notes over many shallow ones.`;

const DRILL_SYSTEM_PROMPT = `You are expanding a single note from a knowledge base into more granular sub-notes, using the original transcript as the source of truth.

Rules:
- Produce 3-8 sub-notes that each cover detail the parent note compresses or omits.
- Sub-notes obey the same atomicity and formatting rules as the original notes (plain prose, no headings, no bullet prefixes, direct quotes when sharp).
- Sub-note start/end seconds reference the original transcript.
- flag is true if a sub-note itself has more detail in the transcript worth drilling into further.
- Do not restate the parent note. Each sub-note must add something the parent does not already say.`;

const NOTE_PROPS = {
  title: { type: Type.STRING },
  content: { type: Type.STRING },
  claim_type: {
    type: Type.STRING,
    enum: ["argument", "fact", "definition", "counter", "example", "question"],
  },
  tags: { type: Type.ARRAY, items: { type: Type.STRING } },
  start_seconds: { type: Type.INTEGER },
  end_seconds: { type: Type.INTEGER },
  flag: { type: Type.BOOLEAN },
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

async function callNoteGenerator(args: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
}): Promise<LLMNote[]> {
  const ai = await getClient();
  const response = await ai.models.generateContent({
    model: args.model,
    contents: args.userPrompt,
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
  return validated.notes;
}

export async function generateRootNotes(args: {
  cues: TranscriptCue[];
  videoTitle: string;
  channel: string;
}): Promise<LLMNote[]> {
  const { model } = await getSettings();
  const transcriptText = cuesToPromptText(args.cues);
  const userPrompt = `Video title: ${args.videoTitle}
Channel: ${args.channel}

Transcript (each line is one cue, prefixed with [mm:ss] (seconds)):
${transcriptText}

Produce candidate notes following the rules in the system message.`;
  return callNoteGenerator({
    systemPrompt: ROOT_SYSTEM_PROMPT,
    userPrompt,
    model,
  });
}

export async function generateDrillNotes(args: {
  cues: TranscriptCue[];
  videoTitle: string;
  channel: string;
  parentTitle: string;
  parentContent: string;
}): Promise<LLMNote[]> {
  const { model } = await getSettings();
  const transcriptText = cuesToPromptText(args.cues);
  const userPrompt = `Video title: ${args.videoTitle}
Channel: ${args.channel}

Parent note title: ${args.parentTitle}
Parent note body:
${args.parentContent}

Full transcript (for reference):
${transcriptText}

Produce sub-notes drilling into the parent, following the rules in the system message.`;
  return callNoteGenerator({
    systemPrompt: DRILL_SYSTEM_PROMPT,
    userPrompt,
    model,
  });
}
