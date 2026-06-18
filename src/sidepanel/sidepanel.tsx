import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ulid } from "ulid";
import * as Slider from "@radix-ui/react-slider";
import "@/index.css";
import { getSettings } from "@/lib/storage";
import type {
  CommitResult,
  LLMNote,
  SessionPayload,
  Settings,
} from "@/lib/types";
import {
  useStore,
  isSettingsComplete,
  currentFrame,
  type DrillFrame,
} from "./state";

async function send<T>(msg: object): Promise<T> {
  const resp = (await chrome.runtime.sendMessage(msg)) as
    | { ok: true; result: T }
    | { ok: false; error: string };
  if (!resp.ok) throw new Error(resp.error);
  return resp.result;
}

function App() {
  const s = useStore();
  // Closure that re-runs the last action that hit an error. Set on every
  // catch; cleared on success. Wired to the Retry button in the error phase.
  const retryRef = React.useRef<(() => void | Promise<void>) | null>(null);

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
    if (!isSettingsComplete(settings)) {
      s.setPhase("no-settings");
      return;
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
      const session = await send<SessionPayload | null>({ type: "GET_SESSION" });
      if (!session) throw new Error("No active transcript session.");
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

  return (
    <div className="p-4 max-w-xl mx-auto text-sm space-y-4">
      <div className="flex justify-between items-center -mb-2">
        <span className="text-xs opacity-60">
          {s.settings?.model ? `model: ${s.settings.model}` : ""}
        </span>
        <button
          className="text-xs underline opacity-70"
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          settings
        </button>
      </div>
      {s.errorMessage && (
        <div className="rounded bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-100 px-3 py-2">
          {s.errorMessage}
        </div>
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

      {s.phase === "no-session" && (
        <div className="space-y-2">
          <p>
            No active video. Go to a YouTube watch page and click the 📝
            cnstlltn button.
          </p>
        </div>
      )}

      {s.phase !== "loading" &&
        s.phase !== "no-settings" &&
        s.phase !== "no-session" && (
          <VideoCard session={s.session} />
        )}

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

      <Styles />
    </div>
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

function VideoCard({ session }: { session: SessionPayload | null }) {
  if (!session) return null;
  const cueCount = session.cues.length;
  return (
    <div className="rounded border border-slate-300 dark:border-slate-700 px-3 py-2">
      <div className="font-medium truncate">{session.videoMeta.title}</div>
      <div className="text-xs opacity-70 truncate">
        {session.videoMeta.channel} · {cueCount} transcript cues
      </div>
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
          <Slider.Range className="absolute h-full rounded-full bg-blue-500" />
        </Slider.Track>
        <Slider.Thumb
          className="block w-4 h-4 rounded-full bg-blue-500 shadow ring-1 ring-black/10 focus:outline-none focus:ring-2 focus:ring-blue-400"
          aria-label="Range start"
        />
        <Slider.Thumb
          className="block w-4 h-4 rounded-full bg-blue-500 shadow ring-1 ring-black/10 focus:outline-none focus:ring-2 focus:ring-blue-400"
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
                "relative rounded border px-3 py-2 pr-9 cursor-pointer transition-colors " +
                (selected
                  ? // selected notes use the same dark navy (matches the primary button) whether white or gold
                    "bg-slate-900 text-slate-50 border-slate-900"
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
                  {n.claim_type} · {formatTs(n.start_seconds)} – {formatTs(n.end_seconds)}
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
                    ? "text-slate-50 hover:bg-slate-700"
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
        padding: 6px 8px;
        border: 1px solid rgba(120,120,120,0.4);
        border-radius: 6px;
        background: transparent;
        font: inherit;
        color: inherit;
      }
      .nt-btn {
        padding: 6px 12px;
        border-radius: 6px;
        border: 1px solid rgba(120,120,120,0.4);
        background: transparent;
        font-weight: 500;
        cursor: pointer;
      }
      .nt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
      .nt-btn-primary {
        background: #0f172a;
        color: #f8fafc;
        border-color: #0f172a;
      }
    `}</style>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
