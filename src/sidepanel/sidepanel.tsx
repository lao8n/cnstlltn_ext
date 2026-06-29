import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ulid } from "ulid";
import * as Slider from "@radix-ui/react-slider";
import "@/index.css";
import logoUrl from "@/assets/logo.svg";
import {
  getSettings,
  getRepoProfiles,
  getActiveProfileId,
  setActiveProfileId,
  setSession,
} from "@/lib/storage";
import {
  extractActivePage,
  buildPastedArticle,
  type ExtractedArticle,
} from "@/lib/extract";
import type {
  AnalysisCard,
  AnalysisLens,
  CommitResult,
  LLMNote,
  RepoProfile,
  SessionPayload,
  Settings,
} from "@/lib/types";
import {
  useStore,
  isSettingsComplete,
  currentFrame,
  type DrillFrame,
  type Tab,
} from "./state";

async function send<T>(msg: object): Promise<T> {
  const resp = (await chrome.runtime.sendMessage(msg)) as
    | { ok: true; result: T }
    | { ok: false; error: string };
  if (!resp.ok) throw new Error(resp.error);
  return resp.result;
}

// Ask the active YouTube tab's content script to scrape the transcript for the
// video currently on screen, and wait until it's stored as the session. Used
// at generate time, since the FAB no longer scrapes eagerly.
async function extractTranscriptForActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id == null) {
    throw new Error("No active tab to read the transcript from.");
  }
  const resp = (await chrome.tabs.sendMessage(tab.id, {
    type: "EXTRACT_TRANSCRIPT",
  })) as { ok: boolean; error?: string } | undefined;
  if (!resp?.ok) {
    throw new Error(resp?.error ?? "Could not read the transcript for this video.");
  }
}

