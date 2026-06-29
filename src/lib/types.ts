import { z } from "zod";

export const SCHEMA_VERSION = 1;
export const DEFAULT_MODEL = "gemini-2.5-flash";

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
      "Note body in plain markdown (no leading heading, no bullet/number prefix). Roughly 8-12 sentences for root notes, 6-10 for drill sub-notes.",
    ),
  claim_type: ClaimType,
  tags: z.array(z.string()),
  start_seconds: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Seconds where this idea begins (video sources only)."),
  end_seconds: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Seconds where this idea ends (video sources only)."),
  quote: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Short verbatim quote anchoring this note in the source (article/web sources).",
    ),
  flag: z
    .boolean()
    .describe(
      "True if the source contains more detail on this note worth drilling into.",
    ),
  gold: z
    .boolean()
    .describe(
      "True ONLY when a topic goal is given AND this note (a) advances the goal AND (b) is not substantially covered by any existing note in the topic. False otherwise — including when no topic goal or existing notes are provided.",
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

// --- Analyse tab ---------------------------------------------------------
// The Analyse tab reflects on the corpus of notes already committed to a
// topic (not a live transcript). Each "lens" is a standardised flow the LLM
// runs over those notes, returning a set of read-only cards.
export const AnalysisLens = z.enum(["notes", "gaps"]);
export type AnalysisLens = z.infer<typeof AnalysisLens>;

export const AnalysisCard = z.object({
  title: z.string().describe("Short heading naming the argument, position, or gap."),
  body: z.string().describe("Analysis prose, ~80-120 words."),
});
export type AnalysisCard = z.infer<typeof AnalysisCard>;

export const AnalysisResult = z.object({
  cards: z.array(AnalysisCard),
});
export type AnalysisResult = z.infer<typeof AnalysisResult>;

export type SourceType = "youtube" | "article" | "tweet" | "web";

// Generalised source descriptor. YouTube populates videoId/channel/duration;
// article/tweet/web populate site/author/published. `type` is absent on
// sessions stored before this change → treat as "youtube".
export interface VideoMeta {
  videoId: string;
  url: string;
  title: string;
  channel: string;
  durationSeconds: number | null;
  type?: SourceType;
  site?: string;
  author?: string;
  published?: string | null;
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
    type: SourceType;
    url: string;
    source_id: string;
    // video sources
    video_id?: string;
    channel?: string;
    start_seconds?: number;
    end_seconds?: number;
    speaker?: string | null;
    // article / web / tweet sources
    site?: string;
    author?: string;
    published?: string | null;
    quote?: string | null;
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
  // What this topic is for — the goal the user is exploring. Sent to the LLM
  // so it can flag candidate notes as "gold" if they advance the goal AND
  // aren't already covered by existing notes in the topic.
  description: string;
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

// A named GitHub repo the user can switch to while writing notes (e.g. an
// "agents_notes" repo distinct from the default). `token` is optional — when
// blank, the default Settings token is used (fine for a PAT covering both
// repos). The Settings owner/repo/branch act as the implicit "default" profile.
export interface RepoProfile {
  id: string;
  name: string;
  owner: string;
  repo: string;
  branch: string;
  token?: string;
}

// Fully-resolved repo the GitHub client should read/write right now.
export interface RepoTarget {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

export interface SessionPayload {
  videoMeta: VideoMeta;
  cues: TranscriptCue[];
  transcriptVtt: string;
  // Article/web/tweet sources: the extracted clean text fed to the LLM.
  // Empty/absent for YouTube (which uses cues instead).
  text?: string;
}

export type Msg =
  | { type: "TRANSCRIPT_READY"; payload: SessionPayload }
  | { type: "OPEN_SIDE_PANEL"; tabId: number }
  | { type: "GET_SESSION" }
  | { type: "LIST_TOPICS" }
  | { type: "LIST_NOTES_FOR_TOPIC"; topic: string }
  | {
      type: "GENERATE_ROOT";
      topic: string;
      // Optional gold-note context. When both are present the LLM scores
      // candidates against the goal + existing notes and sets gold=true on
      // notes that advance the goal and aren't already covered.
      topicGoal?: string | null;
      existingNotes?: { title: string; content: string }[] | null;
      // Optional time window: when set, only transcript cues overlapping
      // [startSeconds, endSeconds] are sent to the LLM. Saves tokens and
      // focuses the model on a specific stretch of a long video.
      startSeconds?: number | null;
      endSeconds?: number | null;
    }
  | {
      type: "GENERATE_DRILL";
      topic: string;
      parentNote: {
        title: string;
        content: string;
        start_seconds: number;
        end_seconds: number;
      };
      topicGoal?: string | null;
      existingNotes?: { title: string; content: string }[] | null;
    }
  | {
      type: "COMMIT_NOTES";
      topic: string;
      topicTitle: string | null;
      // Description seeded into topic.md when the topic is new. Ignored if
      // topic already exists (existing topic.md is never clobbered).
      topicDescription?: string;
      isNewTopic: boolean;
      includeTranscript: boolean;
      // Flat list of notes to commit. Each carries its own pre-assigned ULID
      // and an explicit `parents` chain. The side panel decides which notes
      // to send — drill ancestors are NOT auto-included.
      notes: { id: string; llmNote: LLMNote; parents: string[] }[];
    }
  | { type: "TEST_CONNECTION" }
  | { type: "CREATE_REPO" }
  | { type: "FETCH_TOPIC_DESCRIPTION"; topic: string }
  | { type: "SAVE_TOPIC_DESCRIPTION"; topic: string; description: string }
  | { type: "FETCH_TOPIC_NOTES_CONTENT"; topic: string }
  // Analyse tab: run a standardised analysis lens over a topic's committed
  // notes. Read-only — results are ephemeral and never written back.
  // userPrompt is an optional free-text steer the user pairs with either lens.
  | {
      type: "ANALYSE_TOPIC";
      topic: string;
      lens: AnalysisLens;
      userPrompt?: string | null;
    }
  // Cheap metadata-only update pushed by the content script as the user
  // navigates between videos, so the side panel always shows the current one.
  | { type: "SET_VIDEO_META"; videoMeta: VideoMeta }
  // Side panel asks the active tab's content script to scrape the transcript
  // (deferred until generate time, so the FAB no longer opens it eagerly).
  | { type: "EXTRACT_TRANSCRIPT" };

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
