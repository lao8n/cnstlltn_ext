import { create } from "zustand";
import type { LLMNote, SessionPayload, Settings } from "@/lib/types";

export type Phase =
  | "loading"
  | "no-settings"
  | "no-session"
  | "topic-picker"
  | "generating"
  | "candidates"
  | "committing"
  | "error";

// One frame per drill level. drillStack[0] is the root level (no parent).
// Each frame caches its candidates + selection. childrenByCandidateIdx keeps
// previously generated drill results so navigating up/down the tree never
// re-calls the LLM for the same branch.
export interface DrillFrame {
  parent: { id: string; llmNote: LLMNote } | null; // null only for the root frame
  candidates: LLMNote[];
  selectedIdxs: Set<number>;
  childrenByCandidateIdx: Record<number, DrillFrame>;
  // Index in the parent frame's candidates that was drilled into (undefined on root).
  drilledFromIdx?: number;
}

export interface CommitBanner {
  count: number;
  url: string | null;
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
  // Description of the currently picked/created topic. For existing topics,
  // loaded from topic.md's frontmatter when the topic is selected. For new
  // topics, empty until the user types one, then persisted on first commit
  // (because topic.md doesn't exist yet — see SAVE_TOPIC_DESCRIPTION).
  currentTopicDescription: string;
  // Last description that's actually saved to GitHub (or "" for a new topic).
  // Used to detect dirty state for the Save button.
  savedTopicDescription: string;
  drillStack: DrillFrame[];
  commitBanner: CommitBanner | null;
  notesForTopic: { id: string; title: string; path: string }[];
  // User-chosen subset of the current video to send to the LLM. null = use
  // the full video. Reset when the active video changes.
  rangeStartSeconds: number | null;
  rangeEndSeconds: number | null;
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
  setCurrentTopicDescription: (d: string) => void;
  setSavedTopicDescription: (d: string) => void;
  setRange: (start: number | null, end: number | null) => void;
  // Replace the drill stack entirely (used when we regenerate root candidates).
  setRootFrame: (candidates: LLMNote[]) => void;
  pushDrillFrame: (frame: DrillFrame) => void;
  cacheChildFrame: (candidateIdx: number, frame: DrillFrame) => void;
  popDrillFrame: () => void;
  popToStackRoot: () => void;
  toggleSelected: (idx: number) => void;
  clearStack: () => void;
  setCommitBanner: (b: CommitBanner | null) => void;
  setNotesForTopic: (
    n: { id: string; title: string; path: string }[],
  ) => void;
  resetForNewBatch: () => void;
}

/** Keep parent's childrenByCandidateIdx in sync with the live stack top. */
function syncTopFrameToParentCache(stack: DrillFrame[]): DrillFrame[] {
  if (stack.length < 2) return stack;
  const child = stack[stack.length - 1];
  const drillIdx = child.drilledFromIdx;
  if (drillIdx == null) return stack;
  const stackCopy = stack.slice();
  const parent = { ...stackCopy[stackCopy.length - 2] };
  parent.childrenByCandidateIdx = {
    ...parent.childrenByCandidateIdx,
    [drillIdx]: child,
  };
  stackCopy[stackCopy.length - 2] = parent;
  return stackCopy;
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
  currentTopicDescription: "",
  savedTopicDescription: "",
  drillStack: [],
  commitBanner: null,
  notesForTopic: [],
  rangeStartSeconds: null,
  rangeEndSeconds: null,

  setPhase: (phase) => set({ phase }),
  setError: (errorMessage) => set({ errorMessage }),
  setSettings: (settings) => set({ settings }),
  setSession: (session) => set({ session }),
  setTopics: (topics) => set({ topics }),
  pickTopic: (selectedTopic) =>
    set({
      selectedTopic,
      isNewTopic: false,
      newTopicTitle: "",
      // Clear description when switching topic — caller will re-fetch.
      currentTopicDescription: "",
      savedTopicDescription: "",
    }),
  setNewTopicTitle: (newTopicTitle) => set({ newTopicTitle }),
  setIsNewTopic: (isNewTopic) => set({ isNewTopic }),
  setCurrentTopicDescription: (currentTopicDescription) =>
    set({ currentTopicDescription }),
  setSavedTopicDescription: (savedTopicDescription) =>
    set({ savedTopicDescription }),
  setRange: (rangeStartSeconds, rangeEndSeconds) =>
    set({ rangeStartSeconds, rangeEndSeconds }),
  setRootFrame: (candidates) =>
    set({
      commitBanner: null,
      drillStack: [
        {
          parent: null,
          candidates,
          selectedIdxs: new Set<number>(),
          childrenByCandidateIdx: {},
        },
      ],
    }),
  pushDrillFrame: (frame) =>
    set((s) => ({ drillStack: [...s.drillStack, frame] })),
  cacheChildFrame: (candidateIdx, frame) =>
    set((s) => {
      if (s.drillStack.length === 0) return {};
      const stack = s.drillStack.slice();
      const top = { ...stack[stack.length - 1] };
      top.childrenByCandidateIdx = {
        ...top.childrenByCandidateIdx,
        [candidateIdx]: frame,
      };
      stack[stack.length - 1] = top;
      return { drillStack: stack };
    }),
  popDrillFrame: () =>
    set((s) => {
      if (s.drillStack.length <= 1) return {};
      const synced = syncTopFrameToParentCache(s.drillStack);
      return { drillStack: synced.slice(0, -1) };
    }),
  popToStackRoot: () =>
    set((s) => ({
      drillStack: s.drillStack.length > 0 ? [s.drillStack[0]] : [],
      phase: "candidates",
    })),
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
      return { drillStack: syncTopFrameToParentCache(stack) };
    }),
  clearStack: () => set({ drillStack: [], commitBanner: null }),
  setCommitBanner: (commitBanner) => set({ commitBanner }),
  setNotesForTopic: (notesForTopic) => set({ notesForTopic }),
  resetForNewBatch: () =>
    set({
      drillStack: [],
      commitBanner: null,
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