function App() {
  const s = useStore();
  // Closure that re-runs the last action that hit an error. Set on every
  // catch; cleared on success. Wired to the Retry button in the error phase.
  const retryRef = React.useRef<(() => void | Promise<void>) | null>(null);
  const [articleEntryOpen, setArticleEntryOpen] = useState(false);

  useEffect(() => {
    void bootstrap();

    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.session) {
        void bootstrap();
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  async function bootstrap() {
    s.setError(null);
    const settings = await getSettings();
    s.setSettings(settings);
    const [profiles, activeId] = await Promise.all([
      getRepoProfiles(),
      getActiveProfileId(),
    ]);
    s.setRepoProfiles(profiles);
    s.setActiveRepoProfileId(activeId);
    if (!isSettingsComplete(settings)) {
      s.setPhase("no-settings");
      return;
    }
    // Load topics up front so the Analyse tab works even without an active
    // video (the arriving-block below only refreshes them on a new session).
    if (useStore.getState().topics.length === 0) {
      try {
        s.setTopics(await send<string[]>({ type: "LIST_TOPICS" }));
      } catch (err) {
        console.warn("Could not list topics, treating as empty:", err);
      }
    }
    const prevVideoId = useStore.getState().session?.videoMeta.videoId;
    const session = await send<SessionPayload | null>({ type: "GET_SESSION" });
    s.setSession(session);
    if (!session) {
      s.setPhase("no-session");
      return;
    }
    const videoChanged =
      prevVideoId != null && prevVideoId !== session.videoMeta.videoId;
    if (videoChanged) {
      s.clearStack();
      s.setRange(null, null);
      s.setPhase("topic-picker");
    }
    const phase = useStore.getState().phase;
    const inWorkflow = ["generating", "candidates", "committing"].includes(
      phase,
    );
    // We're "arriving" at a usable session when we were waiting (loading / no
    // active video yet) or the video just changed. This is also the case when
    // a session is stored *after* the panel first rendered "no-session": the
    // storage listener re-runs bootstrap, and we must leave that screen.
    const arriving = phase === "loading" || phase === "no-session" || videoChanged;
    if (arriving) {
      try {
        const topics = await send<string[]>({ type: "LIST_TOPICS" });
        s.setTopics(topics);
      } catch (err) {
        console.warn("Could not list topics, treating as empty:", err);
        s.setTopics([]);
      }
    }
    if (arriving) {
      s.setPhase("topic-picker");
    } else if (!inWorkflow && phase === "error") {
      // Session refreshed while idle — stay on topic picker.
      s.setPhase("topic-picker");
    }
  }

  async function onGenerate() {
    const topic = effectiveTopic(s);
    if (!topic) {
      s.setError("Pick or name a topic first.");
      return;
    }
    s.setError(null);
    s.setPhase("generating");
    try {
      let session = await send<SessionPayload | null>({ type: "GET_SESSION" });
      const isVideo =
        !session?.videoMeta.type || session.videoMeta.type === "youtube";
      if (isVideo) {
        // Transcript is scraped lazily — the first time we generate for a video.
        if (!session || session.cues.length === 0) {
          await extractTranscriptForActiveTab();
          session = await send<SessionPayload | null>({ type: "GET_SESSION" });
        }
        if (!session || session.cues.length === 0) {
          throw new Error("Couldn't read a transcript for this video.");
        }
      } else if (!session || !session.text) {
        throw new Error("No article text to generate from.");
      }
      s.setSession(session);
      // Pull existing notes' bodies for the topic — used as gold-note context.
      // Skip for new topics (nothing exists yet) or if no description set
      // (no goal to score against, so gold flag stays false everywhere).
      let existingNotes: { title: string; content: string }[] | null = null;
      const goal = s.currentTopicDescription.trim();
      if (goal && !s.isNewTopic) {
        try {
          const { notes: existing } = await send<{
            notes: { id: string; title: string; content: string }[];
          }>({ type: "FETCH_TOPIC_NOTES_CONTENT", topic });
          existingNotes = existing.map(({ title, content }) => ({
            title,
            content,
          }));
        } catch (err) {
          console.warn("FETCH_TOPIC_NOTES_CONTENT failed, skipping:", err);
        }
      }
      const { notes } = await send<{ notes: LLMNote[] }>({
        type: "GENERATE_ROOT",
        topic,
        topicGoal: goal || null,
        existingNotes,
        startSeconds: s.rangeStartSeconds,
        endSeconds: s.rangeEndSeconds,
      });
      s.setRootFrame(notes);
      s.setPhase("candidates");
      retryRef.current = null;
    } catch (err) {
      retryRef.current = onGenerate;
      s.setError(friendlyError((err as Error).message));
      s.setPhase("error");
    }
  }

  async function onDrillCandidate(candidateIdx: number) {
    const topic = effectiveTopic(s);
    if (!topic) return;
    const frame = currentFrame(s);
    if (!frame) return;
    const parentLLM = frame.candidates[candidateIdx];
    if (!parentLLM) return;

    const cached = frame.childrenByCandidateIdx[candidateIdx];
    if (cached) {
      s.setError(null);
      s.pushDrillFrame(
        cached.drilledFromIdx != null
          ? cached
          : { ...cached, drilledFromIdx: candidateIdx },
      );
      s.setPhase("candidates");
      return;
    }

    // Pre-assign a stable ULID to the parent so descendants can reference it.
    const parentId = ulid();
    s.setError(null);
    s.setPhase("generating");
    try {
      const session = await send<SessionPayload | null>({ type: "GET_SESSION" });
      if (session) s.setSession(session);
      const goal = s.currentTopicDescription.trim();
      let existingNotes: { title: string; content: string }[] | null = null;
      if (goal && !s.isNewTopic) {
        try {
          const { notes: existing } = await send<{
            notes: { id: string; title: string; content: string }[];
          }>({ type: "FETCH_TOPIC_NOTES_CONTENT", topic });
          existingNotes = existing.map(({ title, content }) => ({
            title,
            content,
          }));
        } catch (err) {
          console.warn("FETCH_TOPIC_NOTES_CONTENT failed, skipping:", err);
        }
      }
      const { notes } = await send<{ notes: LLMNote[] }>({
        type: "GENERATE_DRILL",
        topic,
        parentNote: {
          title: parentLLM.title,
          content: parentLLM.content,
          start_seconds: parentLLM.start_seconds,
          end_seconds: parentLLM.end_seconds,
        },
        topicGoal: goal || null,
        existingNotes,
      });
      const childFrame: DrillFrame = {
        parent: { id: parentId, llmNote: parentLLM },
        candidates: notes,
        selectedIdxs: new Set<number>(),
        childrenByCandidateIdx: {},
        drilledFromIdx: candidateIdx,
      };
      s.cacheChildFrame(candidateIdx, childFrame);
      s.pushDrillFrame(childFrame);
      s.setPhase("candidates");
      retryRef.current = null;
    } catch (err) {
      retryRef.current = () => onDrillCandidate(candidateIdx);
      s.setError(friendlyError((err as Error).message));
      s.setPhase("error");
    }
  }

  function onBack() {
    if (s.drillStack.length <= 1) return;
    s.popDrillFrame();
    s.setError(null);
  }

  async function onCommit() {
    const topic = effectiveTopic(s);
    if (!topic) return;
    if (s.drillStack.length === 0) return;
    const notes = buildCommitNotes(s.drillStack[0] ?? null);
    if (notes.length === 0) {
      s.setError("Tick at least one note to save it.");
      return;
    }
    s.setError(null);
    s.setPhase("committing");
    try {
      const result = await send<CommitResult>({
        type: "COMMIT_NOTES",
        topic,
        topicTitle: s.isNewTopic ? s.newTopicTitle.trim() || topic : null,
        topicDescription: s.currentTopicDescription || undefined,
        isNewTopic: s.isNewTopic,
        includeTranscript: true,
        notes,
      });
      // Once committed, the description is now persisted on GitHub.
      s.setSavedTopicDescription(s.currentTopicDescription);
      s.setCommitBanner({
        count: result.noteRefs.length,
        url: result.url,
      });
      s.popToStackRoot();
      retryRef.current = null;
      try {
        const allNotes = await send<{ id: string; title: string; path: string }[]>(
          { type: "LIST_NOTES_FOR_TOPIC", topic },
        );
        s.setNotesForTopic(allNotes);
      } catch {}
    } catch (err) {
      retryRef.current = onCommit;
      s.setError(friendlyError((err as Error).message));
      s.setPhase("error");
    }
  }

  async function onAnalyse(lens: AnalysisLens) {
    const topic = s.analyseTopic;
    if (!topic) {
      s.setAnalyseError("Pick a topic to analyse first.");
      return;
    }
    s.setAnalyseError(null);
    s.setAnalyseLens(lens);
    s.setAnalyseCards([]);
    s.setAnalyseLoading(true);
    try {
      const { cards } = await send<{ cards: AnalysisCard[] }>({
        type: "ANALYSE_TOPIC",
        topic,
        lens,
        userPrompt: s.analysePrompt.trim() || null,
      });
      s.setAnalyseCards(cards);
    } catch (err) {
      s.setAnalyseError(friendlyError((err as Error).message));
    } finally {
      s.setAnalyseLoading(false);
    }
  }

  // Store an extracted article as the active session and move to the topic
  // picker (same flow YouTube uses, minus the transcript).
  async function startArticle(extracted: ExtractedArticle) {
    const payload: SessionPayload = {
      videoMeta: extracted.videoMeta,
      cues: [],
      transcriptVtt: "",
      text: extracted.text,
    };
    await setSession(payload);
    s.setSession(payload);
    s.clearStack();
    s.setRange(null, null);
    s.pickTopic("");
    s.setIsNewTopic(false);
    s.setNewTopicTitle("");
    try {
      const topics = await send<string[]>({ type: "LIST_TOPICS" });
      s.setTopics(topics);
    } catch {
      /* leave topics as-is */
    }
    setArticleEntryOpen(false);
    s.setPhase("topic-picker");
  }

  async function onExtract(mode: "article" | "selection") {
    s.setError(null);
    try {
      await startArticle(await extractActivePage(mode));
    } catch (err) {
      s.setError((err as Error).message);
    }
  }

  async function onPaste(args: { text: string; title: string; url: string }) {
    s.setError(null);
    try {
      await startArticle(buildPastedArticle(args));
    } catch (err) {
      s.setError((err as Error).message);
    }
  }

  // Switch the repo we read/write. The active profile is persisted (the GitHub
  // client reads it on every call), so we just re-fetch topics for the new repo.
  async function onChangeRepo(id: string | null) {
    await setActiveProfileId(id);
    s.setActiveRepoProfileId(id);
    s.pickTopic("");
    s.setIsNewTopic(false);
    s.setNewTopicTitle("");
    s.pickAnalyseTopic("");
    try {
      const topics = await send<string[]>({ type: "LIST_TOPICS" });
      s.setTopics(topics);
    } catch (err) {
      console.warn("Could not list topics for repo:", err);
      s.setTopics([]);
    }
  }

  return (
    <div className="p-4 max-w-xl mx-auto text-sm space-y-4">
      <div className="flex justify-between items-center -mb-2">
        {s.settings?.model ? (
          <span className="nt-chip" title="Model — change in settings">
            {s.settings.model}
          </span>
        ) : (
          <span />
        )}
        <button
          className="nt-icon-btn"
          title="Settings"
          aria-label="Settings"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          <GearIcon />
        </button>
      </div>

      {s.phase !== "loading" && s.phase !== "no-settings" && (
        <RepoPicker
          settings={s.settings}
          profiles={s.repoProfiles}
          activeId={s.activeRepoProfileId}
          onChange={onChangeRepo}
        />
      )}

      {s.phase === "loading" && <div>Loading…</div>}

      {s.phase === "no-settings" && (
        <div className="space-y-2">
          <p>You need to configure cnstlltn first.</p>
          <button
            className="nt-btn"
            onClick={() => chrome.runtime.openOptionsPage()}
          >
            Open settings
          </button>
        </div>
      )}

      {s.phase !== "loading" && s.phase !== "no-settings" && (
        <TabBar tab={s.tab} onTab={s.setTab} />
      )}

      {s.tab === "analyse" &&
        s.phase !== "loading" &&
        s.phase !== "no-settings" && (
          <AnalyseView
            topics={s.topics}
            selectedTopic={s.analyseTopic}
            prompt={s.analysePrompt}
            lens={s.analyseLens}
            cards={s.analyseCards}
            loading={s.analyseLoading}
            error={s.analyseError}
            onPick={(t) => s.pickAnalyseTopic(t)}
            onChangePrompt={(p) => s.setAnalysePrompt(p)}
            onAnalyse={onAnalyse}
          />
        )}

      {s.tab === "extract" &&
        s.phase !== "loading" &&
        s.phase !== "no-settings" && (
          <>
            {s.errorMessage && (
              <div className="rounded bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-100 px-3 py-2">
                {s.errorMessage}
              </div>
            )}

            {s.phase === "no-session" && <EmptyHero />}

            {s.phase !== "no-session" && (
              <div className="flex justify-end -mt-1">
                <button
                  className="nt-link-btn"
                  onClick={() => setArticleEntryOpen((v) => !v)}
                >
                  {articleEntryOpen ? "Close" : "＋ Article / paste"}
                </button>
              </div>
            )}

            {(articleEntryOpen || s.phase === "no-session") && (
              <ArticleEntry
                onExtractArticle={() => onExtract("article")}
                onExtractSelection={() => onExtract("selection")}
                onPaste={onPaste}
              />
            )}

            {s.phase === "no-session" && (
              <p className="text-xs opacity-70 text-center">
                Or open a YouTube video and use the{" "}
                <span className="font-medium">cnstlltn</span> button on the
                player to capture its transcript.
              </p>
            )}

            {s.phase !== "no-session" && <VideoCard session={s.session} />}

            {s.phase === "topic-picker" && (
              <TopicPicker
                topics={s.topics}
                selectedTopic={s.selectedTopic}
                newTopicTitle={s.newTopicTitle}
                isNewTopic={s.isNewTopic}
                currentTopicDescription={s.currentTopicDescription}
                savedTopicDescription={s.savedTopicDescription}
                durationSeconds={s.session?.videoMeta.durationSeconds ?? null}
                rangeStartSeconds={s.rangeStartSeconds}
                rangeEndSeconds={s.rangeEndSeconds}
                onChangeRange={(start, end) => s.setRange(start, end)}
                onPick={async (t) => {
                  s.pickTopic(t);
                  // Load existing description for the picked topic.
                  try {
                    const { description } = await send<{ description: string }>({
                      type: "FETCH_TOPIC_DESCRIPTION",
                      topic: t,
                    });
                    s.setCurrentTopicDescription(description);
                    s.setSavedTopicDescription(description);
                  } catch (err) {
                    console.warn("FETCH_TOPIC_DESCRIPTION failed", err);
                  }
                }}
                onSetIsNew={(b) => s.setIsNewTopic(b)}
                onChangeNewTitle={(t) => s.setNewTopicTitle(t)}
                onChangeDescription={(d) => s.setCurrentTopicDescription(d)}
                onSaveDescription={async () => {
                  const slug = effectiveTopic(s);
                  if (!slug) return;
                  try {
                    const result = await send<{ ok: boolean; message: string }>({
                      type: "SAVE_TOPIC_DESCRIPTION",
                      topic: slug,
                      description: s.currentTopicDescription,
                    });
                    if (result.ok) {
                      s.setSavedTopicDescription(s.currentTopicDescription);
                    } else {
                      // topic.md doesn't exist yet — defer to first commit. We still
                      // treat the typed description as "current"; commit will persist it.
                      s.setSavedTopicDescription(s.currentTopicDescription);
                    }
                  } catch (err) {
                    s.setError(friendlyError((err as Error).message));
                  }
                }}
                onGenerate={onGenerate}
              />
            )}

            {s.phase === "generating" && (
              <div className="opacity-70">
                Generating notes from transcript<AnimatedDots />
              </div>
            )}

            {s.commitBanner && s.phase === "candidates" && (
              <CommitBannerView
                banner={s.commitBanner}
                onDismiss={() => s.setCommitBanner(null)}
              />
            )}

            {s.phase === "candidates" && currentFrame(s) && (
              <CandidateList
                stack={s.drillStack}
                onToggle={(i) => s.toggleSelected(i)}
                onDrillCandidate={onDrillCandidate}
                onBack={onBack}
                onCommit={onCommit}
                onCancel={() => {
                  s.clearStack();
                  s.setPhase("topic-picker");
                }}
              />
            )}

            {s.phase === "committing" && <div>Committing to GitHub…</div>}

            {s.phase === "error" && (
              <div className="flex gap-2">
                {retryRef.current && (
                  <button
                    className="nt-btn nt-btn-primary"
                    onClick={() => {
                      const fn = retryRef.current;
                      if (fn) void fn();
                    }}
                  >
                    Retry
                  </button>
                )}
                <button
                  className="nt-btn"
                  onClick={() => {
                    s.setError(null);
                    retryRef.current = null;
                    s.setPhase("topic-picker");
                  }}
                >
                  Back
                </button>
              </div>
            )}
          </>
        )}

      <Styles />
    </div>
  );
}

function EmptyHero() {
  return (
    <div className="flex flex-col items-center text-center gap-2 pt-4 pb-1">
      <img
        src={logoUrl}
        alt=""
        className="w-12 h-12 rounded-xl shadow-sm"
        draggable={false}
      />
      <h1 className="text-base font-semibold tracking-tight">cnstlltn</h1>
      <p className="text-xs opacity-70 max-w-[16rem]">
        Turn anything you read or watch into linked notes in your knowledge
        base.
      </p>
    </div>
  );
}

function GearIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

function AnimatedDots() {
  const [count, setCount] = useState(1);
  useEffect(() => {
    const id = setInterval(() => setCount((c) => (c % 3) + 1), 400);
    return () => clearInterval(id);
  }, []);
  // Reserve width for the longest state ("...") so the text doesn't jiggle.
  return (
    <span className="inline-block w-[1.5ch] text-left">
      {".".repeat(count)}
    </span>
  );
}

function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: "extract", label: "Extract" },
    { id: "analyse", label: "Analyse" },
  ];
  return (
    <div className="flex border-b border-slate-300 dark:border-slate-700 -mx-1">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onTab(t.id)}
          className={
            "px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition-colors " +
            (tab === t.id
              ? "border-[#4285F4] text-[#4285F4] opacity-100"
              : "border-transparent opacity-60 hover:opacity-100")
          }
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

