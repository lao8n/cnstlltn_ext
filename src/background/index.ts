import { github, type FileToCommit } from "./github";
import { generateRootNotes, generateDrillNotes } from "./llm";
import { getSession, setSession } from "@/lib/storage";
import {
  KB_PATHS,
  buildFrontmatter,
  buildSourceMd,
  buildTopicMd,
  serialiseNote,
  sha256Hex,
} from "@/lib/note";
import { DEFAULT_MODEL } from "@/lib/types";
import type { Msg, SessionPayload, LLMNote } from "@/lib/types";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.error("sidePanel.setPanelBehavior failed", err));
});

chrome.runtime.onMessage.addListener((rawMsg, sender, sendResponse) => {
  const msg = rawMsg as Msg;
  // OPEN_SIDE_PANEL must call chrome.sidePanel.open() *synchronously* from a
  // user-gesture-bearing message, otherwise Chrome rejects it. So we don't
  // route it through the async `handle()` chain.
  if (msg.type === "OPEN_SIDE_PANEL") {
    const tabId = sender.tab?.id ?? (msg as { tabId?: number }).tabId;
    if (tabId != null) {
      chrome.sidePanel
        .open({ tabId })
        .catch((err) => console.error("sidePanel.open failed", err));
    }
    sendResponse({ ok: true, result: { opened: tabId != null } });
    return false;
  }
  void handle(msg, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err: Error) => {
      console.error("handler error", msg.type, err);
      sendResponse({ ok: false, error: err.message ?? String(err) });
    });
  return true;
});

async function handle(msg: Msg, sender: chrome.runtime.MessageSender) {
  switch (msg.type) {
    case "TRANSCRIPT_READY":
      return onTranscriptReady(msg.payload, sender);
    case "OPEN_SIDE_PANEL":
      // Handled synchronously above; this branch only runs if open() was
      // called via the async path (which shouldn't happen).
      return { opened: false };
    case "GET_SESSION":
      return getSession<SessionPayload>();
    case "LIST_TOPICS":
      return github.listTopics();
    case "LIST_NOTES_FOR_TOPIC":
      return github.listNotesForTopic(msg.topic);
    case "GENERATE_ROOT":
      return runGenerateRoot(msg);
    case "GENERATE_DRILL":
      return runGenerateDrill(msg);
    case "COMMIT_NOTES":
      return runCommit(msg);
    case "TEST_CONNECTION":
      return github.testConnection();
    case "CREATE_REPO":
      return github.createRepoIfMissing();
    case "FETCH_TOPIC_DESCRIPTION": {
      const md = await github.fetchTopicMd(msg.topic);
      return { description: md?.frontmatter.description ?? "" };
    }
    case "SAVE_TOPIC_DESCRIPTION":
      return github.updateTopicDescription(msg.topic, msg.description);
    case "FETCH_TOPIC_NOTES_CONTENT":
      return { notes: await github.fetchTopicNotesContent(msg.topic) };
  }
}

async function onTranscriptReady(
  payload: SessionPayload,
  _sender: chrome.runtime.MessageSender,
) {
  // Side panel was already opened synchronously by the OPEN_SIDE_PANEL message
  // dispatched at the start of the FAB click handler. Just store the session;
  // the side panel listens to chrome.storage.session and picks it up.
  await setSession<SessionPayload>(payload);
  return { ok: true };
}

async function runGenerateRoot(msg: Extract<Msg, { type: "GENERATE_ROOT" }>) {
  const session = await getSession<SessionPayload>();
  if (!session) throw new Error("No active transcript session.");
  const notes = await generateRootNotes({
    cues: session.cues,
    videoTitle: session.videoMeta.title,
    channel: session.videoMeta.channel,
    topicGoal: msg.topicGoal ?? null,
    existingNotes: msg.existingNotes ?? null,
  });
  return { topic: msg.topic, notes };
}

async function runGenerateDrill(msg: Extract<Msg, { type: "GENERATE_DRILL" }>) {
  const session = await getSession<SessionPayload>();
  if (!session) throw new Error("No active transcript session.");
  const notes = await generateDrillNotes({
    cues: session.cues,
    videoTitle: session.videoMeta.title,
    channel: session.videoMeta.channel,
    parentTitle: msg.parentNote.title,
    parentContent: msg.parentNote.content,
    parentStartSeconds: msg.parentNote.start_seconds,
    parentEndSeconds: msg.parentNote.end_seconds,
    topicGoal: msg.topicGoal ?? null,
    existingNotes: msg.existingNotes ?? null,
  });
  return { topic: msg.topic, notes };
}

async function runCommit(msg: Extract<Msg, { type: "COMMIT_NOTES" }>) {
  const session = await getSession<SessionPayload>();
  if (!session) throw new Error("No active transcript session.");
  if (msg.notes.length === 0) {
    throw new Error("Nothing to commit.");
  }

  const files: FileToCommit[] = [];

  const kbConfig = await github.ensureKbConfig();
  if (kbConfig) files.push(kbConfig);

  // Only create topic.md if it doesn't already exist. Guards against the
  // case where the user typed a "new" topic title whose slug collides with
  // an existing topic — clobbering an existing topic.md would lose any
  // hand-curated main_arguments / scope.
  const topicMdPath = KB_PATHS.topicMd(msg.topic);
  if (msg.isNewTopic && !(await github.pathExists(topicMdPath))) {
    files.push({
      path: topicMdPath,
      content: buildTopicMd({
        topicSlug: msg.topic,
        topicTitle: msg.topicTitle ?? msg.topic,
        description: msg.topicDescription ?? "",
      }),
    });
  }

  const transcriptPath = KB_PATHS.transcriptVtt(
    msg.topic,
    session.videoMeta.videoId,
  );
  if (msg.includeTranscript && !(await github.pathExists(transcriptPath))) {
    files.push({
      path: transcriptPath,
      content: session.transcriptVtt,
    });
    files.push({
      path: KB_PATHS.sourceMd(msg.topic, session.videoMeta.videoId),
      content: buildSourceMd({
        video: session.videoMeta,
        fetchedAt: new Date(),
        transcriptPath,
      }),
    });
  }

  for (const note of msg.notes) {
    const contentHash = await sha256Hex(note.llmNote.content);
    const fm = buildFrontmatter({
      id: note.id,
      topic: msg.topic,
      llmNote: note.llmNote,
      video: session.videoMeta,
      parents: note.parents,
      model: DEFAULT_MODEL,
      contentHash,
    });
    files.push({
      path: KB_PATHS.noteFile(msg.topic, note.id, note.llmNote.title),
      content: serialiseNote(fm, note.llmNote.content),
      noteRef: { id: note.id, title: note.llmNote.title },
    });
  }

  const commitMessage = buildCommitMessage(
    msg.topic,
    msg.notes.length,
    session.videoMeta.title,
  );

  return github.commitFiles({
    files,
    message: commitMessage,
  });
}

function buildCommitMessage(
  topic: string,
  noteCount: number,
  videoTitle: string,
): string {
  const truncated =
    videoTitle.length > 60 ? videoTitle.slice(0, 57) + "..." : videoTitle;
  return `notes(${topic}): add ${noteCount} note${noteCount === 1 ? "" : "s"} from "${truncated}"`;
}
