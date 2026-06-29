import type { RepoProfile, RepoTarget, Settings } from "./types";
import { DEFAULT_MODEL } from "./types";

const SETTINGS_KEY = "settings";

const DEFAULTS: Settings = {
  geminiApiKey: "",
  githubToken: "",
  githubOwner: "",
  githubRepo: "",
  githubBranch: "main",
  model: DEFAULT_MODEL,
};

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULTS, ...(stored[SETTINGS_KEY] ?? {}) };
}

export async function setSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await getSettings();
  const merged = { ...current, ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  return merged;
}

// --- Repo profiles -------------------------------------------------------
// Additional named repos beyond the default (Settings owner/repo). The active
// profile drives the GitHub client for ALL reads/writes; `null` = the default.

const REPO_PROFILES_KEY = "repoProfiles";
const ACTIVE_PROFILE_KEY = "activeRepoProfileId";

export async function getRepoProfiles(): Promise<RepoProfile[]> {
  const stored = await chrome.storage.local.get(REPO_PROFILES_KEY);
  return (stored[REPO_PROFILES_KEY] ?? []) as RepoProfile[];
}

export async function setRepoProfiles(profiles: RepoProfile[]): Promise<void> {
  await chrome.storage.local.set({ [REPO_PROFILES_KEY]: profiles });
}

export async function getActiveProfileId(): Promise<string | null> {
  const stored = await chrome.storage.local.get(ACTIVE_PROFILE_KEY);
  return (stored[ACTIVE_PROFILE_KEY] ?? null) as string | null;
}

export async function setActiveProfileId(id: string | null): Promise<void> {
  await chrome.storage.local.set({ [ACTIVE_PROFILE_KEY]: id });
}

// Resolve the repo the GitHub client should read/write right now. Falls back to
// the default repo (Settings) when no profile is active or the id is stale.
export async function getActiveRepoTarget(): Promise<RepoTarget> {
  const settings = await getSettings();
  const activeId = await getActiveProfileId();
  if (activeId) {
    const profile = (await getRepoProfiles()).find((p) => p.id === activeId);
    if (profile) {
      return {
        owner: profile.owner,
        repo: profile.repo,
        branch: profile.branch || "main",
        token: profile.token?.trim() || settings.githubToken,
      };
    }
  }
  return {
    owner: settings.githubOwner,
    repo: settings.githubRepo,
    branch: settings.githubBranch || "main",
    token: settings.githubToken,
  };
}

const SESSION_KEY = "session";

export async function setSession<T>(payload: T): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: payload });
}

export async function getSession<T>(): Promise<T | null> {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return (stored[SESSION_KEY] ?? null) as T | null;
}

export async function clearSession(): Promise<void> {
  await chrome.storage.session.remove(SESSION_KEY);
}
