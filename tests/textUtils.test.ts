import { describe, it, expect } from "vitest";
import { countWords, clamp, cleanStoryText, isLikelyCutOffText, stripDirectionLabels } from "../services/textUtils";

describe("countWords", () => {
  it("đếm từ tiếng Việt có dấu", () => {
    expect(countWords("Một miếng đổi đời")).toBe(4);
    expect(countWords("  Thanh   Vân   Môn  ")).toBe(3);
  });
  it("chuỗi rỗng/chỉ khoảng trắng = 0", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
    expect(countWords(null)).toBe(0);
    expect(countWords(undefined)).toBe(0);
  });
});

describe("clamp", () => {
  it("kẹp hai đầu", () => {
    expect(clamp(5, 1, 10)).toBe(5);
    expect(clamp(-3, 1, 10)).toBe(1);
    expect(clamp(99, 1, 10)).toBe(10);
  });
});

describe("cleanStoryText", () => {
  it("gỡ code fence, tiêu đề markdown và bold", () => {
    expect(cleanStoryText("```\n## Chương 1\n**Mở đầu** hay.\n```")).toBe("Chương 1\nMở đầu hay.\n");
  });
  it("rỗng giữ rỗng", () => {
    expect(cleanStoryText("")).toBe("");
  });
});

describe("isLikelyCutOffText", () => {
  it("câu khép bằng dấu kết → không cụt", () => {
    expect(isLikelyCutOffText("Anh ta quay lưng bước đi, không ngoảnh lại nữa.")).toBe(false);
    expect(isLikelyCutOffText("— Được. Ta đồng ý!")).toBe(false);
  });
  it("kết bằng từ nối → cụt", () => {
    expect(isLikelyCutOffText("Anh ta quay lưng bước đi và")).toBe(true);
    expect(isLikelyCutOffText("Cô nhìn xuống dòng sông, nhưng")).toBe(true);
  });
  it("không dấu kết và đuôi dài chưa khép → cụt", () => {
    expect(isLikelyCutOffText("Trời đổ mưa. Sau đó anh ta đi về phía ngôi làng nhỏ nằm sâu trong thung lũng xa xa kia mãi không dừng lại thêm nữa")).toBe(true);
  });
  it("rỗng → cụt", () => {
    expect(isLikelyCutOffText("")).toBe(true);
    expect(isLikelyCutOffText("   ")).toBe(true);
  });
});

describe("stripDirectionLabels", () => {
  it("gỡ nhãn quản trị đầu dòng, giữ nội dung", () => {
    const input = "HƯỚNG TRUYỆN ĐÃ CHỌN: Kiếm Gãy Đoạn Hồn Cốc\nTiền đề: Một thanh kiếm gãy.";
    const output = stripDirectionLabels(input);
    expect(output).not.toContain("HƯỚNG TRUYỆN ĐÃ CHỌN");
    expect(output).toContain("Kiếm Gãy Đoạn Hồn Cốc");
    expect(output).toContain("Một thanh kiếm gãy.");
  });
});
