import type { Settings } from "./types";
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
