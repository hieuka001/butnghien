import { StoryProject } from "../types";

const DB_NAME = "but-nghien-ai-db";
const DB_VERSION = 1;
const PROJECT_STORE = "projects";

const hasIndexedDB = () => typeof indexedDB !== "undefined";

const openDatabase = (): Promise<IDBDatabase> => {
  if (!hasIndexedDB()) {
    return Promise.reject(new Error("Trình duyệt không hỗ trợ IndexedDB."));
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        const store = db.createObjectStore(PROJECT_STORE, { keyPath: "id" });
        store.createIndex("updatedAt", "updatedAt", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Không mở được database."));
  });
};

const transactionDone = (transaction: IDBTransaction) => new Promise<void>((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error || new Error("Giao dịch database thất bại."));
  transaction.onabort = () => reject(transaction.error || new Error("Giao dịch database bị hủy."));
});

export const loadProjectsFromDb = async (): Promise<StoryProject[]> => {
  const db = await openDatabase();

  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(PROJECT_STORE, "readonly");
      const store = transaction.objectStore(PROJECT_STORE);
      const request = store.getAll();

      request.onsuccess = () => {
        const projects = (request.result || []) as StoryProject[];
        resolve(projects.sort((a, b) => b.updatedAt - a.updatedAt));
      };
      request.onerror = () => reject(request.error || new Error("Không đọc được dữ liệu truyện."));
    });
  } finally {
    db.close();
  }
};

export const saveProjectToDb = async (project: StoryProject): Promise<void> => {
  const db = await openDatabase();

  try {
    const transaction = db.transaction(PROJECT_STORE, "readwrite");
    transaction.objectStore(PROJECT_STORE).put(project);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
};

export const saveProjectsToDb = async (projects: StoryProject[]): Promise<void> => {
  const db = await openDatabase();

  try {
    const transaction = db.transaction(PROJECT_STORE, "readwrite");
    const store = transaction.objectStore(PROJECT_STORE);
    for (const project of projects) {
      store.put(project);
    }
    await transactionDone(transaction);
  } finally {
    db.close();
  }
};

export const deleteProjectFromDb = async (projectId: string): Promise<void> => {
  const db = await openDatabase();

  try {
    const transaction = db.transaction(PROJECT_STORE, "readwrite");
    transaction.objectStore(PROJECT_STORE).delete(projectId);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
};

export const replaceAllProjectsInDb = async (projects: StoryProject[]): Promise<void> => {
  const db = await openDatabase();

  try {
    const transaction = db.transaction(PROJECT_STORE, "readwrite");
    const store = transaction.objectStore(PROJECT_STORE);
    store.clear();
    for (const project of projects) {
      store.put(project);
    }
    await transactionDone(transaction);
  } finally {
    db.close();
  }
};
