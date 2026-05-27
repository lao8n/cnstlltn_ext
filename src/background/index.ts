import { github, type FileToCommit } from "./github";
import { generateRootNotes, generateDrillNotes } from "./llm";
import { getSession, setSession } from "@/lib/storage";
import {
  KB_PATHS,
  buildFrontmatter,
  buildSourceMd,
  buildTopicMd,
  newId,
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
      return openSidePanel(msg.tabId);
    case "GET_SESSION":
      return getSession<SessionPayload>();
    case "LIST_TOPICS":
      return github.listTopics();
    case "LIST_NOTES_FOR_TOPIC":
      return github.listNotesForTopic(msg.topic);
    case "GENERATE_ROOT":
      return runGenerateRoot(msg.topic);
    case "GENERATE_DRILL":
      return runGenerateDrill(msg.topic, msg.parentNote);
    case "COMMIT_NOTES":
      return runCommit(msg);
    case "TEST_CONNECTION":
      return github.testConnection();
    case "CREATE_REPO":
      return github.createRepoIfMissing();
  }
}

async function onTranscriptReady(
  payload: SessionPayload,
  sender: chrome.runtime.MessageSender,
) {
  await setSession<SessionPayload>(payload);
  if (sender.tab?.id != null) {
    await openSidePanel(sender.tab.id);
  }
  return { ok: true };
}

async function openSidePanel(tabId: number) {
  try {
    await chrome.sidePanel.open({ tabId });
  } catch (err) {
    console.error("sidePanel.open failed", err);
  }
}

async function runGenerateRoot(topic: string) {
  const session = await getSession<SessionPayload>();
  if (!session) throw new Error("No active transcript session.");
  const notes = await generateRootNotes({
    cues: session.cues,
    videoTitle: session.videoMeta.title,
    channel: session.videoMeta.channel,
  });
  return { topic, notes };
}

async function runGenerateDrill(
  topic: string,
  parentNote: { title: string; content: string },
) {
  const session = await getSession<SessionPayload>();
  if (!session) throw new Error("No active transcript session.");
  const notes = await generateDrillNotes({
    cues: session.cues,
    videoTitle: session.videoMeta.title,
    channel: session.videoMeta.channel,
    parentTitle: parentNote.title,
    parentContent: parentNote.content,
  });
  return { topic, notes };
}

async function runCommit(msg: Extract<Msg, { type: "COMMIT_NOTES" }>) {
  const session = await getSession<SessionPayload>();
  if (!session) throw new Error("No active transcript session.");
  if (msg.llmNotes.length === 0) {
    throw new Error("Nothing selected to commit.");
  }

  const files: FileToCommit[] = [];

  const kbConfig = await github.ensureKbConfig();
  if (kbConfig) files.push(kbConfig);

  if (msg.isNewTopic) {
    files.push({
      path: KB_PATHS.topicMd(msg.topic),
      content: buildTopicMd({
        topicSlug: msg.topic,
        topicTitle: msg.topicTitle ?? msg.topic,
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

  for (const llmNote of msg.llmNotes) {
    const id = newId();
    const contentHash = await sha256Hex(llmNote.content);
    const fm = buildFrontmatter({
      id,
      topic: msg.topic,
      llmNote,
      video: session.videoMeta,
      parents: msg.parents,
      model: DEFAULT_MODEL,
      contentHash,
    });
    const content = serialiseNote(fm, llmNote.content);
    files.push({
      path: KB_PATHS.noteFile(msg.topic, id, llmNote.title),
      content,
      noteRef: { id, title: llmNote.title },
    });
  }

  const commitMessage = buildCommitMessage(msg.topic, msg.llmNotes, session.videoMeta.title);

  return github.commitFiles({
    files,
    message: commitMessage,
  });
}

function buildCommitMessage(
  topic: string,
  notes: LLMNote[],
  videoTitle: string,
): string {
  const truncated =
    videoTitle.length > 60 ? videoTitle.slice(0, 57) + "..." : videoTitle;
  return `notes(${topic}): add ${notes.length} note${notes.length === 1 ? "" : "s"} from "${truncated}"`;
}