const ANALYSE_LENSES: { id: AnalysisLens; label: string; hint: string }[] = [
  {
    id: "notes",
    label: "Notes",
    hint: "Analyse the perspectives & themes already in your notes.",
  },
  {
    id: "gaps",
    label: "Gaps",
    hint: "Missing perspectives, each steel-manned at its strongest.",
  },
];

function AnalyseView(props: {
  topics: string[];
  selectedTopic: string;
  prompt: string;
  lens: AnalysisLens | null;
  cards: AnalysisCard[];
  loading: boolean;
  error: string | null;
  onPick: (slug: string) => void;
  onChangePrompt: (p: string) => void;
  onAnalyse: (lens: AnalysisLens) => void;
}) {
  const activeHint = ANALYSE_LENSES.find((l) => l.id === props.lens)?.hint;
  return (
    <div className="space-y-3">
      {props.topics.length === 0 ? (
        <p className="opacity-70">
          No topics yet. Extract some notes from a video first, then come back
          to analyse them.
        </p>
      ) : (
        <div className="space-y-1">
          <label className="block text-xs font-medium opacity-80">
            Topic to analyse
          </label>
          <select
            className="nt-input"
            value={props.selectedTopic}
            onChange={(e) => props.onPick(e.target.value)}
          >
            <option value="">— pick a topic —</option>
            {props.topics.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      )}

      {props.selectedTopic && (
        <div className="space-y-2">
          <div className="space-y-1">
            <label className="block text-xs font-medium opacity-80">
              Optional steer (paired with either button below)
            </label>
            <textarea
              className="nt-input"
              rows={2}
              placeholder="e.g. focus on the economic arguments, or compare the realist and liberal views"
              value={props.prompt}
              onChange={(e) => props.onChangePrompt(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            {ANALYSE_LENSES.map((l) => (
              <button
                key={l.id}
                className={
                  "nt-btn flex-1 " +
                  (props.lens === l.id ? "nt-btn-primary" : "")
                }
                disabled={props.loading}
                onClick={() => props.onAnalyse(l.id)}
              >
                {l.label}
              </button>
            ))}
          </div>
          {activeHint && (
            <div className="text-xs opacity-60">{activeHint}</div>
          )}
        </div>
      )}

      {props.error && (
        <div className="rounded bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-100 px-3 py-2">
          {props.error}
        </div>
      )}

      {props.loading && (
        <div className="opacity-70">
          Analysing notes<AnimatedDots />
        </div>
      )}

      {!props.loading && props.cards.length > 0 && (
        <ul className="space-y-2">
          {props.cards.map((c, i) => (
            <li
              key={i}
              className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2 space-y-1"
            >
              <div className="font-medium">{c.title}</div>
              <div className="text-xs opacity-80 whitespace-pre-wrap">
                {c.body}
              </div>
            </li>
          ))}
        </ul>
      )}

      {!props.loading &&
        props.lens &&
        props.cards.length === 0 &&
        !props.error && (
          <div className="opacity-70">No results returned. Try again.</div>
        )}
    </div>
  );
}

// Dropdown to choose which repo notes are read from / written to. Only shown
// when the user has configured extra profiles beyond the default repo.
function RepoPicker(props: {
  settings: Settings | null;
  profiles: RepoProfile[];
  activeId: string | null;
  onChange: (id: string | null) => void;
}) {
  if (props.profiles.length === 0) return null;
  const defaultLabel =
    props.settings?.githubOwner && props.settings?.githubRepo
      ? `${props.settings.githubOwner}/${props.settings.githubRepo}`
      : "default repo";
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs opacity-70 whitespace-nowrap">Saving to</label>
      <select
        className="nt-input py-1"
        value={props.activeId ?? ""}
        onChange={(e) => props.onChange(e.target.value || null)}
      >
        <option value="">{defaultLabel} (default)</option>
        {props.profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name || `${p.owner}/${p.repo}`}
          </option>
        ))}
      </select>
    </div>
  );
}

