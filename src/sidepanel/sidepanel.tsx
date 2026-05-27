import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { getSettings } from "@/lib/storage";
import type {
  CommitResult,
  LLMNote,
  SessionPayload,
  Settings,
} from "@/lib/types";
import { useStore, isSettingsComplete } from "./state";

async function send<T>(msg: object): Promise<T> {
  const resp = (await chrome.runtime.sendMessage(msg)) as
    | { ok: true; result: T }
    | { ok: false; error: string };
  if (!resp.ok) throw new Error(resp.error);
  return resp.result;
}

function App() {
  const s = useStore();

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
    const session = await send<SessionPayload | null>({ type: "GET_SESSION" });
    s.setSession(session);
    if (!session) {
      s.setPhase("no-session");
      return;
    }
    try {
      const topics = await send<string[]>({ type: "LIST_TOPICS" });
      s.setTopics(topics);
    } catch (err) {
      s.setError(`Could not list topics: ${(err as Error).message}`);
    }
    s.setPhase("topic-picker");
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
      const { notes } = await send<{ notes: LLMNote[] }>({
        type: "GENERATE_ROOT",
        topic,
      });
      s.setDrill(null);
      s.setCandidates(notes);
      s.setPhase("candidates");
    } catch (err) {
      s.setError((err as Error).message);
      s.setPhase("error");
    }
  }

  async function onCommit() {
    const topic = effectiveTopic(s);
    if (!topic) return;
    const llmNotes = Array.from(s.selectedIdxs)
      .sort((a, b) => a - b)
      .map((i) => s.candidates[i]);
    if (llmNotes.length === 0) {
      s.setError("Select at least one note.");
      return;
    }
    s.setError(null);
    s.setPhase("committing");
    try {
      const result = await send<CommitResult>({
        type: "COMMIT_NOTES",
        topic,
        topicTitle: s.isNewTopic ? s.newTopicTitle.trim() || topic : null,
        isNewTopic: s.isNewTopic && s.drill === null,
        includeTranscript: s.drill === null,
        llmNotes,
        parents: s.drill ? [s.drill.parentId] : [],
      });
      s.setCommittedRefs(result.noteRefs);
      s.setLastCommitUrl(result.url);
      s.setPhase("committed");
      try {
        const notes = await send<{ id: string; title: string; path: string }[]>({
          type: "LIST_NOTES_FOR_TOPIC",
          topic,
        });
        s.setNotesForTopic(notes);
      } catch {}
    } catch (err) {
      s.setError((err as Error).message);
      s.setPhase("error");
    }
  }

  async function onDrill(parent: {
    id: string;
    title: string;
    content: string;
  }) {
    const topic = effectiveTopic(s);
    if (!topic) return;
    s.setError(null);
    s.setPhase("generating");
    try {
      const { notes } = await send<{ notes: LLMNote[] }>({
        type: "GENERATE_DRILL",
        topic,
        parentNote: { title: parent.title, content: parent.content },
      });
      s.setDrill({
        parentId: parent.id,
        parentTitle: parent.title,
        parentContent: parent.content,
      });
      s.setCandidates(notes);
      s.setPhase("candidates");
    } catch (err) {
      s.setError((err as Error).message);
      s.setPhase("error");
    }
  }

  async function refreshNotesForTopic() {
    const topic = effectiveTopic(s);
    if (!topic) return;
    try {
      const notes = await send<{ id: string; title: string; path: string }[]>({
        type: "LIST_NOTES_FOR_TOPIC",
        topic,
      });
      s.setNotesForTopic(notes);
    } catch {}
  }

  return (
    <div className="p-4 max-w-xl mx-auto text-sm space-y-4">
      <Header />
      {s.errorMessage && (
        <div className="rounded bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-100 px-3 py-2">
          {s.errorMessage}
        </div>
      )}

      {s.phase === "loading" && <div>Loading…</div>}

      {s.phase === "no-settings" && (
        <div className="space-y-2">
          <p>You need to configure Notetaker first.</p>
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
            Notetaker button.
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
          isNewTopic={s.isNewTopic}
          newTopicTitle={s.newTopicTitle}
          onPick={(t) => s.pickTopic(t)}
          onSetIsNew={(b) => s.setIsNewTopic(b)}
          onChangeNewTitle={(t) => s.setNewTopicTitle(t)}
          onChangeNewSlug={(slug) => s.pickTopic(slug)}
          onGenerate={onGenerate}
        />
      )}

      {s.phase === "generating" && (
        <div className="opacity-70">
          Generating notes from transcript… (this can take 10–30s)
        </div>
      )}

      {s.phase === "candidates" && (
        <CandidateList
          drill={s.drill}
          candidates={s.candidates}
          selectedIdxs={s.selectedIdxs}
          onToggle={(i) => s.toggleSelected(i)}
          onCommit={onCommit}
          onCancel={() => {
            s.setCandidates([]);
            s.setDrill(null);
            s.setPhase("topic-picker");
          }}
        />
      )}

      {s.phase === "committing" && <div>Committing to GitHub…</div>}

      {s.phase === "committed" && (
        <CommittedView
          refs={s.committedRefs}
          url={s.lastCommitUrl}
          notesForTopic={s.notesForTopic}
          onDrill={onDrill}
          onAnother={async () => {
            s.resetForNewBatch();
            await refreshNotesForTopic();
          }}
        />
      )}

      {s.phase === "error" && (
        <button
          className="nt-btn"
          onClick={() => {
            s.setError(null);
            s.setPhase("topic-picker");
          }}
        >
          Back
        </button>
      )}

      <Styles />
    </div>
  );
}

