// Tiện ích văn bản thuần dùng chung cho App và geminiService.
// Trước đây mỗi nơi giữ một bản sao (countWords/countDraftWords, clamp/clampNumber,
// isLikelyCutOffText/draftLooksCutOff, stripDirectionLabels) và chúng đã lệch nhau nhẹ —
// gom về một nguồn duy nhất tại đây, có test khóa ở tests/textUtils.test.ts.
export const countWords = (text: unknown): number =>
  String(text || "").trim().split(/\s+/).filter(Boolean).length;

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export const cleanStoryText = (text: string): string => {
  if (!text) return "";
  return text
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/```/g, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/\*\*/g, "");
};

const terminalPunctuationPattern = /[.!?…。！？)"'”’\]]$/;
const danglingEndingPattern = /(?:,\s*|;\s*|:\s*|-+\s*|—\s*|và|hoặc|nhưng|rằng|vì|nên|khi|nếu|để|của|với|trong|từ|bằng|như|là|mà)$/i;

// Nhận diện bản thảo bị cắt cụt: không kết bằng dấu kết câu, kết bằng từ nối,
// hoặc sau dấu ngắt câu cuối còn > 10 từ chưa khép.
export const isLikelyCutOffText = (text: string): boolean => {
  const normalized = cleanStoryText(text).trim();
  if (!normalized) return true;
  const tail = normalized.replace(/\s+/g, " ").slice(-220).trim();
  if (!tail) return true;
  if (terminalPunctuationPattern.test(tail)) return false;
  if (danglingEndingPattern.test(tail)) return true;

  const lastSentenceBreak = Math.max(
    tail.lastIndexOf("."),
    tail.lastIndexOf("!"),
    tail.lastIndexOf("?"),
    tail.lastIndexOf("…"),
  );
  return lastSentenceBreak < 0 || tail.slice(lastSentenceBreak + 1).trim().split(/\s+/).length > 10;
};

export const stripDirectionLabels = (value: unknown): string => String(value || "")
  .replace(/\r\n/g, "\n")
  .replace(/^\s*(?:HƯỚNG TRUYỆN ĐÃ CHỌN|HUONG TRUYEN DA CHON)\s*[:：-]\s*/gim, "")
  .replace(/^\s*(?:Tiền đề|Tien de|Động cơ truyện|Dong co truyen|Phù hợp khi|Phu hop khi|Logic cốt truyện|Logic cot truyen|Nhịp Arc|Nhip Arc|Dư âm\/cao trào|Du am\/cao trao|Điều cần tránh|Dieu can tranh|Bắt buộc khi lập lộ trình|Bat buoc khi lap lo trinh)\s*[:：-]\s*/gim, "")
  .replace(/\s+/g, " ")
  .trim();
