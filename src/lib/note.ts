import yaml from "js-yaml";
import { ulid } from "ulid";
import type {
  LLMNote,
  NoteFrontmatter,
  TopicFrontmatter,
  VideoMeta,
} from "./types";
import { SCHEMA_VERSION } from "./types";

export function newId(): string {
  return ulid();
}

export function slugify(input: string, maxLen = 60): string {
  const cleaned = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!cleaned) return "untitled";
  return cleaned.slice(0, maxLen).replace(/-+$/g, "");
}

export function noteFilename(id: string, title: string): string {
  return `${id}-${slugify(title)}.md`;
}

export async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function buildFrontmatter(args: {
  id: string;
  topic: string;
  llmNote: LLMNote;
  video: VideoMeta;
  parents: string[];
  model: string;
  contentHash: string;
  now?: Date;
}): NoteFrontmatter {
  const now = (args.now ?? new Date()).toISOString();
  return {
    id: args.id,
    title: args.llmNote.title,
    topic: args.topic,
    created: now,
    updated: now,
    schema_version: SCHEMA_VERSION,
    source: {
      type: "youtube",
      url: args.video.url,
      source_id: `yt-${args.video.videoId}`,
      video_id: args.video.videoId,
      channel: args.video.channel,
      start_seconds: args.llmNote.start_seconds,
      end_seconds: args.llmNote.end_seconds,
      speaker: args.llmNote.speaker,
    },
    parents: args.parents,
    children: [],
    related: [],
    tags: args.llmNote.tags,
    claim_type: args.llmNote.claim_type,
    flag: args.llmNote.flag,
    status: "active",
    content_hash: `sha256:${args.contentHash}`,
    model: args.model,
  };
}

export function serialiseNote(
  frontmatter: NoteFrontmatter,
  body: string,
): string {
  const fm = yaml.dump(frontmatter, { lineWidth: 100, noRefs: true });
  return `---\n${fm}---\n\n${body.trim()}\n`;
}

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?/;

export function parseFrontmatter<T>(
  raw: string,
): { frontmatter: T; body: string } | null {
  const m = raw.match(FRONTMATTER_RE);
  if (!m) return null;
  try {
    const frontmatter = yaml.load(m[1]) as T;
    const body = raw.slice(m[0].length);
    return { frontmatter, body };
  } catch {
    return null;
  }
}

export function parseNote(raw: string) {
  return parseFrontmatter<NoteFrontmatter>(raw);
}

export function parseTopic(raw: string) {
  return parseFrontmatter<TopicFrontmatter>(raw);
}

export function serialiseTopic(
  frontmatter: TopicFrontmatter,
  body: string,
): string {
  const fm = yaml.dump(frontmatter, { lineWidth: 100, noRefs: true });
  return `---\n${fm}---\n\n${body.replace(/^\n+/, "")}`;
}

export function buildTopicMd(args: {
  topicSlug: string;
  topicTitle: string;
  description?: string;
  scope?: string;
}): string {
  const fm: TopicFrontmatter = {
    id: args.topicSlug,
    title: args.topicTitle,
    description: args.description ?? "",
    created: new Date().toISOString(),
    status: "active",
    schema_version: SCHEMA_VERSION,
    main_arguments: [],
    key_voices: [],
  };
  const body = [
    `# ${args.topicTitle}`,
    "",
    "## Scope",
    args.scope?.trim() || "_Set scope here._",
    "",
    "## Main arguments",
    "_The coverage dashboard counts notes against the `main_arguments` field in this file's frontmatter._",
    "",
  ].join("\n");
  return `---\n${yaml.dump(fm, { lineWidth: 100, noRefs: true })}---\n\n${body}\n`;
}

export function buildSourceMd(args: {
  video: VideoMeta;
  fetchedAt: Date;
  transcriptPath: string;
}): string {
  const fm = {
    id: `yt-${args.video.videoId}`,
    type: "youtube",
    url: args.video.url,
    video_id: args.video.videoId,
    channel: args.video.channel,
    title: args.video.title,
    duration_seconds: args.video.durationSeconds,
    fetched_at: args.fetchedAt.toISOString(),
    transcript_path: args.transcriptPath,
    schema_version: SCHEMA_VERSION,
  };
  return `---\n${yaml.dump(fm, { lineWidth: 100, noRefs: true })}---\n\n# ${args.video.title}\n\n[${args.video.url}](${args.video.url})\n`;
}

export function buildKbConfig(): string {
  return `${yaml.dump(
    {
      schema_version: SCHEMA_VERSION,
      generator: "notetaker",
      generator_version: "0.1.0",
    },
    { lineWidth: 100, noRefs: true },
  )}`;
}

export const KB_PATHS = {
  config: () => `.kbconfig.yaml`,
  readme: () => `README.md`,
  topicDir: (topic: string) => `topics/${topic}`,
  topicMd: (topic: string) => `topics/${topic}/topic.md`,
  notesDir: (topic: string) => `topics/${topic}/notes`,
  noteFile: (topic: string, id: string, title: string) =>
    `topics/${topic}/notes/${noteFilename(id, title)}`,
  sourcesDir: (topic: string) => `topics/${topic}/sources`,
  sourceMd: (topic: string, videoId: string) =>
    `topics/${topic}/sources/yt-${videoId}.md`,
  transcriptsDir: (topic: string) => `topics/${topic}/sources/transcripts`,
  transcriptVtt: (topic: string, videoId: string) =>
    `topics/${topic}/sources/transcripts/yt-${videoId}.vtt`,
};
