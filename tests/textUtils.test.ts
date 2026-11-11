import { describe, it, expect } from "vitest";
import { countWords, clamp, cleanStoryText, isLikelyCutOffText, stripDirectionLabels, splitSentencesForSpeech } from "../services/textUtils";

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

describe("stripDirectionLabels", () => {  it("gỡ nhãn quản trị đầu dòng, giữ nội dung", () => {
    const input = "HƯỚNG TRUYỆN ĐÃ CHỌN: Kiếm Gãy Đoạn Hồn Cốc\nTiền đề: Một thanh kiếm gãy.";
    const output = stripDirectionLabels(input);
    expect(output).not.toContain("HƯỚNG TRUYỆN ĐÃ CHỌN");
    expect(output).toContain("Kiếm Gãy Đoạn Hồn Cốc");
    expect(output).toContain("Một thanh kiếm gãy.");
  });
});

describe("splitSentencesForSpeech", () => {
  it("cắt theo dấu kết câu, giữ hội thoại", () => {
    const parts = splitSentencesForSpeech("Trời đổ mưa. Lâm Khiếu Phong rút kiếm! Anh ta hỏi: “Ngươi là ai?” Không ai trả lời.");
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe("Trời đổ mưa.");
    expect(parts[2]).toContain("Ngươi là ai?");
  });
  it("gộp mẩu quá ngắn vào đoạn trước", () => {
    const parts = splitSentencesForSpeech("Anh ta quay người bước ra khỏi phế tích của môn phái. Đi thôi.");
    expect(parts.length).toBe(1);
    expect(parts[0]).toContain("Đi thôi.");
  });
  it("câu dài bị tách tại dấu phẩy, mỗi đoạn ≤ 300 ký tự", () => {
    const longSentence = ("một đoạn văn rất dài, ".repeat(30)).trim() + ".";
    const parts = splitSentencesForSpeech(longSentence);
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach(part => expect(part.length).toBeLessThanOrEqual(300));
  });
  it("rỗng → mảng rỗng", () => {
    expect(splitSentencesForSpeech("")).toEqual([]);
    expect(splitSentencesForSpeech("   ")).toEqual([]);
  });
});
