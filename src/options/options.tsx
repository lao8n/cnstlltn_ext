import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ulid } from "ulid";
import "@/index.css";
import logoUrl from "@/assets/logo.svg";
import {
  getSettings,
  setSettings,
  getRepoProfiles,
  setRepoProfiles,
} from "@/lib/storage";
import type { RepoProfile, Settings } from "@/lib/types";

type Status =
  | { kind: "idle" }
  | { kind: "ok"; msg: string }
  | { kind: "err"; msg: string };

function Options() {
  const [s, setS] = useState<Settings | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void getSettings().then(setS);
  }, []);

  if (!s) return <div className="p-6">Loading…</div>;

  const update = (patch: Partial<Settings>) => setS({ ...s, ...patch });

  const save = async () => {
    setBusy(true);
    try {
      await setSettings(s);
      setStatus({ kind: "ok", msg: "Saved." });
    } catch (err) {
      setStatus({ kind: "err", msg: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const sendAction = async (type: "TEST_CONNECTION" | "CREATE_REPO") => {
    setBusy(true);
    setStatus({ kind: "idle" });
    try {
      await setSettings(s);
      const result = (await chrome.runtime.sendMessage({ type })) as {
        ok: boolean;
        result?: { ok: boolean; message: string };
        error?: string;
      };
      if (result.ok && result.result?.ok) {
        setStatus({ kind: "ok", msg: result.result.message });
      } else {
        setStatus({
          kind: "err",
          msg: result.result?.message ?? result.error ?? "Unknown error",
        });
      }
    } catch (err) {
      setStatus({ kind: "err", msg: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-8 space-y-6">
      <header className="nt-animate-rise flex items-center gap-3">
        <img
          src={logoUrl}
          alt=""
          className="w-11 h-11 rounded-xl shadow-sm"
          draggable={false}
        />
        <div className="space-y-0.5">
          <h1 className="text-2xl font-semibold tracking-tight">
            cnstlltn settings
          </h1>
          <p className="text-sm opacity-70">
            BYOK — all keys stay in this browser's local storage. Nothing is
            sent anywhere except Google Gemini and GitHub directly.
          </p>
        </div>
      </header>

      <Section title="Gemini">
        <Field
          label="API key"
          hint="Get one at https://aistudio.google.com/apikey. Stored locally; used for note generation only."
        >
          <input
            type="password"
            value={s.geminiApiKey}
            onChange={(e) => update({ geminiApiKey: e.target.value })}
            placeholder="AIza…"
            className="nt-input"
            autoComplete="off"
          />
        </Field>
        <Field
          label="Model"
          hint="Flash is free and good for note generation. Pro is higher quality but requires billing enabled on your Google Cloud project."
        >
          <select
            value={s.model}
            onChange={(e) => update({ model: e.target.value })}
            className="nt-input"
          >
            <option value="gemini-2.5-flash">
              gemini-2.5-flash (free tier — recommended)
            </option>
            <option value="gemini-2.5-flash-lite">
              gemini-2.5-flash-lite (free tier — fastest, shorter notes)
            </option>
            <option value="gemini-2.5-pro">
              gemini-2.5-pro (paid — needs billing)
            </option>
          </select>
        </Field>
      </Section>

      <Section title="GitHub repo">
        <Field
          label="Fine-grained PAT"
          hint="Permissions: Contents read/write + Metadata read on this one repo."
        >
          <input
            type="password"
            value={s.githubToken}
            onChange={(e) => update({ githubToken: e.target.value })}
            placeholder="github_pat_…"
            className="nt-input"
            autoComplete="off"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Owner">
            <input
              type="text"
              value={s.githubOwner}
              onChange={(e) => update({ githubOwner: e.target.value })}
              placeholder="your-username"
              className="nt-input"
            />
          </Field>
          <Field label="Repo">
            <input
              type="text"
              value={s.githubRepo}
              onChange={(e) => update({ githubRepo: e.target.value })}
              placeholder="my-notes"
              className="nt-input"
            />
          </Field>
        </div>
        <Field label="Branch">
          <input
            type="text"
            value={s.githubBranch}
            onChange={(e) => update({ githubBranch: e.target.value })}
            className="nt-input"
          />
        </Field>
      </Section>

      <RepoProfilesEditor />

      <div className="flex gap-3 items-center">
        <button disabled={busy} onClick={save} className="nt-btn nt-btn-primary">
          Save
        </button>
        <button
          disabled={busy}
          onClick={() => sendAction("TEST_CONNECTION")}
          className="nt-btn"
        >
          Test connection
        </button>
        <button
          disabled={busy}
          onClick={() => sendAction("CREATE_REPO")}
          className="nt-btn"
        >
          Create repo if missing
        </button>
      </div>

      {status.kind !== "idle" && (
        <div
          className={
            "nt-animate-pop text-sm rounded-lg px-3 py-2 " +
            (status.kind === "ok"
              ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-100"
              : "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-100")
          }
        >
          {status.msg}
        </div>
      )}

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
          padding: 8px 18px;
          border-radius: 9999px;
          border: 1px solid rgba(120,120,120,0.4);
          background: transparent;
          font-weight: 500;
          cursor: pointer;
          transition: background 0.15s, box-shadow 0.15s, border-color 0.15s,
            transform 0.08s;
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
      `}</style>
    </div>
  );
}

function RepoProfilesEditor() {
  const [profiles, setProfiles] = useState<RepoProfile[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    void getRepoProfiles().then(setProfiles);
  }, []);

  if (!profiles) return null;

  const update = (id: string, patch: Partial<RepoProfile>) =>
    setProfiles(profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const add = () =>
    setProfiles([
      ...profiles,
      { id: ulid(), name: "", owner: "", repo: "", branch: "main", token: "" },
    ]);
  const remove = (id: string) =>
    setProfiles(profiles.filter((p) => p.id !== id));
  const save = async () => {
    const cleaned = profiles
      .map((p) => ({ ...p, token: p.token?.trim() || undefined }))
      .filter((p) => p.owner.trim() && p.repo.trim());
    await setRepoProfiles(cleaned);
    setProfiles(cleaned);
    setStatus(
      `Saved ${cleaned.length} profile${cleaned.length === 1 ? "" : "s"}.`,
    );
  };

  return (
    <Section title="Additional repo profiles">
      <p className="text-sm opacity-70">
        Extra repos you can switch to from the side panel while writing (e.g. an
        agents-notes repo). Leave the token blank to reuse the default PAT above,
        or set a per-repo token if your fine-grained PAT only covers one repo.
      </p>
      {profiles.length === 0 && (
        <p className="text-sm opacity-60">No profiles yet.</p>
      )}
      {profiles.map((p) => (
        <div key={p.id} className="nt-animate-rise border rounded-lg p-3 space-y-2">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Label">
              <input
                className="nt-input"
                value={p.name}
                placeholder="agents_notes"
                onChange={(e) => update(p.id, { name: e.target.value })}
              />
            </Field>
            <Field label="Branch">
              <input
                className="nt-input"
                value={p.branch}
                onChange={(e) => update(p.id, { branch: e.target.value })}
              />
            </Field>
            <Field label="Owner">
              <input
                className="nt-input"
                value={p.owner}
                placeholder="your-username"
                onChange={(e) => update(p.id, { owner: e.target.value })}
              />
            </Field>
            <Field label="Repo">
              <input
                className="nt-input"
                value={p.repo}
                placeholder="agents_notes"
                onChange={(e) => update(p.id, { repo: e.target.value })}
              />
            </Field>
          </div>
          <Field
            label="Token (optional)"
            hint="Leave blank to reuse the default PAT above."
          >
            <input
              type="password"
              className="nt-input"
              value={p.token ?? ""}
              placeholder="github_pat_…"
              autoComplete="off"
              onChange={(e) => update(p.id, { token: e.target.value })}
            />
          </Field>
          <button className="nt-btn" onClick={() => remove(p.id)}>
            Remove
          </button>
        </div>
      ))}
      <div className="flex gap-3 items-center">
        <button className="nt-btn" onClick={add}>
          Add profile
        </button>
        <button className="nt-btn nt-btn-primary" onClick={save}>
          Save profiles
        </button>
        {status && <span className="text-sm opacity-70">{status}</span>}
      </div>
    </Section>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 border-t pt-5">
      <h2 className="font-medium text-lg">{title}</h2>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      {hint && <span className="block text-xs opacity-60">{hint}</span>}
      {children}
    </label>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<Options />);
