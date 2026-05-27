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

interface DrillContext {
  parentId: string;
  parentTitle: string;
  parentContent: string;
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
  candidates: LLMNote[];
  selectedIdxs: Set<number>;
  drill: DrillContext | null;
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
  setCandidates: (c: LLMNote[]) => void;
  toggleSelected: (idx: number) => void;
  clearSelected: () => void;
  setDrill: (d: DrillContext | null) => void;
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
  candidates: [],
  selectedIdxs: new Set<number>(),
  drill: null,
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
  setCandidates: (candidates) =>
    set({ candidates, selectedIdxs: new Set<number>() }),
  toggleSelected: (idx) =>
    set((s) => {
      const next = new Set(s.selectedIdxs);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return { selectedIdxs: next };
    }),
  clearSelected: () => set({ selectedIdxs: new Set<number>() }),
  setDrill: (drill) => set({ drill }),
  setCommittedRefs: (committedRefs) => set({ committedRefs }),
  setLastCommitUrl: (lastCommitUrl) => set({ lastCommitUrl }),
  setNotesForTopic: (notesForTopic) => set({ notesForTopic }),
  resetForNewBatch: () =>
    set({
      candidates: [],
      selectedIdxs: new Set<number>(),
      drill: null,
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
