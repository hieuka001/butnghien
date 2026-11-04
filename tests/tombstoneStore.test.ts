import { describe, it, expect, beforeEach, vi } from "vitest";

// localStorage stub tối giản cho môi trường node.
const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
  setItem: (key: string, value: string) => { store.set(key, String(value)); },
  removeItem: (key: string) => { store.delete(key); },
});

import { readLocalTombstones, writeLocalTombstone, clearLocalTombstone, applyTombstones, TOMBSTONES_STORAGE_KEY } from "../services/tombstoneStore";
import type { StoryProject } from "../types";

const fakeProject = (id: string, updatedAt: number) => ({ id, updatedAt } as StoryProject);

describe("tombstoneStore", () => {
  beforeEach(() => store.clear());

  it("ghi rồi đọc lại tombstone", () => {
    writeLocalTombstone("p1");
    const map = readLocalTombstones();
    expect(map.p1).toBeGreaterThan(0);
    expect(JSON.parse(store.get(TOMBSTONES_STORAGE_KEY)!).p1).toBe(map.p1);
  });

  it("xóa tombstone khi nhập lại", () => {
    writeLocalTombstone("p1");
    clearLocalTombstone("p1");
    expect(readLocalTombstones().p1).toBeUndefined();
  });

  it("applyTombstones: bản ghi cũ hơn mốc xóa bị loại, bản mới hơn được giữ", () => {
    const deletedAt = Date.now();
    const projects = [fakeProject("dead", deletedAt - 1000), fakeProject("alive", deletedAt + 1000), fakeProject("untouched", 1)];
    const result = applyTombstones(projects, { dead: deletedAt, alive: deletedAt });
    expect(result.map(p => p.id)).toEqual(["alive", "untouched"]);
  });

  it("tombstone quá 30 ngày bị tỉa khi đọc", () => {
    store.set(TOMBSTONES_STORAGE_KEY, JSON.stringify({ old: Date.now() - 31 * 24 * 3600 * 1000, fresh: Date.now() }));
    const map = readLocalTombstones();
    expect(map.old).toBeUndefined();
    expect(map.fresh).toBeGreaterThan(0);
  });
});
