import { StoryProject } from "../types";

type FirebaseSession = {
  idToken: string;
  refreshToken: string;
  localId: string;
  expiresAt: number;
  email?: string;
};

export type FirebaseAuthUser = {
  uid: string;
  email: string;
};

type FirestoreValue = {
  stringValue?: string;
  integerValue?: string;
  timestampValue?: string;
};

type FirestoreDocument = {
  name?: string;
  fields?: Record<string, FirestoreValue>;
};

const FIRESTORE_API = "https://firestore.googleapis.com/v1";
const AUTH_API = "https://identitytoolkit.googleapis.com/v1";
const TOKEN_API = "https://securetoken.googleapis.com/v1";
const CHUNK_SIZE = 180_000;

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || process.env.VITE_FIREBASE_API_KEY || "",
  projectId: process.env.FIREBASE_PROJECT_ID || process.env.VITE_FIREBASE_PROJECT_ID || "",
  authDomain: process.env.FIREBASE_AUTH_DOMAIN || process.env.VITE_FIREBASE_AUTH_DOMAIN || "",
  appId: process.env.FIREBASE_APP_ID || process.env.VITE_FIREBASE_APP_ID || "",
  databaseId: process.env.FIREBASE_DATABASE_ID || process.env.VITE_FIREBASE_DATABASE_ID || "(default)",
};

const sessionStorageKey = () => `but-nghien-firebase-session:${firebaseConfig.projectId}`;

let refreshInFlight: Promise<FirebaseSession> | null = null;

export const isFirebaseConfigured = () => Boolean(firebaseConfig.apiKey && firebaseConfig.projectId);

export const getFirebaseProjectId = () => firebaseConfig.projectId;

const requireFirebaseConfig = () => {
  if (!isFirebaseConfigured()) {
    throw new Error("Chưa cấu hình FIREBASE_API_KEY và FIREBASE_PROJECT_ID.");
  }
};

const parseSession = (): FirebaseSession | null => {
  try {
    const raw = localStorage.getItem(sessionStorageKey());
    return raw ? JSON.parse(raw) as FirebaseSession : null;
  } catch {
    return null;
  }
};

const saveSession = (session: FirebaseSession) => {
  localStorage.setItem(sessionStorageKey(), JSON.stringify(session));
};

export const getStoredFirebaseUser = (): FirebaseAuthUser | null => {
  const session = parseSession();
  if (!session?.localId || !session.email) return null;
  return { uid: session.localId, email: session.email };
};

export const signOutFromFirebase = () => {
  localStorage.removeItem(sessionStorageKey());
};

const authPost = async <T,>(url: string, body: BodyInit, contentType = "application/json"): Promise<T> => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error?.message || `Firebase Auth lỗi ${response.status}.`);
  }

  return await response.json() as T;
};

const refreshSession = async (refreshToken: string, email = ""): Promise<FirebaseSession> => {
  type RefreshResponse = {
    id_token: string;
    refresh_token: string;
    user_id: string;
    expires_in: string;
  };

  const data = await authPost<RefreshResponse>(
    `${TOKEN_API}/token?key=${firebaseConfig.apiKey}`,
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    "application/x-www-form-urlencoded",
  );

  const session = {
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    localId: data.user_id,
    email,
    expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
  };
  saveSession(session);
  return session;
};

export const signInToFirebase = async (email: string, password: string): Promise<FirebaseAuthUser> => {
  requireFirebaseConfig();
  type SignInResponse = {
    idToken: string;
    refreshToken: string;
    localId: string;
    expiresIn: string;
    email: string;
  };

  const data = await authPost<SignInResponse>(
    `${AUTH_API}/accounts:signInWithPassword?key=${firebaseConfig.apiKey}`,
    JSON.stringify({ email, password, returnSecureToken: true }),
  );

  const session = {
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    localId: data.localId,
    email: data.email || email,
    expiresAt: Date.now() + (Number(data.expiresIn) || 3600) * 1000,
  };
  saveSession(session);
  return { uid: session.localId, email: session.email };
};

