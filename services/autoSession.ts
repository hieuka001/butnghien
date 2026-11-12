import type { Volume } from "../types";

// Lập kế hoạch cho phiên tự viết: đi qua các Arc theo thứ tự, lấy các chương CHƯA có
// nội dung, dừng ở trần tổng số chương của tác phẩm và ở giới hạn số chương/phiên.
// Arc chưa có bản đồ chương vẫn cho ra đúng dải chỉ số chương của nó (chapterStart..chapterEnd)
// — khâu lập bản đồ sẽ chạy lười khi phiên viết tới Arc đó.
export const planAutoWriteChapters = (
  volumes: Volume[],
  writtenIndexes: ReadonlySet<number>,
  totalChapters: number,
  limit: number,
): number[] => {
  const plan: number[] = [];
  const orderedVolumes = [...volumes].sort((a, b) => a.index - b.index);
  for (const volume of orderedVolumes) {
    const planned = (volume.chapters || []).map(chapter => chapter.index);
    const start = volume.chapterStart || (planned.length ? Math.min(...planned) : 0);
    const end = volume.chapterEnd || (planned.length ? Math.max(...planned) : 0);
    const indexes = planned.length ? [...new Set(planned)].sort((a, b) => a - b) : [];
    for (let index = start; index >= 1 && index <= end; index += 1) {
      if (!indexes.includes(index)) indexes.push(index);
    }
    indexes.sort((a, b) => a - b);
    for (const index of indexes) {
      if (index < 1) continue;
      if (totalChapters > 0 && index > totalChapters) continue;
      if (writtenIndexes.has(index)) continue;
      plan.push(index);
      if (limit > 0 && plan.length >= limit) return plan;
    }
  }
  return plan;
};

// Chương tiếp theo trong hàng đợi đọc: phần tử đầu tiên chưa đọc.
export const nextInReadQueue = (queue: number[], alreadyRead: ReadonlySet<number>): number | null => {
  for (const index of queue) {
    if (!alreadyRead.has(index)) return index;
  }
  return null;
};
