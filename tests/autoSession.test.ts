import { describe, it, expect } from "vitest";
import { planAutoWriteChapters, nextInReadQueue } from "../services/autoSession";
import type { Volume } from "../types";

const volume = (partial: Partial<Volume>): Volume => ({
  index: 1,
  title: "Arc",
  summary: "",
  purpose: "",
  chapterStart: 1,
  chapterEnd: 1,
  chapters: [],
  ...partial,
} as Volume);

describe("planAutoWriteChapters", () => {
  it("bỏ qua chương đã viết, giữ thứ tự theo Arc", () => {
    const volumes = [
      volume({ index: 1, chapterStart: 1, chapterEnd: 3, chapters: [{ index: 1 }, { index: 2 }, { index: 3 }] as any }),
      volume({ index: 2, chapterStart: 4, chapterEnd: 5, chapters: [{ index: 4 }, { index: 5 }] as any }),
    ];
    expect(planAutoWriteChapters(volumes, new Set([1, 2]), 10, 0)).toEqual([3, 4, 5]);
  });

  it("Arc chưa có bản đồ vẫn sinh đủ dải chương từ chapterStart..chapterEnd", () => {
    const volumes = [volume({ index: 1, chapterStart: 7, chapterEnd: 9, chapters: [] })];
    expect(planAutoWriteChapters(volumes, new Set(), 20, 0)).toEqual([7, 8, 9]);
  });

  it("tôn trọng trần tổng chương và giới hạn mỗi phiên", () => {
    const volumes = [volume({ index: 1, chapterStart: 1, chapterEnd: 10, chapters: [] })];
    expect(planAutoWriteChapters(volumes, new Set(), 4, 0)).toEqual([1, 2, 3, 4]);
    expect(planAutoWriteChapters(volumes, new Set(), 100, 2)).toEqual([1, 2]);
  });

  it("hết chương chưa viết → kế hoạch rỗng", () => {
    const volumes = [volume({ index: 1, chapterStart: 1, chapterEnd: 2, chapters: [] })];
    expect(planAutoWriteChapters(volumes, new Set([1, 2]), 10, 0)).toEqual([]);
  });
});

describe("nextInReadQueue", () => {
  it("trả chương đầu chưa đọc, null khi hết", () => {
    expect(nextInReadQueue([3, 4, 5], new Set([3]))).toBe(4);
    expect(nextInReadQueue([3], new Set([3]))).toBeNull();
    expect(nextInReadQueue([], new Set())).toBeNull();
  });
});