const getSession = async () => {
  requireFirebaseConfig();
  const existing = parseSession();
  if (!existing?.email) {
    throw new Error("Chưa đăng nhập Firebase.");
  }
  if (existing?.idToken && existing.expiresAt > Date.now() + 90_000) return existing;
  if (existing?.refreshToken) {
    try {
      // Single-flight: nhieu loi goi dong thoi chi refresh mot lan, tranh Firebase
      // xoay refresh token lam cac loi goi sau bi INVALID_REFRESH_TOKEN va xoa session oan.
      if (!refreshInFlight) {
        refreshInFlight = refreshSession(existing.refreshToken, existing.email)
          .finally(() => { refreshInFlight = null; });
      }
      return await refreshInFlight;
    } catch {
      localStorage.removeItem(sessionStorageKey());
    }
  }
  throw new Error("Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.");
};

export const getFirebaseIdToken = async (): Promise<string> => {
  try {
    const session = await getSession();
    return session.idToken || "";
  } catch {
    return "";
  }
};

const mapPool = async <T,>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> => {
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
};

const databaseRoot = () =>
  `${FIRESTORE_API}/projects/${encodeURIComponent(firebaseConfig.projectId)}/databases/${encodeURIComponent(firebaseConfig.databaseId)}/documents`;

const encodeDocumentPath = (path: string) => path.split("/").map(encodeURIComponent).join("/");

const documentUrl = (path: string) => `${databaseRoot()}/${encodeDocumentPath(path)}`;

const collectionUrl = (path: string) => `${databaseRoot()}/${encodeDocumentPath(path)}`;

const firestoreFetch = async <T,>(pathOrUrl: string, init: RequestInit = {}): Promise<T | null> => {
  const session = await getSession();
  const url = pathOrUrl.startsWith("https://")
    ? pathOrUrl
    : pathOrUrl.startsWith("projects/")
      ? `${FIRESTORE_API}/${pathOrUrl}`
      : documentUrl(pathOrUrl);
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${session.idToken}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error?.error?.message || `Firestore lỗi ${response.status}.`);
  }
  if (response.status === 204) return null;

  return await response.json() as T;
};

const stringField = (value: unknown): FirestoreValue => ({ stringValue: String(value ?? "") });
const integerField = (value: unknown): FirestoreValue => ({ integerValue: String(Math.trunc(Number(value) || 0)) });
const timestampField = (value: unknown): FirestoreValue => {
  const time = Number(value) || Date.now();
  return { timestampValue: new Date(time).toISOString() };
};

const readString = (doc: FirestoreDocument | null, key: string, fallback = "") =>
  doc?.fields?.[key]?.stringValue || fallback;

const readInteger = (doc: FirestoreDocument | null, key: string, fallback = 0) =>
  Number(doc?.fields?.[key]?.integerValue || fallback);

const chunkText = (text: string) => {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += CHUNK_SIZE) {
    chunks.push(text.slice(index, index + CHUNK_SIZE));
  }
  return chunks.length ? chunks : [""];
};

const projectBasePath = async (projectId: string) => {
  const session = await getSession();
  return `users/${session.localId}/projects/${projectId}`;
};

