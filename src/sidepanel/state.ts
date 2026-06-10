import { create } from "zustand";
import type {
  CommittedNoteRef,
  LLMNote,
  SessionPayload,
  Settings,
} from "@/lib/types";

export type Phase =
  | "loading"
  | "no-settings"
  | "no-session"
  | "topic-picker"
  | "generating"
  | "candidates"
  | "committing"
  | "committed"
  | "error";

// One frame per drill level. drillStack[0] is the root level (no parent).
// Each frame caches its candidates + selection, so going back is instant
// (no LLM re-call). When the user drills, a new frame is pushed; the new
// frame's `parent` is the candidate that was drilled into, with a stable
// pre-assigned ULID so descendants can reference it via `parents`.
export interface DrillFrame {
  parent: { id: string; llmNote: LLMNote } | null; // null only for the root frame
  candidates: LLMNote[];
  selectedIdxs: Set<number>;
}

interface State {
  phase: Phase;
  errorMessage: string | null;
  settings: Settings | null;
  session: SessionPayload | null;
  topics: string[];
  selectedTopic: string;
  newTopicTitle: string;
  isNewTopic: boolean;
  drillStack: DrillFrame[];
  committedRefs: CommittedNoteRef[];
  lastCommitUrl: string | null;
  notesForTopic: { id: string; title: string; path: string }[];
}

interface Actions {
  setPhase: (p: Phase) => void;
  setError: (m: string | null) => void;
  setSettings: (s: Settings | null) => void;
  setSession: (s: SessionPayload | null) => void;
  setTopics: (t: string[]) => void;
  pickTopic: (t: string) => void;
  setNewTopicTitle: (t: string) => void;
  setIsNewTopic: (b: boolean) => void;
  // Replace the drill stack entirely (used when we regenerate root candidates).
  setRootFrame: (candidates: LLMNote[]) => void;
  pushDrillFrame: (frame: DrillFrame) => void;
  popDrillFrame: () => void;
  toggleSelected: (idx: number) => void;
  clearStack: () => void;
  setCommittedRefs: (r: CommittedNoteRef[]) => void;
  setLastCommitUrl: (u: string | null) => void;
  setNotesForTopic: (
    n: { id: string; title: string; path: string }[],
  ) => void;
  resetForNewBatch: () => void;
}

export const useStore = create<State & Actions>((set) => ({
  phase: "loading",
  errorMessage: null,
  settings: null,
  session: null,
  topics: [],
  selectedTopic: "",
  newTopicTitle: "",
  isNewTopic: false,
  drillStack: [],
  committedRefs: [],
  lastCommitUrl: null,
  notesForTopic: [],

  setPhase: (phase) => set({ phase }),
  setError: (errorMessage) => set({ errorMessage }),
  setSettings: (settings) => set({ settings }),
  setSession: (session) => set({ session }),
  setTopics: (topics) => set({ topics }),
  pickTopic: (selectedTopic) =>
    set({ selectedTopic, isNewTopic: false, newTopicTitle: "" }),
  setNewTopicTitle: (newTopicTitle) => set({ newTopicTitle }),
  setIsNewTopic: (isNewTopic) => set({ isNewTopic }),
  setRootFrame: (candidates) =>
    set({
      drillStack: [
        { parent: null, candidates, selectedIdxs: new Set<number>() },
      ],
    }),
  pushDrillFrame: (frame) =>
    set((s) => ({ drillStack: [...s.drillStack, frame] })),
  popDrillFrame: () =>
    set((s) => ({ drillStack: s.drillStack.slice(0, -1) })),
  toggleSelected: (idx) =>
    set((s) => {
      if (s.drillStack.length === 0) return {};
      const stack = s.drillStack.slice();
      const last = { ...stack[stack.length - 1] };
      const next = new Set(last.selectedIdxs);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      last.selectedIdxs = next;
      stack[stack.length - 1] = last;
      return { drillStack: stack };
    }),
  clearStack: () => set({ drillStack: [] }),
  setCommittedRefs: (committedRefs) => set({ committedRefs }),
  setLastCommitUrl: (lastCommitUrl) => set({ lastCommitUrl }),
  setNotesForTopic: (notesForTopic) => set({ notesForTopic }),
  resetForNewBatch: () =>
    set({
      drillStack: [],
      committedRefs: [],
      lastCommitUrl: null,
      phase: "topic-picker",
    }),
}));

export function isSettingsComplete(s: Settings | null): boolean {
  if (!s) return false;
  return Boolean(
    s.geminiApiKey && s.githubToken && s.githubOwner && s.githubRepo,
  );
}

export function currentFrame(s: { drillStack: DrillFrame[] }): DrillFrame | null {
  return s.drillStack[s.drillStack.length - 1] ?? null;
}
