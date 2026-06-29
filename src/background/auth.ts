import { Octokit } from "@octokit/rest";
import { getActiveRepoTarget } from "@/lib/storage";

export interface GitHubAuth {
  getOctokit(): Promise<Octokit>;
  getOwnerRepo(): Promise<{ owner: string; repo: string; branch: string }>;
}

// Reads the *active* repo target (default repo, or whichever profile the user
// picked in the side panel) fresh on every call — so switching profiles takes
// effect immediately for all GitHub reads/writes.
export class PATAuth implements GitHubAuth {
  async getOctokit(): Promise<Octokit> {
    const { token } = await getActiveRepoTarget();
    if (!token) throw new Error("No GitHub token configured.");
    return new Octokit({
      auth: token,
      userAgent: "notetaker/0.1.0",
    });
  }

  async getOwnerRepo(): Promise<{
    owner: string;
    repo: string;
    branch: string;
  }> {
    const { owner, repo, branch } = await getActiveRepoTarget();
    if (!owner || !repo) {
      throw new Error("GitHub owner/repo not configured.");
    }
    return { owner, repo, branch };
  }
}

export const defaultAuth: GitHubAuth = new PATAuth();
