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
      return await refreshSession(existing.refreshToken, existing.email);
    } catch {
      localStorage.removeItem(sessionStorageKey());
    }
  }
  throw new Error("Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.");
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

  for (let index = 0; index < chunks.length; index++) {
    await firestoreFetch(`${basePath}/chunks/${String(index).padStart(4, "0")}`, {
      method: "PATCH",
      body: JSON.stringify({
        fields: {
          index: integerField(index),
          content: stringField(chunks[index]),
          updatedAt: timestampField(updatedAt),
        },
      }),
    });
  }

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
        lastChapterWritten: integerField(project.lastChapterWritten || 0),
        createdAtMs: integerField(project.createdAt || updatedAt),
        updatedAtMs: integerField(updatedAt),
        createdAt: timestampField(project.createdAt || updatedAt),
        updatedAt: timestampField(updatedAt),
      },
    }),
  });
};

export const saveProjectsToFirebase = async (projects: StoryProject[]): Promise<void> => {
  if (!isFirebaseConfigured()) return;
  for (const project of projects) {
    await saveProjectToFirebase(project);
  }
};

const loadProjectPayload = async (projectDoc: FirestoreDocument): Promise<StoryProject | null> => {
  const id = readString(projectDoc, "id");
  const chunkCount = readInteger(projectDoc, "chunkCount", 0);
  if (!id || chunkCount <= 0) return null;

  const basePath = await projectBasePath(id);
  const parts: string[] = [];
  for (let index = 0; index < chunkCount; index++) {
    const chunkDoc = await firestoreFetch<FirestoreDocument>(`${basePath}/chunks/${String(index).padStart(4, "0")}`);
    parts.push(readString(chunkDoc, "content"));
  }

  const payload = parts.join("");
  return payload ? JSON.parse(payload) as StoryProject : null;
};

export const loadProjectsFromFirebase = async (): Promise<StoryProject[]> => {
  if (!isFirebaseConfigured()) return [];
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

  for (const doc of docs) {
    try {
      const project = await loadProjectPayload(doc);
      if (project) projects.push(project);
    } catch (error) {
      console.warn("Không tải được một tác phẩm từ Firebase:", error);
    }
  }

  return projects.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
};

export const deleteProjectFromFirebase = async (projectId: string): Promise<void> => {
  if (!isFirebaseConfigured()) return;
  const basePath = await projectBasePath(projectId);
  const chunksUrl = `${collectionUrl(`${basePath}/chunks`)}?pageSize=300`;
  const chunks = await firestoreFetch<{ documents?: FirestoreDocument[] }>(chunksUrl);

  for (const doc of chunks?.documents || []) {
    if (doc.name) {
      await firestoreFetch(doc.name, { method: "DELETE" });
    }
  }
  await firestoreFetch(basePath, { method: "DELETE" });
};
