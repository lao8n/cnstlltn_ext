import { Octokit } from "@octokit/rest";
import { getSettings } from "@/lib/storage";

export interface GitHubAuth {
  getOctokit(): Promise<Octokit>;
  getOwnerRepo(): Promise<{ owner: string; repo: string; branch: string }>;
}

export class PATAuth implements GitHubAuth {
  async getOctokit(): Promise<Octokit> {
    const { githubToken } = await getSettings();
    if (!githubToken) throw new Error("No GitHub token configured.");
    return new Octokit({
      auth: githubToken,
      userAgent: "notetaker/0.1.0",
    });
  }

  async getOwnerRepo(): Promise<{
    owner: string;
    repo: string;
    branch: string;
  }> {
    const { githubOwner, githubRepo, githubBranch } = await getSettings();
    if (!githubOwner || !githubRepo) {
      throw new Error("GitHub owner/repo not configured.");
    }
    return {
      owner: githubOwner,
      repo: githubRepo,
      branch: githubBranch || "main",
    };
  }
}

export const defaultAuth: GitHubAuth = new PATAuth();
