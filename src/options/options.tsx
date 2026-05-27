import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { getSettings, setSettings } from "@/lib/storage";
import type { Settings } from "@/lib/types";

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
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Notetaker settings</h1>
        <p className="text-sm opacity-70">
          BYOK — all keys stay in this browser's local storage. Nothing is sent
          to any server other than Google Gemini and GitHub directly.
        </p>
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
          hint="Defaults to gemini-2.5-pro. gemini-2.5-flash is cheaper/faster."
        >
          <input
            type="text"
            value={s.model}
            onChange={(e) => update({ model: e.target.value })}
            className="nt-input"
          />
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
            "text-sm rounded px-3 py-2 " +
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
          border-radius: 6px;
          background: transparent;
          font: inherit;
          color: inherit;
        }
        .nt-btn {
          padding: 8px 14px;
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
    </div>
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
