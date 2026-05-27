import { z } from "zod";

export const SCHEMA_VERSION = 1;
export const DEFAULT_MODEL = "gemini-2.5-pro";

export const ClaimType = z.enum([
  "argument",
  "fact",
  "definition",
  "counter",
  "example",
  "question",
]);
export type ClaimType = z.infer<typeof ClaimType>;

export const LLMNote = z.object({
  title: z.string().describe("Concise title for the note."),
  content: z
    .string()
    .describe(
      "Note body in plain markdown (no leading heading, no bullet/number prefix).",
    ),
  claim_type: ClaimType,
  tags: z.array(z.string()),
  start_seconds: z
    .number()
    .int()
    .nonnegative()
    .describe("Seconds into the source where this idea begins."),
  end_seconds: z
    .number()
    .int()
    .nonnegative()
    .describe("Seconds into the source where this idea ends."),
  flag: z
    .boolean()
    .describe(
      "True if the source contains more detail on this note worth drilling into.",
    ),
  speaker: z
    .string()
    .nullable()
    .describe("Speaker name if clearly attributable, else null."),
});
export type LLMNote = z.infer<typeof LLMNote>;

export const LLMNotes = z.object({
  notes: z.array(LLMNote),
});
export type LLMNotes = z.infer<typeof LLMNotes>;

export interface VideoMeta {
  videoId: string;
  url: string;
  title: string;
  channel: string;
  durationSeconds: number | null;
}

export interface TranscriptCue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

export interface NoteFrontmatter {
  id: string;
  title: string;
  topic: string;
  created: string;
  updated: string;
  schema_version: number;
  source: {
    type: "youtube";
    url: string;
    source_id: string;
    video_id: string;
    channel: string;
    start_seconds: number;
    end_seconds: number;
    speaker: string | null;
  };
  parents: string[];
  children: string[];
  related: { id: string; rel: string }[];
  tags: string[];
  claim_type: ClaimType;
  flag: boolean;
  status: "active" | "superseded" | "draft";
  content_hash: string;
  model: string;
}

export interface TopicFrontmatter {
  id: string;
  title: string;
  created: string;
  status: "active" | "archived";
  schema_version: number;
  main_arguments: { id: string; label: string; stance: string }[];
  key_voices: string[];
}

export interface Settings {
  geminiApiKey: string;
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
  model: string;
}

export interface SessionPayload {
  videoMeta: VideoMeta;
  cues: TranscriptCue[];
  transcriptVtt: string;
}

export type Msg =
  | { type: "TRANSCRIPT_READY"; payload: SessionPayload }
  | { type: "OPEN_SIDE_PANEL"; tabId: number }
  | { type: "GET_SESSION" }
  | { type: "LIST_TOPICS" }
  | { type: "LIST_NOTES_FOR_TOPIC"; topic: string }
  | { type: "GENERATE_ROOT"; topic: string }
  | {
      type: "GENERATE_DRILL";
      topic: string;
      parentNote: { title: string; content: string };
    }
  | {
      type: "COMMIT_NOTES";
      topic: string;
      topicTitle: string | null;
      isNewTopic: boolean;
      includeTranscript: boolean;
      llmNotes: LLMNote[];
      parents: string[];
    }
  | { type: "TEST_CONNECTION" }
  | { type: "CREATE_REPO" };

export interface CommittedNoteRef {
  id: string;
  title: string;
  path: string;
}

export interface CommitResult {
  sha: string;
  url: string;
  noteRefs: CommittedNoteRef[];
}
