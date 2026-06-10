import { defaultAuth, type GitHubAuth } from "./auth";
import { KB_PATHS, buildKbConfig, parseNote } from "@/lib/note";
import type { CommittedNoteRef, CommitResult } from "@/lib/types";

export interface FileToCommit {
  path: string;
  content: string;
  noteRef?: { id: string; title: string };
}

function isEmptyRepoError(err: unknown): boolean {
  const status =
    typeof err === "object" && err && "status" in err
      ? (err as { status: number }).status
      : 0;
  const message =
    typeof err === "object" && err && "message" in err
      ? String((err as { message: unknown }).message)
      : "";
  return status === 409 || /empty/i.test(message);
}

// UTF-8 → base64 (the GitHub Contents API requires base64 with UTF-8 input).
function utf8ToBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export class GitHubClient {
  constructor(private auth: GitHubAuth = defaultAuth) {}

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const octokit = await this.auth.getOctokit();
    const { owner, repo } = await this.auth.getOwnerRepo();
    try {
      const { data } = await octokit.rest.repos.get({ owner, repo });
      return { ok: true, message: `Connected to ${data.full_name}.` };
    } catch (err) {
      const status =
        typeof err === "object" && err && "status" in err
          ? (err as { status: number }).status
          : 0;
      if (status === 404) {
        return {
          ok: false,
          message: `Repo ${owner}/${repo} not found. You can create it.`,
        };
      }
      return {
        ok: false,
        message: `GitHub error: ${(err as Error).message}`,
      };
    }
  }

  async createRepoIfMissing(): Promise<{ ok: boolean; message: string }> {
    const octokit = await this.auth.getOctokit();
    const { owner, repo, branch } = await this.auth.getOwnerRepo();
    try {
      await octokit.rest.repos.get({ owner, repo });
      return { ok: true, message: "Repo already exists." };
    } catch (err) {
      const status =
        typeof err === "object" && err && "status" in err
          ? (err as { status: number }).status
          : 0;
      if (status !== 404) {
        return { ok: false, message: `Could not check repo: ${(err as Error).message}` };
      }
    }
    const { data: user } = await octokit.rest.users.getAuthenticated();
    if (user.login !== owner) {
      return {
        ok: false,
        message: `Cannot create repo on behalf of "${owner}" — authenticated as "${user.login}". Create the repo manually or update the owner.`,
      };
    }
    await octokit.rest.repos.createForAuthenticatedUser({
      name: repo,
      private: true,
      auto_init: true,
      default_branch: branch,
    });
    return { ok: true, message: `Created ${owner}/${repo}.` };
  }

  async pathExists(path: string): Promise<boolean> {
    const octokit = await this.auth.getOctokit();
    const { owner, repo, branch } = await this.auth.getOwnerRepo();
    try {
      await octokit.rest.repos.getContent({
        owner,
        repo,
        path,
        ref: branch,
      });
      return true;
    } catch (err) {
      const status =
        typeof err === "object" && err && "status" in err
          ? (err as { status: number }).status
          : 0;
      if (status === 404) return false;
      throw err;
    }
  }

  async listTopics(): Promise<string[]> {
    const octokit = await this.auth.getOctokit();
    const { owner, repo, branch } = await this.auth.getOwnerRepo();
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: "topics",
        ref: branch,
      });
      if (!Array.isArray(data)) return [];
      return data.filter((d) => d.type === "dir").map((d) => d.name).sort();
    } catch (err) {
      const status =
        typeof err === "object" && err && "status" in err
          ? (err as { status: number }).status
          : 0;
      if (status === 404) return [];
      throw err;
    }
  }

  async listNotesForTopic(
    topic: string,
  ): Promise<{ id: string; title: string; path: string }[]> {
    const octokit = await this.auth.getOctokit();
    const { owner, repo, branch } = await this.auth.getOwnerRepo();
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: KB_PATHS.notesDir(topic),
        ref: branch,
      });
      if (!Array.isArray(data)) return [];
      const files = data.filter(
        (d) => d.type === "file" && d.name.endsWith(".md"),
      );
      const results = await Promise.all(
        files.map(async (f) => {
          try {
            const { data: fileData } = await octokit.rest.repos.getContent({
              owner,
              repo,
              path: f.path,
              ref: branch,
            });
            if (Array.isArray(fileData) || fileData.type !== "file") return null;
            const content = atob(fileData.content.replace(/\n/g, ""));
            const parsed = parseNote(content);
            if (!parsed) return null;
            return {
              id: parsed.frontmatter.id,
              title: parsed.frontmatter.title,
              path: f.path,
            };
          } catch {
            return null;
          }
        }),
      );
      return results.filter((r): r is NonNullable<typeof r> => r !== null);
    } catch (err) {
      const status =
        typeof err === "object" && err && "status" in err
          ? (err as { status: number }).status
          : 0;
      if (status === 404) return [];
      throw err;
    }
  }

  async commitFiles(args: {
    files: FileToCommit[];
    message: string;
  }): Promise<CommitResult> {
    if (args.files.length === 0) {
      throw new Error("commitFiles called with no files.");
    }
    const octokit = await this.auth.getOctokit();
    const { owner, repo, branch } = await this.auth.getOwnerRepo();

    // Empty-repo detection. GitHub blocks the entire git/* API on empty
    // repos (createBlob 409 too, not just getRef). So if the repo is empty
    // we bootstrap it with one commit via the Contents API — which DOES
    // work on empty repos and initializes the default branch — and then
    // fall through to the normal batched git-data-API path.
    let baseSha: string | null = null;
    let baseTreeSha: string | null = null;
    try {
      const refResp = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      baseSha = refResp.data.object.sha;
      const baseCommit = await octokit.rest.git.getCommit({
        owner,
        repo,
        commit_sha: baseSha,
      });
      baseTreeSha = baseCommit.data.tree.sha;
    } catch (err) {
      if (!isEmptyRepoError(err)) throw err;
      // Bootstrap: create one file (.kbconfig.yaml) via the Contents API.
      // This is the only API path that works on a truly empty repo. After
      // this lands, the repo has one commit and the default branch exists.
      const bootstrapResp = await octokit.rest.repos.createOrUpdateFileContents({
        owner,
        repo,
        branch,
        path: KB_PATHS.config(),
        message: "init: cnstlltn KB",
        content: utf8ToBase64(buildKbConfig()),
      });
      // Take the bootstrap commit as our base.
      const newCommitSha = bootstrapResp.data.commit.sha;
      if (!newCommitSha) {
        throw new Error("Bootstrap commit returned no sha");
      }
      baseSha = newCommitSha;
      const baseCommit = await octokit.rest.git.getCommit({
        owner,
        repo,
        commit_sha: baseSha,
      });
      baseTreeSha = baseCommit.data.tree.sha;
      // We already wrote .kbconfig.yaml above; drop it from the upcoming batch
      // so we don't pointlessly include it in the second commit's tree.
      args.files = args.files.filter((f) => f.path !== KB_PATHS.config());
      if (args.files.length === 0) {
        // Bootstrap-only commit (no notes selected somehow). Return it.
        return {
          sha: baseSha,
          url: `https://github.com/${owner}/${repo}/commit/${baseSha}`,
          noteRefs: [],
        };
      }
    }

    const blobs = await Promise.all(
      args.files.map(async (file) => {
        const blob = await octokit.rest.git.createBlob({
          owner,
          repo,
          content: file.content,
          encoding: "utf-8",
        });
        return {
          path: file.path,
          mode: "100644" as const,
          type: "blob" as const,
          sha: blob.data.sha,
        };
      }),
    );

    const tree = await octokit.rest.git.createTree({
      owner,
      repo,
      base_tree: baseTreeSha!,
      tree: blobs,
    });

    const commit = await octokit.rest.git.createCommit({
      owner,
      repo,
      message: args.message,
      tree: tree.data.sha,
      parents: [baseSha!],
    });

    await octokit.rest.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: commit.data.sha,
    });

    const noteRefs: CommittedNoteRef[] = args.files
      .filter((f) => f.noteRef)
      .map((f) => ({
        id: f.noteRef!.id,
        title: f.noteRef!.title,
        path: f.path,
      }));

    return {
      sha: commit.data.sha,
      url: `https://github.com/${owner}/${repo}/commit/${commit.data.sha}`,
      noteRefs,
    };
  }

  async ensureKbConfig(): Promise<FileToCommit | null> {
    if (await this.pathExists(KB_PATHS.config())) return null;
    return {
      path: KB_PATHS.config(),
      content: buildKbConfig(),
    };
  }
}

export const github = new GitHubClient();