// Entry point for non-YouTube sources: extract the current page (Readability),
// use the current selection, or paste text manually.
function ArticleEntry(props: {
  onExtractArticle: () => void;
  onExtractSelection: () => void;
  onPaste: (args: { text: string; title: string; url: string }) => void;
}) {
  const [showPaste, setShowPaste] = useState(false);
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  return (
    <div className="space-y-2.5 rounded-xl nt-surface p-4">
      <div className="nt-caption">Add a source</div>
      <div className="flex flex-wrap gap-2">
        <button
          className="nt-btn nt-btn-primary"
          onClick={props.onExtractArticle}
        >
          Extract article
        </button>
        <button className="nt-btn" onClick={props.onExtractSelection}>
          Use selection
        </button>
        <button className="nt-btn" onClick={() => setShowPaste((v) => !v)}>
          Paste text
        </button>
      </div>
      {showPaste && (
        <div className="space-y-2 pt-1">
          <input
            className="nt-input"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <input
            className="nt-input"
            placeholder="Source URL (optional)"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <textarea
            className="nt-input"
            rows={6}
            placeholder="Paste the article text…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button
            className="nt-btn nt-btn-primary"
            disabled={!text.trim()}
            onClick={() => props.onPaste({ text, title, url })}
          >
            Use pasted text
          </button>
        </div>
      )}
    </div>
  );
}

