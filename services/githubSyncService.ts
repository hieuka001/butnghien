import { StoryProject } from "../types";

export type GitHubSyncResult = {
  ok: boolean;
  repo: string;
  branch: string;
  rootPath: string;
  files: string[];
  commitSha: string;
  commitUrl: string;
};

const readJson = async (response: Response) => {
  const text = await response.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      response.status === 404
        ? "Chua co API dong bo GitHub. Hay chay tren Vercel hoac dung vercel dev."
        : text.slice(0, 300),
    );
  }
};

export const syncProjectsToGitHub = async (projects: StoryProject[]): Promise<GitHubSyncResult> => {
  const response = await fetch("/api/github-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projects }),
  });
  const data = await readJson(response) as Partial<GitHubSyncResult> & { error?: string };

  if (!response.ok || !data.ok) {
    throw new Error(data.error || `Dong bo GitHub that bai (${response.status}).`);
  }

  return data as GitHubSyncResult;
};
