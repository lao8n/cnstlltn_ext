# cnstlltn

Chrome extension that turns YouTube videos into a personal, GitHub-backed
knowledge base.

On any YouTube watch page, hit the floating **📝 cnstlltn** button → the
extension pulls the transcript → Gemini generates a list of candidate
notes → you select the ones to keep (and optionally drill into individual
notes for more specific sub-notes) → they get committed straight to a
GitHub repo of your choice as Markdown files with rich YAML frontmatter.

This is v1 — the *input* side of the knowledge base. Consumption features
(chatbot, gap analysis, coverage dashboard, graph viz) come later. The
data model is designed to support them without restructuring.

## Stack

- Manifest V3 + side panel
- TypeScript, React, Tailwind, Zustand
- Vite + `@crxjs/vite-plugin`
- Google `@google/genai` SDK — Gemini, structured outputs via `responseSchema`
- Octokit (GitHub Contents API + Git data API for batched commits)

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

After making code changes, run `npm run build` again and click the
refresh icon on the extension card in `chrome://extensions`. Close +
reopen any YouTube tab — content scripts injected before the reload
become orphaned and need a fresh tab.

## Configure

Open the extension's options page (right-click the toolbar icon →
**Options**):

| Field | What |
|-------|------|
| Gemini API key | `AIza…` from <https://aistudio.google.com/apikey>. BYOK; stored in `chrome.storage.local`, never leaves your browser. |
| Model | Dropdown. Defaults to `gemini-2.5-flash` (free tier — recommended). `gemini-2.5-flash-lite` is the fastest free option. `gemini-2.5-pro` is higher quality but requires Google Cloud billing enabled. |
| GitHub PAT | A **fine-grained** personal access token scoped to your notes repo: `Contents: read/write` + `Metadata: read`. <https://github.com/settings/personal-access-tokens/new> |
| Owner / Repo | Your GitHub username and the repo name (any GitHub repo you have write access to — it can be empty; the extension will bootstrap it). |
| Branch | `main` by default. |

Click **Test connection** to verify GitHub access. If the repo doesn't
exist, **Create repo if missing** will create it as a private repo
(only works if the owner field matches your authenticated user).

## Use it

1. Open any YouTube video with English captions.
2. Click the **📝 cnstlltn** button (bottom-right of the page).
3. The side panel opens. The header shows the configured model so you
   always know what's about to be called.
4. **Topic**: pick an existing topic from the dropdown, or type a new
   topic title in the input below. Both are visible at once. If your
   new-topic title slugifies to an existing one, you get an amber
   warning telling you the notes will be added to the existing topic
   (your hand-curated `topic.md` is never overwritten).
5. Click **Generate notes from this video** — ~10–30s.
6. A list of candidate notes appears. Click any card to select it
   (selected = inverted colours). Click the small `›` chevron on a
   card to **drill into** that note: a deeper, more specific list
   replaces the current one, with a `← back` link to pop back up.
   Selections persist as you navigate.
   - The drill LLM call is constrained to the parent note's time
     window — sub-notes stay within `[parent.start, parent.end]`, and
     the transcript slice sent to the model is restricted to that
     window (cheaper, more focused).
7. Click **Commit N** — N is the total ticked count across every
   level of the drill stack. All ticked notes are committed in one
   atomic GitHub commit. Drilled-into-but-not-ticked ancestors are
   **not** committed (drilling is a navigation tool, not a save).
   Notes whose nearest ticked ancestor on the drill chain *is*
   committed get that ancestor recorded in their `parents:`
   frontmatter; otherwise `parents: []`.
8. On errors (rate limit, server overload, bad key), a one-line
   friendly message is shown with a **Retry** button that re-runs
   exactly what failed.

If the destination GitHub repo is empty (no commits yet), the first
commit is split: an initial `init: cnstlltn KB` commit creates
`.kbconfig.yaml` via the Contents API to bootstrap the default
branch, then the actual notes batch goes in via the normal git-data
API.

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

`topic.md` is created on first commit to a new topic and is never
overwritten afterwards — that's where you hand-curate
`main_arguments`, scope, key voices, etc. Transcripts are skipped on
recommit for the same video. Notes are ULID-keyed so they can never
collide.

Every note carries enough frontmatter (`id`, `topic`, `parents`,
`children`, `source.start_seconds`/`end_seconds`, `content_hash`,
`model`, `tags`, `claim_type`, `flag`) for v2+ features (chatbot
retrieval, gap analysis vs a new video, coverage dashboard) to slot
in without re-shaping the repo.

## Development

```bash
npm run dev         # vite dev with HMR; reload unpacked extension after changes
npm run build       # production build
npm run typecheck   # tsc --noEmit
```

The full plan and rationale live in
`~/.claude/plans/i-want-to-slowly-whimsical-lampson.md`.