function VideoCard({ session }: { session: SessionPayload | null }) {
  if (!session) return null;
  return (
    <div className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-2">
      <div className="font-medium truncate">{session.videoMeta.title}</div>
      {session.videoMeta.channel && (
        <div className="text-xs opacity-70 truncate">
          {session.videoMeta.channel}
        </div>
      )}
    </div>
  );
}

function TopicPicker(props: {
  topics: string[];
  selectedTopic: string;
  newTopicTitle: string;
  isNewTopic: boolean;
  currentTopicDescription: string;
  savedTopicDescription: string;
  durationSeconds: number | null;
  rangeStartSeconds: number | null;
  rangeEndSeconds: number | null;
  onChangeRange: (start: number | null, end: number | null) => void;
  onPick: (slug: string) => void | Promise<void>;
  onSetIsNew: (b: boolean) => void;
  onChangeNewTitle: (t: string) => void;
  onChangeDescription: (d: string) => void;
  onSaveDescription: () => void | Promise<void>;
  onGenerate: () => void;
}) {
  const hasNewTitle = props.newTopicTitle.trim().length > 0;
  // Show the description editor once a topic is selected (existing) or
  // being created (new). Hide it before the user has picked anything.
  const showDescription = Boolean(props.selectedTopic) || hasNewTitle;
  const descriptionDirty =
    props.currentTopicDescription !== props.savedTopicDescription;
  return (
    <div className="space-y-3">
      {props.topics.length > 0 && (
        <div className="space-y-1">
          <label className="block text-xs font-medium opacity-80">
            Pick existing topic
          </label>
          <select
            className="nt-input"
            value={hasNewTitle ? "" : props.selectedTopic}
            onChange={(e) => {
              const v = e.target.value;
              if (v) {
                // Picking an existing topic clears the new-title input
                props.onChangeNewTitle("");
                props.onSetIsNew(false);
                props.onPick(v);
              }
            }}
          >
            <option value="">— pick a topic —</option>
            {props.topics.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="space-y-1">
        <label className="block text-xs font-medium opacity-80">
          {props.topics.length > 0 ? "Or create a new topic" : "New topic"}
        </label>
        <input
          className="nt-input"
          placeholder="Topic title (e.g. Iran-Israel war)"
          value={props.newTopicTitle}
          onChange={(e) => {
            props.onChangeNewTitle(e.target.value);
            props.onSetIsNew(e.target.value.trim().length > 0);
          }}
        />
        {(() => {
          const newSlug = slugify(props.newTopicTitle);
          if (!newSlug) return null;
          if (props.topics.includes(newSlug)) {
            return (
              <div className="text-xs text-amber-700 dark:text-amber-300">
                ⚠ A topic <code>{newSlug}</code> already exists — notes will be
                added to it. Pick it from the dropdown above to confirm.
              </div>
            );
          }
          return null;
        })()}
      </div>
      {showDescription && (
        <div className="space-y-1">
          <label className="block text-xs font-medium opacity-80">
            What is the goal of this topic?
          </label>
          <textarea
            className="nt-input"
            rows={3}
            placeholder="e.g. Understand the realist-vs-liberal debate on Russia-Ukraine. Used by the LLM to flag candidate notes as 'gold' when they advance this goal and aren't already covered."
            value={props.currentTopicDescription}
            onChange={(e) => props.onChangeDescription(e.target.value)}
          />
          <div className="flex justify-between items-center">
            <span className="text-xs opacity-60">
              {props.isNewTopic
                ? "Saved with topic.md on first commit."
                : descriptionDirty
                  ? "Unsaved change."
                  : "Saved."}
            </span>
            {!props.isNewTopic && descriptionDirty && (
              <button
                className="text-xs underline opacity-80 hover:opacity-100"
                onClick={() => void props.onSaveDescription()}
              >
                Save description
              </button>
            )}
          </div>
        </div>
      )}
      {props.durationSeconds && props.durationSeconds > 0 && (
        <RangeSlider
          durationSeconds={props.durationSeconds}
          startSeconds={props.rangeStartSeconds}
          endSeconds={props.rangeEndSeconds}
          onChange={props.onChangeRange}
        />
      )}
      <button
        className="nt-btn nt-btn-primary w-full"
        onClick={props.onGenerate}
      >
        Generate notes from this video
      </button>
    </div>
  );
}

// Dual-handle range slider over the video's full duration. Two stacked
// Single-track dual-thumb slider (Radix). minStepsBetweenThumbs keeps
// start < end; null start/end mean "use full video".
function RangeSlider(props: {
  durationSeconds: number;
  startSeconds: number | null;
  endSeconds: number | null;
  onChange: (start: number | null, end: number | null) => void;
}) {
  const total = props.durationSeconds;
  const start = props.startSeconds ?? 0;
  const end = props.endSeconds ?? total;
  const isFull = start === 0 && end === total;
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-center">
        <label className="block text-xs font-medium opacity-80">
          Video range to send to the LLM
        </label>
        {!isFull && (
          <button
            className="text-xs underline opacity-70 hover:opacity-100"
            onClick={() => props.onChange(null, null)}
          >
            reset to full video
          </button>
        )}
      </div>
      <div className="text-xs opacity-70">
        {formatTs(start)} – {formatTs(end)}
        {isFull ? " (full video)" : ""}
      </div>
      <Slider.Root
        className="relative flex items-center select-none touch-none w-full h-5"
        min={0}
        max={total}
        step={1}
        minStepsBetweenThumbs={1}
        value={[start, end]}
        onValueChange={([s, e]) => {
          if (s === 0 && e === total) props.onChange(null, null);
          else props.onChange(s, e);
        }}
      >
        <Slider.Track className="relative grow h-1 rounded-full bg-black/15 dark:bg-white/20">
          <Slider.Range className="absolute h-full rounded-full bg-[#4285F4]" />
        </Slider.Track>
        <Slider.Thumb
          className="block w-4 h-4 rounded-full bg-[#4285F4] shadow ring-1 ring-black/10 focus:outline-none focus:ring-2 focus:ring-[#4285F4]"
          aria-label="Range start"
        />
        <Slider.Thumb
          className="block w-4 h-4 rounded-full bg-[#4285F4] shadow ring-1 ring-black/10 focus:outline-none focus:ring-2 focus:ring-[#4285F4]"
          aria-label="Range end"
        />
      </Slider.Root>
    </div>
  );
}

function CandidateList(props: {
  stack: DrillFrame[];
  onToggle: (i: number) => void;
  onDrillCandidate: (i: number) => void;
  onBack: () => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  const frame = props.stack[props.stack.length - 1];
  const depth = props.stack.length - 1; // 0 = root
  // Walk the whole drill tree so selections on un-navigated branches still count.
  const totalSelected = countSelectedInTree(props.stack[0] ?? null);

  return (
    <div className="space-y-3">
      {depth > 0 && (
        <div className="space-y-1">
          <button
            className="text-xs underline opacity-80 hover:opacity-100"
            onClick={props.onBack}
          >
            ← back
          </button>
          <Breadcrumb stack={props.stack} />
        </div>
      )}
      <ul className="space-y-2">
        {frame.candidates.map((n, i) => {
          const selected = frame.selectedIdxs.has(i);
          const gold = n.gold === true;
          return (
            <li
              key={i}
              role="button"
              tabIndex={0}
              onClick={() => props.onToggle(i)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  props.onToggle(i);
                }
              }}
              className={
                "relative rounded-lg border px-3 py-2 pr-9 cursor-pointer transition-colors " +
                (selected
                  ? // selected notes use the accent blue (matches the primary button) whether white or gold
                    "bg-[#4285F4] text-white border-[#4285F4]"
                  : gold
                    ? "bg-amber-100 text-amber-950 border-amber-300 hover:bg-amber-200 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-800 dark:hover:bg-amber-900"
                    : "border-slate-300 hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800")
              }
            >
              <div className="space-y-1">
                <div className="font-medium">{n.title}</div>
                <div className="text-xs opacity-80 whitespace-pre-wrap">
                  {n.content}
                </div>
                <div className="text-xs opacity-60">
                  {n.claim_type}
                  {n.start_seconds != null && n.end_seconds != null
                    ? ` · ${formatTs(n.start_seconds)} – ${formatTs(n.end_seconds)}`
                    : n.quote
                      ? ` · “${n.quote.slice(0, 60)}${n.quote.length > 60 ? "…" : ""}”`
                      : ""}
                </div>
              </div>
              <button
                aria-label="Drill into this note"
                title="Drill into this note"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onDrillCandidate(i);
                }}
                className={
                  "absolute top-1.5 right-2 text-lg font-semibold leading-none px-1 rounded " +
                  (selected
                    ? "text-white hover:bg-white/20"
                    : "opacity-60 hover:opacity-100 hover:bg-slate-200 dark:hover:bg-slate-700")
                }
              >
                ›
              </button>
            </li>
          );
        })}
      </ul>
      <div className="flex gap-2 items-center">
        <button
          className="nt-btn nt-btn-primary"
          onClick={props.onCommit}
          disabled={totalSelected === 0}
        >
          Commit {totalSelected}
        </button>
        <button className="nt-btn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Breadcrumb({ stack }: { stack: DrillFrame[] }) {
  const parents = stack
    .map((f) => f.parent?.llmNote.title)
    .filter((t): t is string => !!t);
  if (parents.length === 0) return null;
  return (
    <div className="text-xs opacity-70 truncate">
      {parents.map((t, i) => (
        <span key={i}>
          {i > 0 && " › "}
          <span className={i === parents.length - 1 ? "font-medium" : ""}>
            {t}
          </span>
        </span>
      ))}
    </div>
  );
}

