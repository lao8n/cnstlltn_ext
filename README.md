# Notetaker

Chrome extension companion to [cnstlltn](https://github.com/lao8n/cnstlltn) — turns YouTube videos into a personal, GitHub-backed knowledge base.

On any YouTube watch page, hit the floating **📝 Notetaker** button → the
extension pulls the transcript → OpenAI generates a list of candidate notes →
you tick the ones to keep → they get committed straight to a GitHub repo of
your choice as Markdown files with rich YAML frontmatter.

This is v1 — the *input* side of the knowledge base. Consumption features
(chatbot, gap analysis, coverage dashboard, graph viz) come later. The data
model is designed to support them without restructuring.

## Stack

- Manifest V3 + side panel
- TypeScript, React, Tailwind, Zustand
- Vite + `@crxjs/vite-plugin`
- Google `@google/genai` SDK — Gemini, structured outputs via `responseSchema`
- Octokit (GitHub git data API for batched commits)

## Build & install

```bash
npm install
npm run build      # outputs to ./dist
```

Then in Chrome:

1. Visit `chrome://extensions`.
2. Toggle on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `./dist` folder.
4. Pin the extension to the toolbar.

After making code changes, run `npm run build` again and click the refresh
icon on the extension card in `chrome://extensions`.

## Configure

Open the extension's options page (click the extension icon → ⋯ → Options,
or right-click the toolbar icon → Options):

| Field | What |
|-------|------|
| Gemini API key | `AIza…` from <https://aistudio.google.com/apikey>. BYOK; stored in `chrome.storage.local`, never leaves your browser. |
| Model | Defaults to `gemini-2.5-pro`. `gemini-2.5-flash` is cheaper/faster. |
| GitHub PAT | A **fine-grained** personal access token scoped to your notes repo: `Contents: read/write` + `Metadata: read`. <https://github.com/settings/personal-access-tokens/new> |
| Owner / Repo | Your GitHub username and the repo name. |
| Branch | `main` by default. |

Click **Test connection** to verify GitHub access. If the repo doesn't exist,
**Create repo if missing** will create it as a private repo (only works if the
owner field matches your authenticated user).

## Use it

1. Open any YouTube video with English captions.
2. Click the **📝 Notetaker** button (bottom-right of the page).
3. The side panel opens.
4. Pick an existing topic or create a new one (e.g. `iran-israel-war`).
5. Click **Generate notes from this video** — ~10–30 seconds.
6. Tick the candidate notes you want to keep.
7. Click **Commit N selected**. All selected notes (plus the transcript on
   first commit for that video, plus a `topic.md` stub if it's a new topic)
   land in your repo in a single commit.
8. To drill deeper on a note, pick it from the dropdown after committing and
   click **Drill into selected** — generates sub-notes from the same
   transcript. Commit those too; they get `parents: [<id>]` filled in.

## Repo layout the extension writes

```
your-repo/
├── .kbconfig.yaml
├── topics/
│   └── iran-israel-war/
│       ├── topic.md
│       ├── notes/
│       │   ├── 01HXYZ…-mearsheimer-iran-nuclear.md
│       │   └── 01HXYW…-us-credibility-cost.md
│       └── sources/
│           ├── yt-dQw4w9WgXcQ.md
│           └── transcripts/
│               └── yt-dQw4w9WgXcQ.vtt
```

Every note carries enough frontmatter (`id`, `topic`, `parents`, `children`,
`source.start_seconds`/`end_seconds`, `content_hash`, `model`, `tags`,
`claim_type`, `flag`) for v2+ features (chatbot retrieval, gap analysis vs a
new video, coverage dashboard) to slot in without re-shaping the repo.

## Development

```bash
npm run dev         # vite dev with HMR; reload unpacked extension after changes
npm run build       # production build
npm run typecheck   # tsc --noEmit
```

The full plan and rationale live in
`~/.claude/plans/i-want-to-slowly-whimsical-lampson.md`.