function Header() {
  return (
    <header className="flex items-center justify-between">
      <h1 className="font-semibold text-base">📝 Notetaker</h1>
      <button
        className="text-xs underline opacity-70"
        onClick={() => chrome.runtime.openOptionsPage()}
      >
        settings
      </button>
    </header>
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
  isNewTopic: boolean;
  newTopicTitle: string;
  onPick: (slug: string) => void;
  onSetIsNew: (b: boolean) => void;
  onChangeNewTitle: (t: string) => void;
  onChangeNewSlug: (slug: string) => void;
  onGenerate: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label className="block text-xs font-medium opacity-80">Topic</label>
        {props.topics.length > 0 && !props.isNewTopic && (
          <select
            className="nt-input"
            value={props.selectedTopic}
            onChange={(e) => {
              if (e.target.value === "__new__") props.onSetIsNew(true);
              else props.onPick(e.target.value);
            }}
          >
            <option value="" disabled>
              — pick a topic —
            </option>
            {props.topics.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
            <option value="__new__">+ create new topic</option>
          </select>
        )}
        {(props.topics.length === 0 || props.isNewTopic) && (
          <div className="space-y-2">
            <input
              className="nt-input"
              placeholder="Topic title (e.g. Iran-Israel war)"
              value={props.newTopicTitle}
              onChange={(e) => {
                props.onChangeNewTitle(e.target.value);
                props.onChangeNewSlug(slugify(e.target.value));
                props.onSetIsNew(true);
              }}
            />
            <div className="text-xs opacity-60">
              slug: <code>{props.selectedTopic || "—"}</code>
            </div>
            {props.topics.length > 0 && (
              <button
                className="text-xs underline opacity-70"
                onClick={() => props.onSetIsNew(false)}
              >
                pick existing instead
              </button>
            )}
          </div>
        )}
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
  drill: { parentTitle: string } | null;
  candidates: LLMNote[];
  selectedIdxs: Set<number>;
  onToggle: (i: number) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-3">
      {props.drill && (
        <div className="text-xs opacity-70">
          Drilling into: <span className="font-medium">{props.drill.parentTitle}</span>
        </div>
      )}
      <ul className="space-y-2">
        {props.candidates.map((n, i) => (
          <li
            key={i}
            className="rounded border border-slate-300 dark:border-slate-700 px-3 py-2"
          >
            <label className="flex gap-2 items-start cursor-pointer">
              <input
                type="checkbox"
                checked={props.selectedIdxs.has(i)}
                onChange={() => props.onToggle(i)}
                className="mt-1"
              />
              <div className="flex-1 min-w-0 space-y-1">
                <div className="font-medium">{n.title}</div>
                <div className="text-xs opacity-80 whitespace-pre-wrap">{n.content}</div>
                <div className="text-xs opacity-60 flex flex-wrap gap-1">
                  <span>{n.claim_type}</span>
                  <span>·</span>
                  <span>
                    {formatTs(n.start_seconds)} – {formatTs(n.end_seconds)}
                  </span>
                  {n.flag && (
                    <>
                      <span>·</span>
                      <span className="text-amber-700 dark:text-amber-300">
                        more detail
                      </span>
                    </>
                  )}
                  {n.tags.length > 0 && (
                    <>
                      <span>·</span>
                      <span>{n.tags.join(", ")}</span>
                    </>
                  )}
                </div>
              </div>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <button
          className="nt-btn nt-btn-primary"
          onClick={props.onCommit}
          disabled={props.selectedIdxs.size === 0}
        >
          Commit {props.selectedIdxs.size} selected
        </button>
        <button className="nt-btn" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function CommittedView(props: {
  refs: { id: string; title: string }[];
  url: string | null;
  notesForTopic: { id: string; title: string; path: string }[];
  onDrill: (n: { id: string; title: string; content: string }) => void;
  onAnother: () => void;
}) {
  const [drillIdx, setDrillIdx] = React.useState<string>("");
  const all = props.notesForTopic;
  return (
    <div className="space-y-3">
      <div className="rounded bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100 px-3 py-2">
        <div className="font-medium">
          Committed {props.refs.length} note{props.refs.length === 1 ? "" : "s"}.
        </div>
        {props.url && (
          <a
            className="text-xs underline"
            href={props.url}
            target="_blank"
            rel="noreferrer"
          >
            view commit on github
          </a>
        )}
      </div>

      {all.length > 0 && (
        <div className="space-y-2">
          <label className="block text-xs font-medium opacity-80">
            Drill into an existing note for this topic
          </label>
          <select
            className="nt-input"
            value={drillIdx}
            onChange={(e) => setDrillIdx(e.target.value)}
          >
            <option value="">— pick a note —</option>
            {all.map((n) => (
              <option key={n.id} value={n.id}>
                {n.title}
              </option>
            ))}
          </select>
          <button
            className="nt-btn"
            disabled={!drillIdx}
            onClick={async () => {
              const picked = all.find((n) => n.id === drillIdx);
              if (!picked) return;
              const content = await fetchNoteContent(picked.path).catch(() => "");
              props.onDrill({
                id: picked.id,
                title: picked.title,
                content,
              });
            }}
          >
            Drill into selected
          </button>
        </div>
      )}

      <button className="nt-btn" onClick={props.onAnother}>
        Start another batch (new topic or same)
      </button>
    </div>
  );
}

async function fetchNoteContent(path: string): Promise<string> {
  // Side panel can't fetch GitHub directly without auth — defer to background later.
  // For now we just send title+empty content as the drill seed; the LLM still
  // uses the full transcript so this is sufficient for v1.
  return "";
}

function effectiveTopic(s: ReturnType<typeof useStore.getState>): string {
  if (s.isNewTopic) return slugify(s.newTopicTitle || s.selectedTopic);
  return s.selectedTopic;
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