function CommitBannerView(props: {
  banner: { count: number; url: string | null };
  onDismiss: () => void;
}) {
  return (
    <div className="rounded bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100 px-3 py-2 flex justify-between gap-2 items-start">
      <div>
        <div className="font-medium">
          Committed {props.banner.count} note
          {props.banner.count === 1 ? "" : "s"}.
        </div>
        {props.banner.url && (
          <a
            className="text-xs underline"
            href={props.banner.url}
            target="_blank"
            rel="noreferrer"
          >
            view commit on github
          </a>
        )}
      </div>
      <button
        className="text-xs opacity-70 hover:opacity-100 shrink-0"
        onClick={props.onDismiss}
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}

function effectiveTopic(s: ReturnType<typeof useStore.getState>): string {
  if (s.isNewTopic) return slugify(s.newTopicTitle || s.selectedTopic);
  return s.selectedTopic;
}

// Walk the whole drill tree (rooted at drillStack[0]) and produce the flat
// list of notes to commit. Every ticked candidate anywhere in the tree is
// emitted, not just the ones on the current path. parents is set to the
// nearest ticked ancestor on the drill chain (or [] if none ticked above).
// IDs are stable across drilled-into candidates: if you tick the same note
// you also drilled into, the saved note's ID matches its descendants' parents.
function buildCommitNotes(
  root: DrillFrame | null,
): Array<{ id: string; llmNote: LLMNote; parents: string[] }> {
  if (!root) return [];

  // First pass: any candidate that was drilled into already has a stable
  // pre-assigned ULID stored as child.parent.id. Map LLMNote → id so that
  // if the user also tickets the drilled-into candidate, the saved note
  // uses the same id its descendants reference in their parents[] array.
  const idForCandidate = new Map<LLMNote, string>();
  const assignIds = (frame: DrillFrame) => {
    for (const [idxStr, child] of Object.entries(frame.childrenByCandidateIdx)) {
      const idx = Number(idxStr);
      const candidate = frame.candidates[idx];
      if (candidate && child.parent) {
        idForCandidate.set(candidate, child.parent.id);
      }
      assignIds(child);
    }
  };
  assignIds(root);

  // Second pass: walk the tree and emit every ticked candidate.
  const result: Array<{ id: string; llmNote: LLMNote; parents: string[] }> = [];
  type Ancestor = { id: string; ticked: boolean };
  const walk = (frame: DrillFrame, chain: Ancestor[]) => {
    const nearestTicked =
      [...chain].reverse().find((a) => a.ticked)?.id ?? null;
    const sortedIdxs = Array.from(frame.selectedIdxs).sort((a, b) => a - b);
    for (const idx of sortedIdxs) {
      const llmNote = frame.candidates[idx];
      if (!llmNote) continue;
      let id = idForCandidate.get(llmNote);
      if (!id) {
        id = ulid();
        idForCandidate.set(llmNote, id);
      }
      result.push({
        id,
        llmNote,
        parents: nearestTicked ? [nearestTicked] : [],
      });
    }
    for (const [idxStr, child] of Object.entries(frame.childrenByCandidateIdx)) {
      const idx = Number(idxStr);
      const drilledInto = frame.candidates[idx];
      if (!drilledInto || !child.parent) continue;
      walk(child, [
        ...chain,
        { id: child.parent.id, ticked: frame.selectedIdxs.has(idx) },
      ]);
    }
  };
  walk(root, []);
  return result;
}

// Total ticked across the entire drill tree (not just the current path).
function countSelectedInTree(root: DrillFrame | null): number {
  if (!root) return 0;
  let n = root.selectedIdxs.size;
  for (const child of Object.values(root.childrenByCandidateIdx)) {
    n += countSelectedInTree(child);
  }
  return n;
}

// Convert raw provider errors into something the user can act on.
function friendlyError(msg: string): string {
  // Try to extract JSON error body (Gemini returns these as JSON-in-Error)
  const jsonMatch = msg.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      const code = obj?.error?.code;
      const status = obj?.error?.status;
      if (code === 429 || status === "RESOURCE_EXHAUSTED") {
        if (/gemini-2\.5-pro/.test(msg)) {
          return "Gemini Pro quota exceeded. Switch model to gemini-2.5-flash in Settings (free tier).";
        }
        return "Gemini quota exceeded — retry in a minute, or switch to a different model in Settings.";
      }
      if (code === 503 || status === "UNAVAILABLE") {
        return "Gemini is busy right now. Hit Retry — usually clears in a few seconds.";
      }
      if (code === 500 || status === "INTERNAL") {
        return "Gemini hit an internal error. Hit Retry, or try again in a moment.";
      }
      if (code === 401 || code === 403) {
        return "Gemini rejected the API key. Check it in Settings.";
      }
    } catch {}
  }
  // GitHub error patterns
  if (/Bad credentials|401/i.test(msg)) {
    return "GitHub PAT rejected. Update it in Settings.";
  }
  if (/Not Found.*repos/i.test(msg)) {
    return "GitHub repo not found, or your PAT doesn't have access to it.";
  }
  return msg.length > 200 ? msg.slice(0, 200) + "…" : msg;
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function formatTs(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function Styles() {
  return (
    <style>{`
      .nt-input {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid rgba(120,120,120,0.4);
        border-radius: 8px;
        background: transparent;
        font: inherit;
        color: inherit;
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      .nt-input:focus {
        outline: none;
        border-color: #4285F4;
        box-shadow: 0 0 0 3px rgba(66,133,244,0.2);
      }
      .nt-btn {
        padding: 7px 16px;
        border-radius: 9999px;
        border: 1px solid rgba(120,120,120,0.4);
        background: transparent;
        font-weight: 500;
        cursor: pointer;
        transition: background 0.15s, box-shadow 0.15s, border-color 0.15s;
      }
      .nt-btn:hover:not(:disabled) { background: rgba(120,120,120,0.1); }
      .nt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .nt-btn-primary {
        background: #4285F4;
        color: #ffffff;
        border-color: #4285F4;
      }
      .nt-btn-primary:hover:not(:disabled) {
        background: #3367d6;
        border-color: #3367d6;
        box-shadow: 0 1px 3px rgba(60,64,67,0.3);
      }
      /* low-emphasis model badge in the header */
      .nt-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 10px 2px 8px;
        border-radius: 9999px;
        font-size: 11px;
        font-weight: 500;
        letter-spacing: 0.01em;
        color: rgba(120,120,120,0.95);
        background: rgba(120,120,120,0.08);
      }
      /* small live dot on the model chip */
      .nt-chip::before {
        content: "";
        width: 6px;
        height: 6px;
        border-radius: 9999px;
        background: #34A853;
      }
      /* tonal surface for grouping cards (Material-ish, no hard border) */
      .nt-surface {
        background: rgba(66,133,244,0.05);
        border: 1px solid rgba(66,133,244,0.16);
      }
      @media (prefers-color-scheme: dark) {
        .nt-surface { background: rgba(66,133,244,0.10); border-color: rgba(66,133,244,0.22); }
      }
      /* uppercase section caption */
      .nt-caption {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        opacity: 0.6;
      }
      /* quiet text/icon link button (replaces raw underlined links) */
      .nt-link-btn {
        font-size: 12px;
        font-weight: 500;
        color: #4285F4;
        background: transparent;
        border: none;
        padding: 2px 4px;
        border-radius: 6px;
        cursor: pointer;
      }
      .nt-link-btn:hover { background: rgba(66,133,244,0.1); }
      /* circular settings button */
      .nt-icon-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        border-radius: 9999px;
        border: none;
        background: transparent;
        color: inherit;
        opacity: 0.7;
        cursor: pointer;
        transition: background 0.15s, opacity 0.15s;
      }
      .nt-icon-btn:hover { opacity: 1; background: rgba(120,120,120,0.15); }
    `}</style>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
