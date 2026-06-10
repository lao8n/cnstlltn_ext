import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { ulid } from "ulid";
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
      s.setPhase("topic-picker");
    }
    const phase = useStore.getState().phase;
    const inWorkflow = ["generating", "candidates", "committing"].includes(
      phase,
    );
    if (phase === "loading" || videoChanged) {
      try {
        const topics = await send<string[]>({ type: "LIST_TOPICS" });
        s.setTopics(topics);
      } catch (err) {
        console.warn("Could not list topics, treating as empty:", err);
        s.setTopics([]);
      }
    }
    if (phase === "loading") {
      s.setPhase("topic-picker");
    } else if (videoChanged) {
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
      const { notes } = await send<{ notes: LLMNote[] }>({
        type: "GENERATE_ROOT",
        topic,
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
      const { notes } = await send<{ notes: LLMNote[] }>({
        type: "GENERATE_DRILL",
        topic,
        parentNote: {
          title: parentLLM.title,
          content: parentLLM.content,
          start_seconds: parentLLM.start_seconds,
          end_seconds: parentLLM.end_seconds,
        },
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
    const notes = buildCommitNotes(s.drillStack);
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
        isNewTopic: s.isNewTopic,
        includeTranscript: true,
        notes,
      });
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
          onPick={(t) => s.pickTopic(t)}
          onSetIsNew={(b) => s.setIsNewTopic(b)}
          onChangeNewTitle={(t) => s.setNewTopicTitle(t)}
          onGenerate={onGenerate}
        />
      )}

      {s.phase === "generating" && (
        <div className="opacity-70">
          Generating notes from transcript… (this can take 10–30s)
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
  onPick: (slug: string) => void;
  onSetIsNew: (b: boolean) => void;
  onChangeNewTitle: (t: string) => void;
  onGenerate: () => void;
}) {
  const hasNewTitle = props.newTopicTitle.trim().length > 0;
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
      <button
        className="nt-btn nt-btn-primary w-full"
        onClick={props.onGenerate}
      >
        Generate notes from this video
      </button>
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
  const totalSelected = props.stack.reduce(
    (n, f) => n + f.selectedIdxs.size,
    0,
  );

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
                  ? "bg-slate-900 text-slate-50 border-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100"
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
                    ? "text-slate-50 hover:bg-slate-700 dark:text-slate-900 dark:hover:bg-slate-300"
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

// Walk the drill stack and produce the flat list of notes to commit.
// Each ticked candidate becomes a commit note. Its `parents` is set to the
// nearest ticked ancestor on the drill chain (or [] if none ticked above).
// IDs are stable across drilled-into candidates: if you tick the same note
// you also drilled into, the saved note's ID matches its descendants' parents.
function buildCommitNotes(
  stack: DrillFrame[],
): Array<{ id: string; llmNote: LLMNote; parents: string[] }> {
  // Map: candidate LLMNote reference → its committed ID
  const idForCandidate = new Map<LLMNote, string>();
  // Pre-populate IDs for drilled-into candidates (already have pre-assigned IDs)
  for (let d = 1; d < stack.length; d++) {
    const parent = stack[d].parent;
    if (parent) idForCandidate.set(parent.llmNote, parent.id);
  }

  const result: Array<{ id: string; llmNote: LLMNote; parents: string[] }> = [];

  for (let d = 0; d < stack.length; d++) {
    const frame = stack[d];
    const idxs = Array.from(frame.selectedIdxs).sort((a, b) => a - b);
    for (const idx of idxs) {
      const llmNote = frame.candidates[idx];
      const id = idForCandidate.get(llmNote) ?? ulid();
      if (!idForCandidate.has(llmNote)) idForCandidate.set(llmNote, id);

      // Find nearest ticked ancestor in the drill chain.
      let parentId: string | null = null;
      for (let p = d - 1; p >= 0; p--) {
        const drilledInto = stack[p + 1]?.parent;
        if (!drilledInto) continue;
        const idxInP = stack[p].candidates.indexOf(drilledInto.llmNote);
        if (idxInP >= 0 && stack[p].selectedIdxs.has(idxInP)) {
          parentId = drilledInto.id;
          break;
        }
      }

      result.push({
        id,
        llmNote,
        parents: parentId ? [parentId] : [],
      });
    }
  }
  return result;
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
