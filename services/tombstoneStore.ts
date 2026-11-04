// Tombstone xoa du an ben vung: mot du an da xoa phai o trang thai da xoa tren MOI thiet bi,
// khong chi trong RAM cua phien da xoa (ban ghi RAM cu lam du an "song lai" tu thiet bi thu hai).
// Ban local luu o localStorage; ban cloud luu o users/{uid}/meta/tombstones tren Firestore
// (xem firebaseService) va duoc hop nhat vao ban local moi lan hydrate.
import { StoryProject } from "../types";

export const TOMBSTONES_STORAGE_KEY = "butnghien-tombstones-v1";
export const TOMBSTONE_TTL_MS = 30 * 24 * 3600 * 1000;

export type TombstoneMap = Record<string, number>;

const pruneTombstones = (map: TombstoneMap): TombstoneMap => {
  const cutoff = Date.now() - TOMBSTONE_TTL_MS;
  const next: TombstoneMap = {};
  Object.entries(map || {}).forEach(([id, ts]) => {
    const time = Number(ts) || 0;
    if (id && time >= cutoff) next[id] = time;
  });
  return next;
};

export const readLocalTombstones = (): TombstoneMap => {
  try {
    const raw = localStorage.getItem(TOMBSTONES_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return pruneTombstones(parsed && typeof parsed === "object" ? parsed : {});
  } catch {
    return {};
  }
};

export const persistLocalTombstones = (map: TombstoneMap) => {
  try {
    localStorage.setItem(TOMBSTONES_STORAGE_KEY, JSON.stringify(pruneTombstones(map)));
  } catch { /* localStorage day/bi chan — tombstone cloud van con */ }
};

export const writeLocalTombstone = (projectId: string) => {
  const map = readLocalTombstones();
  map[projectId] = Date.now();
  persistLocalTombstones(map);
};

export const clearLocalTombstone = (projectId: string) => {
  const map = readLocalTombstones();
  if (map[projectId]) {
    delete map[projectId];
    persistLocalTombstones(map);
  }
};

// Loc cac project da bi xoa o noi khac: tombstone moi hon ban ghi cua project thi project coi
// nhu da xoa. Project duoc sua/nhap lai SAU moc xoa (updatedAt lon hon) thi song lai hop le.
export const applyTombstones = (projects: StoryProject[], tombstones: TombstoneMap): StoryProject[] =>
  projects.filter(project => {
    const deletedAt = tombstones[project.id] || 0;
    return !(deletedAt && deletedAt >= (project.updatedAt || 0));
  });