export const saveProjectToFirebase = async (project: StoryProject): Promise<void> => {
  requireFirebaseConfig();
  const basePath = await projectBasePath(project.id);
  const payload = JSON.stringify(project);
  const chunks = chunkText(payload);
  const updatedAt = Date.now();
  // saveId gan ca meta lan tung chunk cua MOT luot luu: hai thiet bi luu cung luc co the ghi
  // chunk xen ke (saveChain chi noi tiep trong mot thiet bi). Khi nap, bo chunk khong cung
  // saveId voi meta se bi tu choi thay vi ghep thanh payload lai lam hong JSON.
  const saveId = `${updatedAt}-${Math.random().toString(36).slice(2, 10)}`;

  // Doc chunkCount cu de don chunk thua khi project ngan lai (tranh rac Firestore).
  let previousChunkCount = 0;
  try {
    const existing = await firestoreFetch<FirestoreDocument>(basePath);
    previousChunkCount = readInteger(existing, "chunkCount", 0);
  } catch { /* chua co doc cu thi bo qua */ }

  await mapPool(chunks, 6, async (chunk, index) => {
    await firestoreFetch(`${basePath}/chunks/${String(index).padStart(4, "0")}`, {
      method: "PATCH",
      body: JSON.stringify({
        fields: {
          index: integerField(index),
          content: stringField(chunk),
          saveId: stringField(saveId),
          updatedAt: timestampField(updatedAt),
        },
      }),
    });
  });

  await firestoreFetch(basePath, {
    method: "PATCH",
    body: JSON.stringify({
      fields: {
        id: stringField(project.id),
        title: stringField(project.title || "Tác phẩm chưa đặt tên"),
        projectType: stringField(project.params?.projectType || ""),
        genres: stringField((project.params?.genres || []).join(", ")),
        generalSummary: stringField((project.generalSummary || "").slice(0, 1200)),
        chunkCount: integerField(chunks.length),
        saveId: stringField(saveId),
        lastChapterWritten: integerField(project.lastChapterWritten || 0),
        createdAtMs: integerField(project.createdAt || updatedAt),
        updatedAtMs: integerField(updatedAt),
        createdAt: timestampField(project.createdAt || updatedAt),
        updatedAt: timestampField(updatedAt),
      },
    }),
  });

  if (previousChunkCount > chunks.length) {
    const staleIndexes = Array.from({ length: previousChunkCount - chunks.length }, (_, i) => chunks.length + i);
    await mapPool(staleIndexes, 6, async (index) => {
      await firestoreFetch(`${basePath}/chunks/${String(index).padStart(4, "0")}`, { method: "DELETE" }).catch(() => null);
    });
  }
};

const saveProjectsInternal = async (projects: StoryProject[]): Promise<void> => {
  if (!isFirebaseConfigured()) return;
  for (const project of projects) {
    await saveProjectToFirebase(project);
  }
};

let saveChain: Promise<void> = Promise.resolve();
export const saveProjectsToFirebase = async (projects: StoryProject[]): Promise<void> => {
  // Noi tiep moi luot luu cloud: hai luot luu chong nhau tung gay tinh trang chunk
  // cua hai phien ban bi tron vao nhau lam hong payload JSON cua project.
  const run = saveChain.then(() => saveProjectsInternal(projects));
  saveChain = run.catch(() => undefined);
  return run;
};

const loadProjectPayload = async (projectDoc: FirestoreDocument): Promise<StoryProject | null> => {
  const id = readString(projectDoc, "id");
  const chunkCount = readInteger(projectDoc, "chunkCount", 0);
  if (!id || chunkCount <= 0) return null;

  const metaSaveId = readString(projectDoc, "saveId");
  const basePath = await projectBasePath(id);
  const parts: string[] = new Array(chunkCount).fill("");
  let mixedChunks = false;
  await mapPool(Array.from({ length: chunkCount }, (_, i) => i), 6, async (index) => {
    const chunkDoc = await firestoreFetch<FirestoreDocument>(`${basePath}/chunks/${String(index).padStart(4, "0")}`);
    parts[index] = readString(chunkDoc, "content");
    // Doc cu (truoc khi co saveId) khong co truong nay ca meta lan chunk — chi doi chieu khi
    // meta CO saveId. Chunk lech saveId = bo chunk bi tron hai luot luu -> tu choi nap.
    if (metaSaveId && readString(chunkDoc, "saveId") !== metaSaveId) mixedChunks = true;
  });
  if (mixedChunks) {
    throw new Error("Chunk của tác phẩm thuộc nhiều lượt lưu khác nhau (nghi trộn chunk giữa hai thiết bị) — giữ bản local, không nạp bản lai.");
  }

  const payload = parts.join("");
  return payload ? JSON.parse(payload) as StoryProject : null;
};

export const loadProjectsFromFirebase = async (): Promise<StoryProject[]> =>
  (await loadProjectsFromFirebaseDetailed()).projects;

