type ApiRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  on?: (event: string, callback: (chunk?: unknown) => void) => void;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
  setHeader?: (name: string, value: string) => void;
  end?: () => void;
};

type SyncProject = {
  id: string;
  title?: string;
  params?: {
    projectType?: string;
    genres?: string[];
    tone?: string;
  };
  generalSummary?: string;
  volumes?: Array<{
    title?: string;
    chapters?: Array<{
      index?: number;
      title?: string;
      content?: string;
      summary?: string;
    }>;
  }>;
  createdAt?: number;
  updatedAt?: number;
  lastChapterWritten?: number;
};

type SyncBody = {
  projects?: SyncProject[];
};

type GitHubFile = {
  path: string;
  content: string;
};

const GITHUB_API = "https://api.github.com";

const json = (res: ApiResponse, status: number, payload: unknown) => {
  res.status(status).json(payload);
};

const readEnv = (name: string, fallback = "") => (process.env[name] || fallback).trim();

const syncConfig = () => ({
  token: readEnv("GITHUB_SYNC_TOKEN") || readEnv("GITHUB_TOKEN"),
  repo: readEnv("GITHUB_SYNC_REPO"),
  branch: readEnv("GITHUB_SYNC_BRANCH", "main"),
  rootPath: normalizePath(readEnv("GITHUB_SYNC_PATH", "but-nghien-sync")),
});

const normalizePath = (value: string) =>
  value
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");

const encodeRefPath = (value: string) => value.split("/").map(encodeURIComponent).join("/");

const safeSlug = (value: string, fallback: string) => {
  const ascii = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return ascii || fallback;
};

const getAllChapters = (project: SyncProject) =>
  (project.volumes || [])
    .flatMap(volume => volume.chapters || [])
    .filter(chapter => chapter.content)
    .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));

const buildManuscriptText = (project: SyncProject) => {
  const chapters = getAllChapters(project);
  const header = [
    project.title || "Tac pham chua dat ten",
    "",
    `The loai: ${(project.params?.genres || []).join(", ") || "Chua cau hinh"}`,
    `Tong giong: ${project.params?.tone || "Chua cau hinh"}`,
    `So chuong da viet: ${chapters.length}`,
    "",
    "DAI CUC",
    project.generalSummary || "",
    "",
    "BAN THAO",
    "",
  ].join("\n");

  const body = chapters
    .map(chapter => `Chuong ${chapter.index || ""}: ${chapter.title || "Chua dat ten"}\n\n${chapter.content || ""}`)
    .join("\n\n---\n\n");

  return `${header}${body}`.trim();
};

const buildIndex = (projects: SyncProject[]) => ({
  syncedAt: new Date().toISOString(),
  app: "But Nghien AI",
  projects: projects.map(project => ({
    id: project.id,
    title: project.title || "Tac pham chua dat ten",
    projectType: project.params?.projectType || "",
    genres: project.params?.genres || [],
    chapterCount: getAllChapters(project).length,
    lastChapterWritten: project.lastChapterWritten || 0,
    createdAt: project.createdAt || null,
    updatedAt: project.updatedAt || null,
  })),
});

const buildFiles = (projects: SyncProject[], rootPath: string): GitHubFile[] => {
  const base = rootPath ? `${rootPath}/` : "";
  const files: GitHubFile[] = [
    {
      path: `${base}index.json`,
      content: JSON.stringify(buildIndex(projects), null, 2),
    },
  ];

  for (const project of projects) {
    const slug = safeSlug(project.title || project.id, "story");
    const id = safeSlug(project.id, "project");
    const filename = `${slug}-${id}`;
    files.push({
      path: `${base}projects/${filename}.json`,
      content: JSON.stringify(project, null, 2),
    });

    if (getAllChapters(project).length > 0) {
      files.push({
        path: `${base}manuscripts/${filename}.txt`,
        content: buildManuscriptText(project),
      });
    }
  }

  return files;
};

const parseBody = async (req: ApiRequest): Promise<SyncBody> => {
  if (req.body) {
    if (req.body instanceof Uint8Array) {
      return JSON.parse(Buffer.from(req.body).toString("utf8"));
    }
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body as SyncBody;
  }

  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on?.("data", chunk => {
      raw += typeof chunk === "string" ? chunk : Buffer.from(chunk as ArrayBuffer).toString("utf8");
    });
    req.on?.("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on?.("error", reject);
  });
};

const githubRequest = async <T,>(
  repo: string,
  token: string,
  path: string,
  options: RequestInit = {},
): Promise<T> => {
  const response = await fetch(`${GITHUB_API}/repos/${repo}/${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "but-nghien-ai-sync",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      message = body?.message || message;
    } catch {
      try {
        message = await response.text();
      } catch {
        // Keep status text.
      }
    }
    throw new Error(`GitHub ${response.status}: ${message}`);
  }

  return await response.json() as T;
};

const commitFiles = async (projects: SyncProject[]) => {
  const config = syncConfig();
  if (!config.token) {
    throw new Error("Thieu GITHUB_SYNC_TOKEN trong Vercel Environment Variables.");
  }
  if (!config.repo || !/^[^/\s]+\/[^/\s]+$/.test(config.repo)) {
    throw new Error("GITHUB_SYNC_REPO phai co dang owner/repository.");
  }

  const branchPath = encodeRefPath(config.branch);
  const files = buildFiles(projects, config.rootPath);
  const ref = await githubRequest<{ object: { sha: string } }>(
    config.repo,
    config.token,
    `git/ref/heads/${branchPath}`,
  );
  const baseCommit = await githubRequest<{ tree: { sha: string } }>(
    config.repo,
    config.token,
    `git/commits/${ref.object.sha}`,
  );
  const tree = await githubRequest<{ sha: string }>(config.repo, config.token, "git/trees", {
    method: "POST",
    body: JSON.stringify({
      base_tree: baseCommit.tree.sha,
      tree: files.map(file => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        content: file.content,
      })),
    }),
  });
  const commit = await githubRequest<{ sha: string; html_url: string }>(config.repo, config.token, "git/commits", {
    method: "POST",
    body: JSON.stringify({
      message: `chore: sync But Nghien projects (${new Date().toISOString()})`,
      tree: tree.sha,
      parents: [ref.object.sha],
    }),
  });

  await githubRequest(config.repo, config.token, `git/refs/heads/${branchPath}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });

  return {
    repo: config.repo,
    branch: config.branch,
    rootPath: config.rootPath,
    files: files.map(file => file.path),
    commitSha: commit.sha,
    commitUrl: commit.html_url,
  };
};

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader?.("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end?.();
    return;
  }

  if (req.method === "GET") {
    const config = syncConfig();
    json(res, 200, {
      configured: Boolean(config.token && config.repo),
      repo: config.repo,
      branch: config.branch,
      rootPath: config.rootPath,
    });
    return;
  }

  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" });
    return;
  }

  try {
    const body = await parseBody(req);
    const projects = Array.isArray(body.projects) ? body.projects.filter(project => project?.id) : [];
    if (projects.length === 0) {
      json(res, 400, { error: "Khong co tac pham hop le de dong bo." });
      return;
    }

    const result = await commitFiles(projects);
    json(res, 200, { ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Khong dong bo duoc GitHub.";
    json(res, 500, { ok: false, error: message });
  }
}