export const loadProjectsFromFirebaseDetailed = async (): Promise<{ projects: StoryProject[]; failed: number }> => {
  if (!isFirebaseConfigured()) return { projects: [], failed: 0 };
  const session = await getSession();
  const docs: FirestoreDocument[] = [];
  let pageToken = "";

  do {
    const url = `${collectionUrl(`users/${session.localId}/projects`)}?pageSize=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const data = await firestoreFetch<{ documents?: FirestoreDocument[]; nextPageToken?: string }>(url);
    docs.push(...(data?.documents || []));
    pageToken = data?.nextPageToken || "";
  } while (pageToken);

  const projects: StoryProject[] = [];
  let failed = 0;

  for (const doc of docs) {
    try {
      const project = await loadProjectPayload(doc);
      if (project) projects.push(project);
      else failed++;
    } catch (error) {
      failed++;
      console.warn("Không tải được một tác phẩm từ Firebase:", error);
    }
  }

  return { projects: projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)), failed };
};

export const deleteProjectFromFirebase = async (projectId: string): Promise<void> => {
  if (!isFirebaseConfigured()) return;
  const basePath = await projectBasePath(projectId);
  // Xoa meta truoc de project khong nap lai duoc nua, roi don chunk theo pagination day du.
  await firestoreFetch(basePath, { method: "DELETE" }).catch(() => null);
  let pageToken = "";
  do {
    const chunksUrl = `${collectionUrl(`${basePath}/chunks`)}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const chunks = await firestoreFetch<{ documents?: FirestoreDocument[]; nextPageToken?: string }>(chunksUrl);
    const docs = chunks?.documents || [];
    await mapPool(docs, 6, async (doc) => {
      if (doc.name) {
        await firestoreFetch(doc.name, { method: "DELETE" }).catch(() => null);
      }
    });
    pageToken = chunks?.nextPageToken || "";
  } while (pageToken);
};

// ===== Tombstone xoa du an tren cloud =====
// Luu o users/{uid}/meta/tombstones (firestore.rules owner-only bao phu duong nay) de moi
// thiet bi cung thay mot lan xoa, thay vi tombstone chi song trong RAM cua phien da xoa.
const tombstonesPath = async () => {
  const session = await getSession();
  return `users/${session.localId}/meta/tombstones`;
};

const TOMBSTONE_CLOUD_TTL_MS = 30 * 24 * 3600 * 1000;

const pruneCloudTombstones = (map: Record<string, number>): Record<string, number> => {
  const cutoff = Date.now() - TOMBSTONE_CLOUD_TTL_MS;
  const next: Record<string, number> = {};
  Object.entries(map || {}).forEach(([id, ts]) => {
    const time = Number(ts) || 0;
    if (id && time >= cutoff) next[id] = time;
  });
  return next;
};

export const loadDeletedProjectIdsFromFirebase = async (): Promise<Record<string, number>> => {
  if (!isFirebaseConfigured()) return {};
  const doc = await firestoreFetch<FirestoreDocument>(await tombstonesPath());
  if (!doc) return {};
  try {
    const parsed = JSON.parse(readString(doc, "deletedJson", "{}") || "{}");
    return pruneCloudTombstones(parsed && typeof parsed === "object" ? parsed : {});
  } catch {
    return {};
  }
};

const writeCloudTombstones = async (map: Record<string, number>): Promise<void> => {
  await firestoreFetch(await tombstonesPath(), {
    method: "PATCH",
    body: JSON.stringify({
      fields: {
        deletedJson: stringField(JSON.stringify(pruneCloudTombstones(map))),
        updatedAt: timestampField(Date.now()),
      },
    }),
  });
};

export const recordDeletedProjectOnFirebase = async (projectId: string): Promise<void> => {
  if (!isFirebaseConfigured()) return;
  const existing = await loadDeletedProjectIdsFromFirebase().catch(() => ({} as Record<string, number>));
  existing[projectId] = Date.now();
  await writeCloudTombstones(existing);
};

export const clearDeletedProjectOnFirebase = async (projectId: string): Promise<void> => {
  if (!isFirebaseConfigured()) return;
  const existing = await loadDeletedProjectIdsFromFirebase().catch(() => ({} as Record<string, number>));
  if (!existing[projectId]) return;
  delete existing[projectId];
  await writeCloudTombstones(existing);
};
