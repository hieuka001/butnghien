import { StoryParams, Chapter, Volume, StoryLogicReport } from "../types";

type AnyRecord = Record<string, any>;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const normalizeGeminiModel = (model?: string) => {
  const cleaned = (model || "").trim().replace(/^models\//, "");
  if (!cleaned) return "gemini-2.5-flash";

  const deprecatedModelMap: Record<string, string> = {
    "gemini-1.5-flash": "gemini-2.5-flash",
    "gemini-1.5-flash-latest": "gemini-2.5-flash",
    "gemini-1.5-pro": "gemini-2.5-flash",
    "gemini-1.5-pro-latest": "gemini-2.5-flash",
    "gemini-pro": "gemini-2.5-flash",
  };

  return deprecatedModelMap[cleaned] || cleaned;
};
const PLAN_MODEL = normalizeGeminiModel(process.env.GEMINI_PLAN_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash");
const WRITE_MODEL = normalizeGeminiModel(process.env.GEMINI_WRITE_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash");
const DEFAULT_MAX_OUTPUT_TOKENS = clamp(Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 8192, 512, 65536);
const USE_GEMINI_PROXY = process.env.GEMINI_SERVER_PROXY === "true";

const SYSTEM_INSTRUCTION_ROADMAP = `Bạn là một biên kịch trưởng chuyên thiết kế truyện dài theo cấu trúc chương.
Nhiệm vụ bắt buộc:
1. Biến dữ liệu đầu vào thành hồ sơ tác phẩm có nhân quả rõ ràng.
2. Lập lộ trình đủ từ chương 1 đến chương cuối, chia thành các Arc hợp lý.
3. Ở bước lộ trình đầu tiên chỉ cần Đại cục, Thiên Cơ Lục và Arc; bản đồ chương chi tiết sẽ lập riêng cho từng Arc khi bắt đầu viết.
4. Dựng Thiên Cơ Lục như sổ canon: timeline, số liệu, quan hệ, vật phẩm, luật thế giới, mâu thuẫn mở và điều cấm phá logic.
5. Khóa rõ logic điểm nhìn: nhân vật được gọi bằng tên gì ở từng giai đoạn, ai biết thông tin nào, ai đặt tên, khi nào nhân vật đủ nhận thức để biết/muốn/hành động.
6. Mọi dữ kiện chưa chắc phải ghi "chưa khóa"; không bịa số liệu mơ hồ để lấp chỗ trống.
7. Không viết văn xuôi truyện ở bước này. Chỉ trả về JSON hợp lệ.`;

const SYSTEM_INSTRUCTION_NEXT_ARC = `Bạn là biên kịch trưởng đang mở rộng một truyện dài đã có hồ sơ.
Dựa vào Thiên Cơ Lục, đại cục và lịch sử chương, hãy tạo Arc kế tiếp sao cho không phá logic cũ, không lặp tình tiết và vẫn đẩy tác phẩm tới kết cục đã chọn.
Không được đổi số liệu, timeline, quan hệ, luật thế giới, vật phẩm hoặc cấp bậc đã khóa nếu không có lý do nhân quả rõ trong truyện.
Không được đổi tên gọi, tuổi, người chăm sóc, ký ức, mục tiêu hoặc năng lực hành động của nhân vật nếu lịch sử chương chưa tạo cảnh chuyển trạng thái.
Chỉ trả về JSON hợp lệ.`;

const SYSTEM_INSTRUCTION_CHAPTER_PLAN = `Bạn là biên kịch trưởng chuyên lập bản đồ chương cho một Arc đã khóa.
Nhiệm vụ:
1. Chia đúng phạm vi chương được giao thành các kế hoạch chương liên tục, không thiếu, không trùng.
2. Mỗi chương phải có mục tiêu, chức năng trong Arc, 3 beat dạng cảnh, 2 chi tiết bắt buộc, nhịp độ và móc nối.
3. Bám Thiên Cơ Lục tuyệt đối: không đổi tên riêng, số liệu, timeline, quan hệ, cấp bậc, vật phẩm hoặc luật thế giới.
4. Mỗi kế hoạch chương phải đúng điểm nhìn và trạng thái nhân vật tại thời điểm đó: tên gọi, tuổi/nhận thức, điều biết/chưa biết, năng lực hành động, lời nói hợp tuổi và quan hệ.
5. Mỗi beat phải là một cảnh có nhân quả: ai đang ở đó, họ muốn gì, va chạm là gì, lựa chọn nào tạo hậu quả.
6. Không viết văn xuôi truyện ở bước này. Chỉ trả về JSON hợp lệ.`;

const WRITER_SYSTEM_INSTRUCTION = `Bạn là tiểu thuyết gia tiếng Việt hiện đại, có tư duy biên kịch chặt chẽ và gu văn chuyên nghiệp.
Văn phong ưu tiên: giàu cảnh, ít sáo ngữ, câu văn linh hoạt, hình ảnh chính xác, thoại có hàm ý, nhịp đoạn kiểm soát tốt. Viết có chất văn nhưng không phô diễn; cảm xúc sâu nhưng không ủy mị; hiện đại nhưng không cộc.
Luôn viết thành văn xuôi hoàn chỉnh, đặt nhân vật vào cảnh cụ thể rồi để hành động, lựa chọn, chi tiết vật lý và đối thoại bộc lộ tâm lý; không tóm tắt thay cho cảnh.
Bạn phải bám lộ trình chương, giữ đúng tính cách và mục tiêu nhân vật, không nhảy cóc, không dùng markdown, không gạch đầu dòng.
Khóa canon tuyệt đối:
- Mọi tên riêng, số liệu, mốc thời gian, cấp bậc, quan hệ, vật phẩm và luật thế giới phải lấy từ Thiên Cơ Lục, Đại cục, Arc và kế hoạch chương.
- Không tự ý đổi tuổi, số lượng, thời hạn, khoảng cách, tài nguyên, cảnh giới, chức vụ hoặc quan hệ nếu chưa có nguyên nhân và hậu quả trong cảnh.
- Nếu cần thêm dữ kiện mới, phải đưa vào bằng hành động/đối thoại cụ thể và không mâu thuẫn dữ kiện cũ.
- Không lan man: mỗi đoạn phải phục vụ ít nhất một việc: đẩy mục tiêu chương, bộc lộ nhân vật, tạo hậu quả, hoặc chuẩn bị xung đột kế tiếp.
- Tránh lối văn cũ kỹ như liên tục than thở, giải thích đạo lý, dùng thành ngữ rỗng, câu cảm thán dày đặc, miêu tả dài mà không làm tình thế thay đổi.
- Ưu tiên nhịp văn chuyên nghiệp: câu ngắn dùng để tạo lực, câu dài dùng để mở cảm giác; đoạn 3-5 câu là chính, chuyển cảnh rõ, không nhồi thông tin vào một đoạn quá dài.`;

const PROSE_RHYTHM_RULES = `Luật nhịp văn bắt buộc:
- Không viết quá cộc. Văn hiện đại nhưng vẫn phải có hơi thở, cảnh, khoảng lặng và cảm giác sống.
- Mỗi đoạn thường 2-5 câu. Đoạn 1 câu chỉ dùng cho điểm nhấn, quyết định, cú lật hoặc dư âm.
- Đối thoại nên tách dòng khi đổi người nói. Sau thoại, cần có cử chỉ, phản ứng hoặc khoảng im lặng khi nó giúp tăng lực cảnh.
- Nhấn nhá bằng độ dài câu, xuống dòng và chi tiết đắt giá; không dùng markdown, không in đậm, không lạm dụng chấm than.
- Tránh đoạn văn dẹt: mỗi đoạn cần có một chuyển động rõ như nhận ra, nảy sinh nghi ngờ, đổi thái độ, hành động, hậu quả hoặc một chi tiết đáng nhớ.
- Nên xen kẽ câu ngắn, câu vừa và câu dài. Câu ngắn để tạo lực; câu dài để mở cảm giác, không phải để giải thích lan man.`;

const SCENE_LOGIC_RULES = `Luật logic cảnh bắt buộc:
- Mỗi cảnh phải có chuỗi: mục tiêu -> va chạm -> lựa chọn -> hậu quả. Không được chỉ miêu tả hoặc chỉ kê khai tâm trạng.
- Nhân vật không được biết, đoán đúng, xuất hiện, thắng hoặc thất bại nếu chưa có nguyên nhân trong cảnh hoặc trong Thiên Cơ Lục.
- Mỗi dữ kiện mới phải để lại dấu vết cho chương sau: một mối quan hệ đổi trạng thái, một manh mối, một cấm kỵ, một món nợ, một vết thương, hoặc một quyết định khó rút lại.
- Không được để lời kể biết thay nhân vật. Nếu cảnh bám sát một đứa trẻ, người mất trí nhớ hoặc người chưa có thông tin, văn bản phải giới hạn trong thứ họ có thể cảm, thấy, nghe, suy ra hoặc được người khác gọi.
- Khi cần giải thích, hãy để giải thích nằm trong hành động, đối thoại, vật chứng hoặc sai lầm của nhân vật.`;

const IMMERSIVE_LOGIC_RULES = `Luật nhập vai và điểm nhìn bắt buộc:
- Trước mỗi cảnh, tự xác định trạng thái hiện tại của nhân vật: tuổi/tầm nhận thức, tên đang được gọi trong cảnh, nơi ở, người đang có mặt, điều đã biết, điều chưa thể biết, năng lực thể chất, quyền lựa chọn và mục tiêu tức thời.
- Tên nhân vật trong hồ sơ chỉ là dữ liệu quản trị. Trong văn bản truyện, chỉ dùng tên đó sau khi có người đặt tên, gọi tên, hoặc nhân vật đủ điều kiện biết tên mình. Nếu mở đầu là trẻ sơ sinh bị bỏ rơi, chưa ai đặt tên thì chỉ được gọi bằng "đứa bé", "nó", "đứa trẻ", dấu hiệu nhận dạng, hoặc cách gọi của người nhặt được.
- Không để nhân vật biết thông tin mà họ chưa từng nghe, thấy, đọc, suy luận hợp lý hoặc được người khác nói. Người kể chuyện cũng không được vô tình tiết lộ thông tin làm hỏng điểm nhìn nếu cảnh đang bám sát nhân vật.
- Lời nói phải đúng tuổi, địa vị, quan hệ và mức hiểu biết. Trẻ sơ sinh không có độc thoại trưởng thành; trẻ nhỏ không nói như người lớn; người xa lạ không gọi thân mật nếu chưa có quan hệ.
- Hành động phải đúng cơ thể và hoàn cảnh. Nhân vật bị thương, mới sinh, bị trói, đói, mất trí nhớ, nghèo khó hoặc bị bỏ rơi không thể hành động như người khỏe mạnh/đủ quyền lực nếu chưa có nguyên nhân.
- Khi chuyển thời gian, đổi tên gọi, đổi người chăm sóc, đổi mục tiêu hoặc đổi quan hệ, phải có cảnh hoặc câu nối rõ nguyên nhân. Không nhảy từ "bị bỏ rơi" sang "đã có tên và ký ức đầy đủ" nếu chưa viết quá trình được nhặt, nhận nuôi, đặt tên và lớn lên.
- Nếu hồ sơ nhập tên nhân vật nhưng chương mở đầu là giai đoạn chưa được đặt tên, hãy xem tên đó là tên tương lai. Văn xuôi hiện tại chỉ được gọi bằng cách nhân vật/người trong cảnh có thể biết.
- Ưu tiên đặt người đọc vào vị trí nhân vật: cảm giác trước, suy luận sau, quyết định cuối. Không dùng lời kể toàn tri để lấp lỗ hổng logic.`;

const ACTIVE_WRITER_SYSTEM_INSTRUCTION = `${WRITER_SYSTEM_INSTRUCTION}

${PROSE_RHYTHM_RULES}

${SCENE_LOGIC_RULES}

${IMMERSIVE_LOGIC_RULES}`;

const EDITOR_SYSTEM_INSTRUCTION = `Bạn là biên tập viên tuyến truyện khó tính.
Chỉ chấp nhận chương nếu nó bám đúng đại cục, đúng Arc, đúng mục tiêu chương, không phá logic nhân vật, không lặp chương cũ và không kết thúc sớm khi chưa tới chương cuối.
Thẩm định bắt buộc cả timeline, số liệu, tên riêng, quan hệ, cấp bậc/quy tắc thế giới, vật phẩm, khoảng cách, mục tiêu chương, nhịp độ, mức lan man, điểm nhìn, tên gọi theo thời điểm, tuổi/nhận thức, lời nói và hành động theo hoàn cảnh.`;

class GeminiRequestError extends Error {
  status?: number;
  keyIndex?: number;
  rotatable: boolean;

  constructor(message: string, status?: number, keyIndex?: number, rotatable = false) {
    super(message);
    this.name = "GeminiRequestError";
    this.status = status;
    this.keyIndex = keyIndex;
    this.rotatable = rotatable;
  }
}

class AIJsonParseError extends Error {
  rawText: string;

  constructor(rawText: string, cause?: unknown) {
    super("Dữ liệu từ AI không đúng định dạng JSON.");
    this.name = "AIJsonParseError";
    this.rawText = rawText;
    if (cause) {
      console.error("Lỗi parse JSON:", cause, rawText);
    }
  }
}

let keyCursor = 0;
const keyCooldownUntil = new Map<number, number>();

const countWords = (text: unknown) => String(text || "").trim().split(/\s+/).filter(Boolean).length;

const asText = (value: unknown, fallback = "") => {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
};

const asStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.map(item => asText(item)).filter(Boolean);
};

const getGeminiKeys = () => {
  const numberedKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
  ];
  const listKeys = (process.env.GEMINI_API_KEYS || "")
    .split(",")
    .map(key => key.trim())
    .filter(Boolean);

  return [...numberedKeys, ...listKeys]
    .filter((key): key is string => Boolean(key && key.trim()))
    .filter((key, index, all) => all.indexOf(key) === index);
};

export const getConfiguredGeminiKeyCount = () => getGeminiKeys().length || (USE_GEMINI_PROXY ? 1 : 0);

const isRotatableStatus = (status?: number) => {
  if (!status) return false;
  return [401, 402, 408, 429, 500, 502, 503].includes(status);
};

const markKeyCooling = (keyIndex: number, status?: number) => {
  const cooldownMs = status === 429 ? 90 * 1000 : 20 * 1000;
  keyCooldownUntil.set(keyIndex, Date.now() + cooldownMs);
};

const pickKeyIndex = (keys: string[]) => {
  const now = Date.now();
  for (let offset = 0; offset < keys.length; offset++) {
    const index = (keyCursor + offset) % keys.length;
    const coolingUntil = keyCooldownUntil.get(index) || 0;
    if (coolingUntil <= now) {
      keyCursor = (index + 1) % keys.length;
      return index;
    }
  }

  keyCooldownUntil.clear();
  const index = keyCursor % keys.length;
  keyCursor = (index + 1) % keys.length;
  return index;
};

const requestHeaders = (apiKey: string) => ({
  "x-goog-api-key": apiKey,
  "Content-Type": "application/json",
});

const capOutputTokens = (tokens: number) => clamp(Math.floor(tokens), 512, DEFAULT_MAX_OUTPUT_TOKENS);

const estimateMaxTokens = (targetWords: number, floor = 900) => capOutputTokens(clamp(Math.ceil(targetWords * 3.2), floor, 48000));

const extractAffordableTokens = (message: string) => {
  const match = message.match(/afford\s+(\d+)/i);
  return match ? Number(match[1]) : null;
};

const parseErrorBody = async (response: Response) => {
  try {
    const data = await response.json();
    return data?.error?.message || data?.error?.code || response.statusText;
  } catch {
    try {
      return await response.text();
    } catch {
      return response.statusText;
    }
  }
};

const requestGeminiProxy = (
  model: string,
  systemInstruction: string,
  prompt: string,
  temperature: number,
  maxTokens: number,
  jsonMode: boolean,
  stream: boolean,
) => fetch("/api/gemini", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model,
    systemInstruction,
    prompt,
    temperature,
    maxTokens,
    jsonMode,
    stream,
  }),
});

const withGeminiKeys = async <T,>(requester: (apiKey: string, keyIndex: number) => Promise<T>): Promise<T> => {
  const keys = getGeminiKeys();
  if (!keys.length) {
    throw new Error("Thiếu Gemini API key. Hãy cấu hình GEMINI_API_KEY trong .env.local.");
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const keyIndex = pickKeyIndex(keys);
    try {
      return await requester(keys[keyIndex], keyIndex);
    } catch (error) {
      lastError = error;
      if (error instanceof GeminiRequestError && error.rotatable && attempt < keys.length - 1) {
        markKeyCooling(keyIndex, error.status);
        continue;
      }
      throw error;
    }
  }

  if (lastError instanceof Error) {
    throw lastError;
  }
  throw new Error("Tất cả Gemini API key đều không dùng được ở thời điểm này.");
};

const cleanStoryText = (text: string): string => {
  if (!text) return "";
  return text
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/```/g, "")
    .replace(/^\s{0,3}#{1,6}\s*/gm, "")
    .replace(/\*\*/g, "");
};

const terminalPunctuationPattern = /[.!?…。！？)"'”’\]]$/;
const danglingEndingPattern = /(?:,\s*|;\s*|:\s*|-+\s*|—\s*|và|hoặc|nhưng|rằng|vì|nên|khi|nếu|để|của|với|trong|từ|bằng|như|là|mà)$/i;

const isLikelyCutOffText = (text: string) => {
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

const chapterNeedsContinuation = (text: string, minWords: number) =>
  countWords(text) < minWords || isLikelyCutOffText(text);

const minimumChapterWords = (targetWords: number) => Math.max(650, Math.floor(targetWords * 0.95));
const minimumShortStoryWords = (targetWords: number) => Math.max(700, Math.floor(targetWords * 0.92));

const normalizeGeneratedDraft = (text: string) => cleanStoryText(text)
  .replace(/\r\n/g, "\n")
  .replace(/[ \t]+\n/g, "\n")
  .replace(/\n{3,}/g, "\n\n")
  .trim();

const cleanContinuationText = (text: string) => normalizeGeneratedDraft(text)
  .replace(/^\s*(?:Tên chương|Tên truyện)\s*:\s*.+(?:\n+|$)/i, "")
  .trimStart();

const appendDraftPart = (base: string, addition: string) => {
  const current = normalizeGeneratedDraft(base);
  const next = cleanContinuationText(addition);
  if (!current) return next;
  if (!next) return current;
  return `${current}\n\n${next}`;
};

const excerptForAudit = (text: string, limit = 11000) => {
  const cleaned = normalizeGeneratedDraft(text);
  if (cleaned.length <= limit) return cleaned;
  const partSize = Math.floor(limit / 3);
  const middleStart = Math.max(partSize, Math.floor(cleaned.length / 2 - partSize / 2));
  return [
    "[ĐẦU VĂN BẢN]",
    cleaned.slice(0, partSize),
    "[GIỮA VĂN BẢN]",
    cleaned.slice(middleStart, middleStart + partSize),
    "[CUỐI VĂN BẢN]",
    cleaned.slice(-partSize),
  ].join("\n\n");
};

const protagonistHandleForDraft = (params: StoryParams, context = "") => {
  const text = plainText(`${context} ${params.seed || ""} ${params.directionLock || ""}`);
  const childOrUnnamed = /(so sinh|moi sinh|hai nhi|em be|dua be|dua tre|tre so sinh|bo roi|bo lai|nhan nuoi|nhat duoc|mo coi|khong ten|chua dat ten)/.test(text);
  const amnesia = /(mat tri nho|quen ten|khong nho ten|mat ky uc|xoa ky uc)/.test(text);
  if (childOrUnnamed) return { label: "đứa trẻ", pronoun: "nó" };
  if (amnesia) {
    if (params.character.gender === "Nữ") return { label: "người phụ nữ ấy", pronoun: "cô" };
    if (params.character.gender === "Nam") return { label: "người đàn ông ấy", pronoun: "anh" };
    return { label: "người ấy", pronoun: "người ấy" };
  }
  if (params.character.name?.trim()) {
    if (params.character.gender === "Nữ") return { label: params.character.name.trim(), pronoun: "cô" };
    if (params.character.gender === "Nam") return { label: params.character.name.trim(), pronoun: "cậu" };
    return { label: params.character.name.trim(), pronoun: "người ấy" };
  }
  return { label: "nhân vật chính", pronoun: "người ấy" };
};

const stripJsonFence = (text: string) => text
  .replace(/^\uFEFF/, "")
  .replace(/```(?:json|JSON)?/g, "")
  .replace(/```/g, "")
  .trim();

const extractBalancedJsonCandidates = (text: string) => {
  const source = stripJsonFence(text);
  const candidates: string[] = [];

  for (let start = 0; start < source.length; start++) {
    const opening = source[start];
    if (opening !== "{" && opening !== "[") continue;

    const stack: string[] = [opening === "{" ? "}" : "]"];
    let inString = false;
    let escaped = false;

    for (let index = start + 1; index < source.length; index++) {
      const char = source[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (char === "{" || char === "[") {
        stack.push(char === "{" ? "}" : "]");
      } else if (char === "}" || char === "]") {
        if (stack.pop() !== char) break;
        if (stack.length === 0) {
          candidates.push(source.slice(start, index + 1));
          break;
        }
      }
    }
  }

  return candidates;
};

const parseAIResponse = (text: string) => {
  const candidates = [
    ...extractBalancedJsonCandidates(text),
    stripJsonFence(text),
  ]
    .map(candidate => candidate
      .replace(/[“”]/g, "\"")
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, "$1")
      .trim())
    .filter((candidate, index, all) => Boolean(candidate) && all.indexOf(candidate) === index);

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
      // Thử ứng viên kế tiếp trước khi báo lỗi định dạng.
    }
  }

  throw new AIJsonParseError(text, lastError);
};

const extractGeminiText = (data: AnyRecord) => (data?.candidates?.[0]?.content?.parts || [])
  .map((part: AnyRecord) => part.text || "")
  .join("");

const chatJson = async (
  model: string,
  systemInstruction: string,
  prompt: string,
  temperature = 0.45,
  maxTokens = 12000,
): Promise<any> => {
  const outputTokens = capOutputTokens(maxTokens);

  if (USE_GEMINI_PROXY) {
    const response = await requestGeminiProxy(model, systemInstruction, prompt, temperature, outputTokens, true, false);
    if (!response.ok) {
      const message = await parseErrorBody(response);
      const affordableTokens = extractAffordableTokens(message);
      const nextMaxTokens = affordableTokens ? capOutputTokens(affordableTokens - 160) : Math.floor(outputTokens * 0.65);
      if ((response.status === 429 || response.status === 400) && nextMaxTokens >= 512 && nextMaxTokens < outputTokens) {
        return chatJson(model, systemInstruction, prompt, temperature, nextMaxTokens);
      }
      throw new GeminiRequestError(`Gemini lỗi ${response.status}: ${message}`, response.status, undefined, isRotatableStatus(response.status));
    }

    const data = await response.json();
    if (data?.error) {
      const status = Number(data.error.code) || response.status;
      throw new GeminiRequestError(data.error.message || "Gemini trả về lỗi.", status, undefined, isRotatableStatus(status));
    }

    const content = extractGeminiText(data);
    if (!content) {
      const blockReason = data?.promptFeedback?.blockReason;
      throw new GeminiRequestError(blockReason ? `Gemini chặn prompt: ${blockReason}` : "Gemini không trả về nội dung.", response.status, undefined, true);
    }

    return parseAIResponse(content);
  }

  return withGeminiKeys(async (apiKey, keyIndex) => {
  const response = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
    method: "POST",
    headers: requestHeaders(apiKey),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature,
        maxOutputTokens: outputTokens,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!response.ok) {
    const message = await parseErrorBody(response);
    const affordableTokens = extractAffordableTokens(message);
    const nextMaxTokens = affordableTokens ? capOutputTokens(affordableTokens - 160) : Math.floor(outputTokens * 0.65);
    if ((response.status === 429 || response.status === 400) && nextMaxTokens >= 512 && nextMaxTokens < outputTokens) {
      return chatJson(model, systemInstruction, prompt, temperature, nextMaxTokens);
    }
    throw new GeminiRequestError(`Gemini lỗi ${response.status}: ${message}`, response.status, keyIndex, isRotatableStatus(response.status));
  }

  const data = await response.json();
  if (data?.error) {
    const status = Number(data.error.code) || response.status;
    throw new GeminiRequestError(data.error.message || "Gemini trả về lỗi.", status, keyIndex, isRotatableStatus(status));
  }

  const content = extractGeminiText(data);
  if (!content) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new GeminiRequestError(blockReason ? `Gemini chặn prompt: ${blockReason}` : "Gemini không trả về nội dung.", response.status, keyIndex, true);
  }

  return parseAIResponse(content);
  });
};

const chatText = async (
  model: string,
  systemInstruction: string,
  prompt: string,
  temperature = 0.78,
  maxTokens = 8000,
): Promise<string> => {
  const outputTokens = capOutputTokens(maxTokens);

  if (USE_GEMINI_PROXY) {
    const response = await requestGeminiProxy(model, systemInstruction, prompt, temperature, outputTokens, false, false);
    if (!response.ok) {
      const message = await parseErrorBody(response);
      const affordableTokens = extractAffordableTokens(message);
      const nextMaxTokens = affordableTokens ? capOutputTokens(affordableTokens - 160) : Math.floor(outputTokens * 0.65);
      if ((response.status === 429 || response.status === 400) && nextMaxTokens >= 512 && nextMaxTokens < outputTokens) {
        return chatText(model, systemInstruction, prompt, temperature, nextMaxTokens);
      }
      throw new GeminiRequestError(`Gemini lỗi ${response.status}: ${message}`, response.status, undefined, isRotatableStatus(response.status));
    }

    const data = await response.json();
    if (data?.error) {
      const status = Number(data.error.code) || response.status;
      throw new GeminiRequestError(data.error.message || "Gemini trả về lỗi.", status, undefined, isRotatableStatus(status));
    }

    const content = extractGeminiText(data);
    if (!content) {
      const blockReason = data?.promptFeedback?.blockReason;
      throw new GeminiRequestError(blockReason ? `Gemini chặn prompt: ${blockReason}` : "Gemini không trả về nội dung.", response.status, undefined, true);
    }
    return cleanStoryText(content);
  }

  return withGeminiKeys(async (apiKey, keyIndex) => {
    const response = await fetch(`${GEMINI_API_BASE}/models/${model}:generateContent`, {
      method: "POST",
      headers: requestHeaders(apiKey),
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature,
          maxOutputTokens: outputTokens,
        },
      }),
    });

    if (!response.ok) {
      const message = await parseErrorBody(response);
      const affordableTokens = extractAffordableTokens(message);
      const nextMaxTokens = affordableTokens ? capOutputTokens(affordableTokens - 160) : Math.floor(outputTokens * 0.65);
      if ((response.status === 429 || response.status === 400) && nextMaxTokens >= 512 && nextMaxTokens < outputTokens) {
        return chatText(model, systemInstruction, prompt, temperature, nextMaxTokens);
      }
      throw new GeminiRequestError(`Gemini lỗi ${response.status}: ${message}`, response.status, keyIndex, isRotatableStatus(response.status));
    }

    const data = await response.json();
    if (data?.error) {
      const status = Number(data.error.code) || response.status;
      throw new GeminiRequestError(data.error.message || "Gemini trả về lỗi.", status, keyIndex, isRotatableStatus(status));
    }

    const content = extractGeminiText(data);
    if (!content) {
      const blockReason = data?.promptFeedback?.blockReason;
      throw new GeminiRequestError(blockReason ? `Gemini chặn prompt: ${blockReason}` : "Gemini không trả về nội dung.", response.status, keyIndex, true);
    }
    return cleanStoryText(content);
  });
};

const streamChat = async (
  model: string,
  systemInstruction: string,
  prompt: string,
  onChunk: (text: string) => void,
  temperature = 0.78,
  maxTokens = 8000,
): Promise<string> => {
  const outputTokens = capOutputTokens(maxTokens);
  let emittedAnyToken = false;
  let keyIndex: number | undefined;
  const response = USE_GEMINI_PROXY
    ? await requestGeminiProxy(model, systemInstruction, prompt, temperature, outputTokens, false, true)
    : await withGeminiKeys(async (apiKey, selectedKeyIndex) => {
        keyIndex = selectedKeyIndex;
        const directResponse = await fetch(`${GEMINI_API_BASE}/models/${model}:streamGenerateContent?alt=sse`, {
          method: "POST",
          headers: requestHeaders(apiKey),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature,
              maxOutputTokens: outputTokens,
            },
          }),
        });
        if (!directResponse.ok) {
          const message = await parseErrorBody(directResponse);
          throw new GeminiRequestError(`Gemini lỗi ${directResponse.status}: ${message}`, directResponse.status, selectedKeyIndex, isRotatableStatus(directResponse.status));
        }
        return directResponse;
      });

  if (!response.ok) {
    const message = await parseErrorBody(response);
    const affordableTokens = extractAffordableTokens(message);
    const nextMaxTokens = affordableTokens ? capOutputTokens(affordableTokens - 160) : Math.floor(outputTokens * 0.65);
    if ((response.status === 429 || response.status === 400) && nextMaxTokens >= 512 && nextMaxTokens < outputTokens) {
      return streamChat(model, systemInstruction, prompt, onChunk, temperature, nextMaxTokens);
    }
    throw new GeminiRequestError(`Gemini lỗi ${response.status}: ${message}`, response.status, keyIndex, isRotatableStatus(response.status));
  }

  if (!response.body) {
    throw new GeminiRequestError("Gemini không mở được stream.", response.status, keyIndex, true);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  const processSseEvent = (event: string) => {
    const dataLines = event
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trim());

    for (const dataLine of dataLines) {
      if (!dataLine || dataLine === "[DONE]") continue;
      let payload: AnyRecord;
      try {
        payload = JSON.parse(dataLine);
      } catch (error) {
        console.warn("Bỏ qua một gói stream không phải JSON hợp lệ:", error);
        continue;
      }

      if (payload?.error) {
        const status = Number(payload.error.code) || 500;
        throw new GeminiRequestError(
          payload.error.message || "Gemini stream bị lỗi.",
          status,
          keyIndex,
          !emittedAnyToken && isRotatableStatus(status),
        );
      }

      const content = extractGeminiText(payload);
      if (content) {
        const cleaned = cleanStoryText(content);
        emittedAnyToken = true;
        fullText += cleaned;
        onChunk(cleaned);
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() || "";

    for (const event of events) {
      processSseEvent(event);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) processSseEvent(buffer);

  if (!fullText.trim()) {
    const fallbackText = await chatText(model, systemInstruction, prompt, temperature, outputTokens);
    if (fallbackText.trim()) {
      onChunk(fallbackText);
      return fallbackText;
    }
  }

  return fullText;
};

const desiredVolumeCount = (totalChapters: number) => {
  if (totalChapters <= 6) return 1;
  if (totalChapters <= 12) return 2;
  if (totalChapters <= 80) return clamp(Math.ceil(totalChapters / 10), 3, 8);
  return clamp(Math.ceil(totalChapters / 40), 8, 30);
};

const plainText = (value: unknown) => String(value || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase();

const directionTitleFromLock = (params: StoryParams) => {
  const match = String(params.directionLock || "").match(/HƯỚNG TRUYỆN ĐÃ CHỌN:\s*(.+)/i);
  return match?.[1]?.trim() || "";
};

const directionTextFromParams = (params: StoryParams) =>
  plainText(`${directionTitleFromLock(params)} ${params.directionLock || ""}`);

const curvePeak = (position: number, center: number, width: number) => {
  const distance = (position - center) / Math.max(width, 0.01);
  return Math.exp(-(distance * distance));
};

const arcNarrativeRole = (index: number, count: number) => {
  if (count <= 1) return "một Arc khép kín: mở mâu thuẫn, đẩy biến cố, trả giá và kết.";
  if (index === 0) return "khai cục ngắn: lời hứa thể loại, vết thương, biến cố đầu.";
  if (index === count - 1) return "kết cục: cao trào, trả giá, giải quyết và dư âm.";

  const position = index / Math.max(1, count - 1);
  if (position < 0.22) return "hội nhập và khóa quy tắc: nhân vật bị đẩy vào hệ thống xung đột.";
  if (position < 0.42) return "tích lũy chứng cứ, đồng minh, kẻ thù và lời hứa phụ.";
  if (position < 0.62) return "trung đoạn rộng: lật mặt nguyên nhân, đảo chiều mục tiêu.";
  if (position < 0.82) return "khủng hoảng và phản công: hậu quả cũ quay lại ép nhân vật.";
  return "tiền cao trào: siêu áp lực, thu hẹp lựa chọn, chuẩn bị trả giá.";
};

const narrativeArcWeight = (index: number, count: number, params: StoryParams) => {
  if (count <= 1) return 1;

  const position = index / Math.max(1, count - 1);
  const genreText = plainText((params.genres || []).join(" "));
  const modeText = plainText(params.mode);
  const directionText = directionTextFromParams(params);
  const seedComplexity = clamp(countWords(`${params.seed || ""} ${params.referenceStories || ""}`) / 180, 0, 1.4);
  const sliders: StoryParams["sliders"] = {
    romance: 0,
    violence: 0,
    philosophy: 0,
    psychology: 0,
    action: 0,
    strategy: 0,
    ...(params.sliders || {}),
  };

  let weight = 0.92;
  weight += curvePeak(position, 0.5, 0.22) * 0.28;
  weight += curvePeak(position, 0.76, 0.14) * 0.32;
  weight += seedComplexity * curvePeak(position, 0.38, 0.24) * 0.16;

  weight += (sliders.strategy / 100) * curvePeak(position, 0.56, 0.2) * 0.28;
  weight += (sliders.psychology / 100) * curvePeak(position, 0.38, 0.22) * 0.22;
  weight += (sliders.action / 100) * curvePeak(position, 0.78, 0.16) * 0.22;
  weight += (sliders.romance / 100) * curvePeak(position, 0.48, 0.28) * 0.14;
  weight += (sliders.philosophy / 100) * curvePeak(position, 0.62, 0.24) * 0.12;

  if (/trinh|toi pham|kinh di|linh di|tham tu|huyen bi/.test(genreText)) {
    weight += curvePeak(position, 0.34, 0.18) * 0.24;
    weight += curvePeak(position, 0.67, 0.16) * 0.14;
  }
  if (/tu tien|tien hiep|huyen huyen|he thong|xay dung|vo dich|luyen dan/.test(genreText)) {
    weight += curvePeak(position, 0.58, 0.24) * 0.26;
  }
  if (/ngon tinh|dam my|bach hop|tam ly|thanh xuan/.test(genreText)) {
    weight += curvePeak(position, 0.42, 0.25) * 0.2;
  }
  if (/twist|bi kich/.test(modeText)) {
    weight += curvePeak(position, 0.82, 0.12) * 0.18;
  }
  if (/dieu tra|huyen nghi|than phan|lat mat/.test(directionText)) {
    weight += curvePeak(position, 0.34, 0.18) * 0.28;
    weight += curvePeak(position, 0.68, 0.18) * 0.16;
  }
  if (/the luc|xay|tai nguyen|danh phan/.test(directionText)) {
    weight += curvePeak(position, 0.55, 0.25) * 0.32;
    weight += curvePeak(position, 0.75, 0.18) * 0.14;
  }
  if (/sinh ton|han gio|ap luc|tai nguyen can/.test(directionText)) {
    weight += curvePeak(position, 0.22, 0.12) * 0.18;
    weight += curvePeak(position, 0.82, 0.14) * 0.3;
  }
  if (/phan anh hung|dao duc|truot doc|bi kich|domino/.test(directionText)) {
    weight += curvePeak(position, 0.46, 0.23) * 0.18;
    weight += curvePeak(position, 0.78, 0.16) * 0.26;
  }
  if (/chua lanh|noi tam|tinh cam|quan he/.test(directionText)) {
    weight += curvePeak(position, 0.4, 0.28) * 0.24;
    weight += curvePeak(position, 0.62, 0.24) * 0.12;
  }
  if (/dau tri|muu luoc|ban co|phe phai/.test(directionText)) {
    weight += curvePeak(position, 0.58, 0.22) * 0.3;
    weight += curvePeak(position, 0.74, 0.16) * 0.2;
  }
  if (/dan gian|linh di|quy su|cam ky|nghi le/.test(directionText)) {
    weight += curvePeak(position, 0.3, 0.2) * 0.2;
    weight += curvePeak(position, 0.66, 0.17) * 0.22;
  }
  if (/phieu luu|kham pha|the gioi|dia diem/.test(directionText)) {
    weight += curvePeak(position, 0.5, 0.3) * 0.22;
  }

  if (index === 0) weight *= 0.72;
  if (index === count - 1) weight *= modeText.includes("mo de viet tiep") ? 0.78 : 0.9;
  if (position < 0.16) weight *= 0.88;
  if (position > 0.9) weight *= 0.92;

  return clamp(weight, 0.46, 1.72);
};

const rawArcSizes = (rawVolumes: AnyRecord[], count: number) => {
  if (rawVolumes.length < count) return null;
  const sizes = rawVolumes.slice(0, count).map(volume => {
    const start = Number(volume?.chapterStart);
    const end = Number(volume?.chapterEnd);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? Math.round(end - start + 1) : 0;
  });

  return sizes.every(size => size > 0) ? sizes : null;
};

const isTooUniformArcSizes = (sizes: number[]) => {
  if (sizes.length < 3) return false;
  const average = sizes.reduce((sum, size) => sum + size, 0) / sizes.length;
  const spread = Math.max(...sizes) - Math.min(...sizes);
  return spread <= Math.max(1, Math.round(average * 0.12));
};

const allocateSizesFromWeights = (totalChapters: number, weights: number[]) => {
  const safeWeights = weights.map(weight => Math.max(0.05, Number(weight) || 0.05));
  const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0) || 1;
  const rawSizes = safeWeights.map(weight => (weight / totalWeight) * totalChapters);
  const sizes = rawSizes.map(size => Math.max(1, Math.floor(size)));
  let currentTotal = sizes.reduce((sum, size) => sum + size, 0);

  while (currentTotal > totalChapters) {
    let donor = -1;
    for (let index = 0; index < sizes.length; index++) {
      if (sizes[index] > 1 && (donor === -1 || sizes[index] > sizes[donor])) donor = index;
    }
    if (donor === -1) break;
    sizes[donor]--;
    currentTotal--;
  }

  const priority = rawSizes
    .map((size, index) => ({ index, fraction: size - Math.floor(size) }))
    .sort((a, b) => b.fraction - a.fraction);
  let cursor = 0;
  while (currentTotal < totalChapters) {
    sizes[priority[cursor % priority.length]?.index || 0]++;
    currentTotal++;
    cursor++;
  }

  return sizes;
};

const buildRanges = (
  volumeCount: number,
  totalChapters: number,
  params: StoryParams,
  rawVolumes: AnyRecord[] = [],
) => {
  const count = clamp(volumeCount, 1, Math.max(1, totalChapters));
  const rawSizes = rawArcSizes(rawVolumes, count);
  const weights = rawSizes && !isTooUniformArcSizes(rawSizes)
    ? rawSizes
    : Array.from({ length: count }, (_, index) => narrativeArcWeight(index, count, params));
  const sizes = allocateSizesFromWeights(totalChapters, weights);
  let cursor = 1;

  return sizes.map((size) => {
    const start = cursor;
    const end = cursor + size - 1;
    cursor = end + 1;
    return { start, end };
  });
};

const buildArcBudgetGuide = (ranges: Array<{ start: number; end: number }>) =>
  ranges
    .map((range, index) => {
      const size = range.end - range.start + 1;
      return `- Arc ${index + 1}: chương ${range.start}-${range.end} (${size} chương) - ${arcNarrativeRole(index, ranges.length)}`;
    })
    .join("\n");

const pacingForChapter = (index: number, total: number): Chapter["pacing"] => {
  if (index === total) return "Cao trào";
  const ratio = index / Math.max(1, total);
  if (ratio < 0.25) return "Chậm";
  if (ratio < 0.72) return "Trung bình";
  return "Nhanh";
};

const chapterPhase = (index: number, total: number) => {
  if (index === 1) return "khai mở mâu thuẫn và lời hứa thể loại";
  if (index === total) return "cao trào, trả giá và dư âm kết cục";
  const ratio = index / Math.max(1, total);
  if (ratio < 0.35) return "đẩy nhân vật vào xung đột";
  if (ratio < 0.7) return "tăng biến chứng và đảo chiều lựa chọn";
  return "siết hậu quả, chuẩn bị cao trào";
};

const fallbackBeats = (index: number, total: number, volumeTitle: string) => [
  `Mở cảnh bằng một áp lực cụ thể của ${volumeTitle}`,
  `Nhân vật chính phải chọn hoặc trả giá`,
  index === total ? "Khép đại cục nhưng để lại dư âm" : "Để lại một hậu quả kéo sang chương sau",
];

const fallbackMustInclude = (params: StoryParams, index: number) => [
  `Giữ đúng tính cách ${params.character.name || "nhân vật chính"}`,
  index === params.totalChapters ? "Không bỏ sót kết cục đã chọn" : "Không giải quyết mâu thuẫn trung tâm quá sớm",
];

const sliderBrief = (params: StoryParams) => {
  const labels: Record<keyof StoryParams["sliders"], string> = {
    romance: "tình cảm",
    violence: "bạo lực",
    philosophy: "triết lý",
    psychology: "tâm lý",
    action: "hành động",
    strategy: "mưu lược",
  };
  const sliders: StoryParams["sliders"] = {
    romance: 0,
    violence: 0,
    philosophy: 0,
    psychology: 0,
    action: 0,
    strategy: 0,
    ...(params.sliders || {}),
  };

  return (Object.keys(labels) as Array<keyof StoryParams["sliders"]>)
    .map(key => `${labels[key]} ${sliders[key]}/100`)
    .join(", ");
};

const buildProjectBrief = (params: StoryParams) => `HỒ SƠ ĐẦU VÀO
- Loại dự án: ${params.projectType}
- Tổng số chương: ${params.totalChapters}
- Mục tiêu số chữ mỗi chương: ${params.length}
- Thể loại: ${params.genres.join(", ") || "Tự do"}
- Tông giọng: ${params.tone}
- Kiểu kết cấu/kết truyện: ${params.mode}
- Nhân vật chính: ${params.character.name || "Chưa đặt tên"}
- Lưu ý tên gọi: tên trong hồ sơ không đồng nghĩa nhân vật đã có/biết tên trong cảnh mở đầu; truyện chỉ được dùng tên này sau khi logic đặt tên/gọi tên đã xảy ra.
- Giới tính/định danh: ${params.character.gender}
- Tính cách: ${params.character.personality || "Chưa mô tả"}
- Mục tiêu nhân vật: ${params.character.goal || "Chưa mô tả"}
- Tỷ trọng nội dung: ${sliderBrief(params)}
- Ý tưởng khởi nguồn: ${params.seed || "Chưa có"}
- Hướng truyện đã khóa: ${params.directionLock || "Chưa chọn. AI phải tự đề xuất hướng hợp logic nhất từ hồ sơ."}
- Truyện mẫu/lưu ý tham chiếu: ${params.referenceStories || "Không có. Không sao chép tác phẩm có sẵn."}`;

const normalizeChapter = (
  raw: AnyRecord | undefined,
  index: number,
  params: StoryParams,
  volumeTitle: string,
): Chapter => {
  const beats = asStringArray(raw?.beats).slice(0, 6);
  const mustInclude = asStringArray(raw?.mustInclude).slice(0, 5);
  const phase = chapterPhase(index, params.totalChapters);

  return {
    index,
    title: asText(raw?.title, `Chương ${index}: ${volumeTitle}`),
    summary: asText(raw?.summary, `Chương ${index} thuộc giai đoạn ${phase}.`),
    objective: asText(raw?.objective, `Dùng một cảnh quyết định để ${phase}.`),
    beats: beats.length >= 3 ? beats : fallbackBeats(index, params.totalChapters, volumeTitle),
    mustInclude: mustInclude.length >= 2 ? mustInclude : fallbackMustInclude(params, index),
    cliffhanger: asText(raw?.cliffhanger, index === params.totalChapters ? "Dư âm kết cục phản chiếu lựa chọn của nhân vật." : "Một hậu quả mới buộc nhân vật phải bước tiếp."),
    targetWords: Number(raw?.targetWords) > 0 ? Number(raw?.targetWords) : params.length,
    pacing: (["Chậm", "Trung bình", "Nhanh", "Cao trào"].includes(raw?.pacing) ? raw?.pacing : pacingForChapter(index, params.totalChapters)) as Chapter["pacing"],
  };
};

const normalizeVolumes = (raw: AnyRecord, params: StoryParams): Volume[] => {
  const totalChapters = clamp(Math.round(params.totalChapters || 1), 1, 1000);
  const rawVolumes = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.volumes)
    ? raw.volumes
    : raw?.firstVolume
      ? [raw.firstVolume]
      : [];
  const volumeTarget = desiredVolumeCount(totalChapters);
  const volumeCount = clamp(Math.max(rawVolumes.length, volumeTarget), 1, Math.min(totalChapters, 30));
  const ranges = buildRanges(volumeCount, totalChapters, params, rawVolumes);
  const directionTitle = directionTitleFromLock(params);

  return ranges.map((range, volumeOffset) => {
    const rawVolume = rawVolumes[volumeOffset] || {};
    const index = volumeOffset + 1;
    const title = asText(rawVolume.title, index === 1 ? "Khai cục" : `Arc ${index}`);
    const arcSize = range.end - range.start + 1;
    const averageArcSize = totalChapters / Math.max(1, ranges.length);
    const lengthShape = arcSize >= averageArcSize * 1.28
      ? "Arc trọng tâm dài"
      : arcSize <= averageArcSize * 0.78
        ? "Arc cầu nối ngắn"
        : "Arc nhịp vừa";
    const arcRole = arcNarrativeRole(volumeOffset, ranges.length);
    const rawChapters = Array.isArray(rawVolume.chapters) ? rawVolume.chapters : [];
    const chapters = rawChapters
      .filter((chapter: AnyRecord) => {
        const chapterIndex = Number(chapter?.index);
        return chapterIndex >= range.start && chapterIndex <= range.end;
      })
      .map((chapter: AnyRecord) => normalizeChapter(chapter, Number(chapter.index), params, title));

    return {
      index,
      title,
      summary: asText(rawVolume.summary, `Arc ${index} phụ trách chương ${range.start}-${range.end}: ${arcRole}`),
      purpose: asText(rawVolume.purpose, `${lengthShape}: dùng ${arcSize} chương để ${arcRole}${directionTitle ? `, phục vụ hướng "${directionTitle}"` : ""}.`),
      chapterStart: range.start,
      chapterEnd: range.end,
      chapters,
    };
  });
};

const normalizeChapterPlans = (
  raw: AnyRecord,
  params: StoryParams,
  volume: Volume | { title: string; chapterStart?: number; chapterEnd?: number },
): Chapter[] => {
  const start = clamp(Math.round(Number(volume.chapterStart) || 1), 1, 1000);
  const end = clamp(Math.round(Number(volume.chapterEnd) || start), start, 1000);
  const rawChapters = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.chapters)
      ? raw.chapters
      : [];

  return Array.from({ length: end - start + 1 }, (_, offset) => {
    const chapterIndex = start + offset;
    const rawChapter = rawChapters.find((chapter: AnyRecord) => Number(chapter?.index) === chapterIndex) || rawChapters[offset];
    return normalizeChapter(rawChapter, chapterIndex, params, volume.title || `Arc ${chapterIndex}`);
  });
};

const buildEmergencyChapterDraft = (
  params: StoryParams,
  chapterIndex: number,
  currentArc: Volume | { title: string; summary: string; chapters?: Chapter[]; purpose?: string },
  chapterPlan: Chapter | undefined,
  userIdea: string,
  minWords: number,
) => {
  const handle = protagonistHandleForDraft(
    params,
    `${userIdea} ${currentArc.summary} ${chapterPlan?.summary || ""} ${chapterPlan?.objective || ""}`,
  );
  const characterName = handle.label;
  const pronoun = handle.pronoun;
  const sentencePronoun = pronoun.charAt(0).toUpperCase() + pronoun.slice(1);
  const title = chapterPlan?.title || `Chương ${chapterIndex}`;
  const objective = chapterPlan?.objective || chapterPlan?.summary || currentArc.summary || "đẩy câu chuyện tiến lên bằng một lựa chọn có hậu quả";
  const beats = (chapterPlan?.beats?.length ? chapterPlan.beats : fallbackBeats(chapterIndex, params.totalChapters, currentArc.title)).slice(0, 4);
  const mustInclude = (chapterPlan?.mustInclude?.length ? chapterPlan.mustInclude : fallbackMustInclude(params, chapterIndex)).slice(0, 4);
  const storyHint = userIdea || params.seed || "mạch truyện đã khởi tạo";
  const paragraphs = [
    `Tên chương: ${title}`,
    `${characterName} bị đặt vào phần việc của mình trong ${currentArc.title} với cảm giác mọi thứ đã lệch đi một nấc rất nhỏ. Điều cần làm không còn là nghĩ xem chuyện nào đáng tin, mà là chọn một hành động đủ cụ thể để kiểm chứng ${objective}. ${sentencePronoun} giữ lại những chi tiết đã được khóa trong Thiên Cơ Lục, không vội đặt thêm con số mới, cũng không tự ý mở một bí mật ngoài đường dây đang có.`,
  ];
  const templates = [
    (beat: string, detail: string) => `${beat}. Cảnh này được kéo xuống mặt đất bằng một việc nhìn thấy được: ${characterName} quan sát, đối chiếu rồi buộc phải phản ứng trước ${detail}. Mỗi lời nói trong cảnh đều có mục đích, hoặc che giấu, hoặc thử lòng, hoặc đẩy nhân vật tiến gần hơn đến hậu quả cuối chương.`,
    (beat: string, detail: string) => `Khi ${detail} hiện ra rõ hơn, ${characterName} không thắng bằng may mắn. ${sentencePronoun} phải đổi một thứ đang có lấy một manh mối nhỏ, và chính lựa chọn ấy khiến ${beat.toLowerCase()} trở thành biến chuyển không thể đảo ngược của chương.`,
    (beat: string, detail: string) => `Nhịp truyện chậm lại đủ để người đọc thấy áp lực bên trong nhân vật. ${characterName} không cần một hồi tưởng dài; ${pronoun} chỉ giữ lại một dấu hiệu ngắn rồi quay về hiện tại, nơi ${detail} đang buộc ${pronoun} xử lý ${beat.toLowerCase()}.`,
    (_beat: string, detail: string) => `Đến cuối cảnh, ${detail} không còn là thông tin rời rạc. Nó trở thành bằng chứng, món nợ hoặc lời cảnh báo. Tình thế buộc ${characterName} bước tiếp: nếu đứng yên, toàn bộ ${storyHint} sẽ đứt mạch; nếu đi tiếp, cái giá phải trả bắt đầu hiện hình.`,
  ];

  let cursor = 0;
  while (countWords(paragraphs.join("\n\n")) < minWords && cursor < 48) {
    const beat = beats[cursor % beats.length] || objective;
    const detail = mustInclude[cursor % mustInclude.length] || "một dữ kiện đã khóa";
    paragraphs.push(templates[cursor % templates.length](beat, detail));
    cursor++;
  }

  paragraphs.push(`Chương khép lại ở một điểm chưa giải quyết hết. ${characterName} đã bị đẩy sang một hướng đi mới, nhưng cái giá của lựa chọn vừa rồi bắt đầu lộ ra, đủ để kéo thẳng sang chương kế tiếp mà không phá kết cục toàn truyện.`);
  return paragraphs.join("\n\n");
};

const normalizeLogicReport = (raw: AnyRecord): StoryLogicReport => ({
  score: clamp(Number(raw?.score) || 0, 0, 100),
  summary: asText(raw?.summary, "Chưa có nhận xét tổng quát."),
  issues: Array.isArray(raw?.issues)
    ? raw.issues.map((issue: AnyRecord) => ({
        severity: (["Cao", "Vừa", "Nhẹ"].includes(issue?.severity) ? issue.severity : "Vừa") as "Cao" | "Vừa" | "Nhẹ",
        chapter: Number(issue?.chapter) || undefined,
        issue: asText(issue?.issue, "Vấn đề chưa mô tả."),
        fix: asText(issue?.fix, "Cần biên tập lại để bám lộ trình."),
      })).slice(0, 12)
    : [],
  suggestions: asStringArray(raw?.suggestions).slice(0, 8),
  nextChapterFocus: asText(raw?.nextChapterFocus, "Viết chương tiếp theo bám mục tiêu Arc và xử lý các mâu thuẫn đang mở."),
});

const isAIJsonFormatError = (error: unknown) =>
  error instanceof AIJsonParseError || (error instanceof Error && error.message.includes("không đúng định dạng JSON"));

const fallbackTitleFromParams = (params: StoryParams) => {
  const title = (params.seed || `${params.character.name} truyện mới`).trim().replace(/\s+/g, " ");
  return title.length > 42 ? `${title.slice(0, 42)}...` : title;
};

const buildFallbackWorldBuilding = (params: StoryParams, totalChapters: number) => [
  "# TIMELINE",
  "- Chương 1 là mốc mở màn. Mọi mốc thời gian phát sinh sau này phải được ghi lại theo thứ tự.",
  "- Dữ kiện chưa chắc chắn phải ghi \"chưa khóa\".",
  "",
  "# SỐ LIỆU VÀ QUY TẮC",
  `- Lộ trình khóa: ${totalChapters} chương, mục tiêu ${params.length} chữ/chương.`,
  "- Không tự đổi số tuổi, tiền bạc, khoảng cách, cấp bậc, vật phẩm hoặc luật thế giới nếu chưa có nhân quả trong truyện.",
  "",
  "# NHÂN VẬT VÀ QUAN HỆ",
  `- Hồ sơ nhân vật chính: ${params.character.name || "chưa đặt tên quản trị"}; tính cách nền: ${params.character.personality || "chưa khóa tính cách"}.`,
  `- Mục tiêu: ${params.character.goal || "chưa khóa mục tiêu"}.`,
  "",
  "# ĐIỂM NHÌN VÀ TÊN GỌI",
  `- Tên hồ sơ "${params.character.name || "chưa đặt"}" chỉ được dùng trong truyện sau khi có cảnh đặt tên/gọi tên hợp logic.`,
  "- Mỗi cảnh phải khóa: nhân vật đang biết gì, chưa biết gì, có thể nói/làm gì theo tuổi và hoàn cảnh.",
  "",
  "# ĐỊA DANH/VẬT PHẨM/HỆ THỐNG",
  "- Chưa khóa. Mỗi yếu tố mới phải có chức năng trong Arc hiện tại.",
  "",
  "# MÂU THUẪN ĐANG MỞ",
  `- Mâu thuẫn khởi nguồn: ${params.seed || "chưa khóa"}.`,
  "",
  "# ĐIỀU CẤM PHÁ LOGIC",
  "- Không mở tuyến phụ không phục vụ mục tiêu chương hoặc Arc.",
  "- Không kết thúc truyện khi chưa tới chương cuối.",
].join("\n");

const buildFallbackRoadmapData = (params: StoryParams) => {
  const totalChapters = clamp(Math.round(params.totalChapters || 1), 1, 1000);
  const directionTitle = directionTitleFromLock(params);
  return {
    title: fallbackTitleFromParams(params),
    generalSummary: `Đại cục dự phòng: ${params.character.name || "nhân vật chính"} theo đuổi mục tiêu ${params.character.goal || "đã đặt"} qua ${totalChapters} chương${directionTitle ? ` theo hướng "${directionTitle}"` : ""}; mỗi Arc đẩy một tầng nhân quả mới và giữ kết cục theo cấu trúc "${params.mode}".`,
    worldBuilding: buildFallbackWorldBuilding(params, totalChapters),
    volumes: [],
  };
};

const buildFallbackNextArcData = (
  params: StoryParams,
  safeVolumes: Volume[],
  start: number,
  end: number,
) => ({
  index: safeVolumes.length + 1,
  title: `Arc ${safeVolumes.length + 1}`,
  summary: `Đẩy ${params.character.name || "nhân vật chính"} vào một tầng xung đột mới từ chương ${start}-${end}.`,
  purpose: "Mở rộng nhân quả, tăng áp lực và chuẩn bị biến chuyển kế tiếp.",
  chapterStart: start,
  chapterEnd: end,
  chapters: [],
});

export const generateInitialRoadmap = async (params: StoryParams) => {
  const totalChapters = clamp(Math.round(params.totalChapters || 1), 1, 1000);
  const volumeCount = desiredVolumeCount(totalChapters);
  const recommendedRanges = buildRanges(volumeCount, totalChapters, params);
  const arcBudgetGuide = buildArcBudgetGuide(recommendedRanges);
  const prompt = `${buildProjectBrief(params)}

[LUẬT NHẬP VAI VÀ ĐIỂM NHÌN]
${IMMERSIVE_LOGIC_RULES}

YÊU CẦU LẬP LỘ TRÌNH:
- Chỉ tạo Đại cục và khoảng ${volumeCount} Arc, phủ đủ chương 1-${totalChapters}. Chưa viết bản đồ từng chương ở bước này.
- Mỗi Arc phải có chapterStart/chapterEnd rõ ràng, nối tiếp nhau, không trùng, không bỏ sót, không vượt quá ${totalChapters}.
- Không chia đều máy móc. Độ dài Arc phải theo trọng lượng tình tiết: Arc cầu nối ngắn hơn, Arc điều tra/tích lũy/khủng hoảng/cao trào dài hơn, Arc kết chỉ dài nếu cần trả giá và dư âm.
- Khung gợi ý bất đối xứng để cân nhắc:
${arcBudgetGuide}
- Có thể điều chỉnh từng mốc nếu nội dung cần, nhưng tổng vẫn phải đúng ${totalChapters} chương và purpose của mỗi Arc phải nói rõ lý do Arc đó dài/ngắn.
- Nếu "Hướng truyện đã khóa" có nội dung, phải ưu tiên tuyệt đối hướng đó khi đặt Đại cục, nguyên nhân, phản diện, twist và biến chuyển từng Arc.
- Mỗi Arc phải trả lời được: nhân vật muốn gì, lực cản là gì, lựa chọn nào tạo hậu quả, dữ kiện canon nào được khóa thêm.
- Nếu mở đầu nhân vật chưa có tên, chưa có nhận thức, bị bỏ rơi, mất trí nhớ hoặc đang ở trạng thái bất lực, Đại cục phải ghi rõ ai biết gì, ai đặt tên/gọi tên, khi nào nhân vật có thể biết tên/mục tiêu của mình.
- Không được để chapter 1 gọi nhân vật bằng tên hồ sơ nếu trong logic cảnh chưa có người đặt hoặc gọi tên đó.
- Nếu tổng số chương rất dài, chia Arc theo cụm 25-60 chương để sau này sinh bản đồ chương theo từng Arc; không bắt buộc Arc nào cũng bằng nhau.
- Mỗi Arc phải nêu: chức năng trong toàn truyện, xung đột chính, biến chuyển cuối Arc, dữ kiện canon cần giữ.
- General summary nêu rõ mở đầu, trung đoạn, cao trào, kết cục theo mode "${params.mode}" trong tối đa 120 từ.
- World building phải là Thiên Cơ Lục khởi tạo dạng Markdown, tối đa 320 từ, có đủ mục: # TIMELINE, # SỐ LIỆU VÀ QUY TẮC, # NHÂN VẬT VÀ QUAN HỆ, # ĐIỂM NHÌN VÀ TÊN GỌI, # ĐỊA DANH/VẬT PHẨM/HỆ THỐNG, # MÂU THUẪN ĐANG MỞ, # ĐIỀU CẤM PHÁ LOGIC.
- Khóa rõ các dữ kiện định lượng đã có: số chương, mục tiêu chữ, số lượng nhân vật/địa điểm/vật phẩm quan trọng, cấp bậc, thời hạn, khoảng cách. Dữ kiện chưa chắc phải ghi "chưa khóa".
- Không mở tuyến phụ nếu tuyến đó không có chức năng trong Arc hoặc không tạo hậu quả cho chương sau.
- Nếu có truyện mẫu/lưu ý tham chiếu, chỉ học nhịp độ và chất văn, không sao chép tên riêng hay tình tiết.

JSON bắt buộc:
{
  "title": "tên tác phẩm",
  "worldBuilding": "Thiên Cơ Lục khởi tạo dạng markdown với các mục canon bắt buộc",
  "generalSummary": "đại cục toàn truyện",
  "volumes": [
    {
      "index": 1,
      "title": "tên Arc",
      "summary": "tóm tắt Arc",
      "purpose": "chức năng của Arc trong toàn truyện, kèm lý do Arc này cần dài/ngắn",
      "chapterStart": 1,
      "chapterEnd": 40,
      "chapters": []
    }
  ]
}`;
  
  let data: AnyRecord;
  try {
    data = await chatJson(PLAN_MODEL, SYSTEM_INSTRUCTION_ROADMAP, prompt, 0.35, DEFAULT_MAX_OUTPUT_TOKENS);
  } catch (error) {
    if (!isAIJsonFormatError(error)) throw error;
    console.warn("AI trả lộ trình không đúng JSON, dùng lộ trình dự phòng:", error);
    data = buildFallbackRoadmapData(params);
  }
  const volumes = normalizeVolumes(data, params);
  const fallbackWorldBuilding = buildFallbackWorldBuilding(params, totalChapters);
  const worldBuilding = asText(data.worldBuilding, fallbackWorldBuilding);
  return {
    ...data,
    title: asText(data.title, (params.seed || "Tác phẩm mới").slice(0, 40)),
    generalSummary: asText(data.generalSummary, params.seed || "Đại cục chưa rõ."),
    worldBuilding: countWords(worldBuilding) >= 45 ? worldBuilding : fallbackWorldBuilding,
    volumes,
    firstVolume: volumes[0],
  };
};

export const generateNextArc = async (
  params: StoryParams,
  worldBible: string,
  currentVolumes: Volume[],
  writtenChapters: Chapter[],
  generalSummary: string,
) => {
  const safeVolumes = [...currentVolumes].sort((a, b) => a.index - b.index);
  const maxPlannedChapter = Math.max(0, ...safeVolumes.map(volume => volume.chapterEnd || Math.max(0, ...(volume.chapters || []).map(chapter => chapter.index))));
  const start = maxPlannedChapter + 1;
  const remainingInsidePlan = Math.max(0, params.totalChapters - maxPlannedChapter);
  const fallbackArcSize = params.totalChapters >= 80 ? 40 : params.totalChapters >= 20 ? 12 : 6;
  const profileTotal = remainingInsidePlan > 0 ? params.totalChapters : params.totalChapters + fallbackArcSize;
  const profileCount = Math.max(desiredVolumeCount(profileTotal), safeVolumes.length + 1);
  const profileRange = buildRanges(profileCount, profileTotal, params)[safeVolumes.length];
  const profileArcSize = profileRange ? profileRange.end - profileRange.start + 1 : fallbackArcSize;
  const arcSize = remainingInsidePlan > 0
    ? clamp(profileArcSize, 1, remainingInsidePlan)
    : clamp(profileArcSize, 3, params.totalChapters >= 80 ? 70 : 18);
  const end = start + arcSize - 1;
  const history = [...writtenChapters]
    .sort((a, b) => a.index - b.index)
    .slice(-10)
    .map(chapter => `[C.${chapter.index}] ${chapter.title}: ${chapter.summary}`)
    .join("\n");

  const prompt = `${buildProjectBrief(params)}

[LUẬT NHẬP VAI VÀ ĐIỂM NHÌN]
${IMMERSIVE_LOGIC_RULES}

ĐẠI CỤC TRUYỆN:
${generalSummary}

THIÊN CƠ LỤC:
${worldBible}

LỊCH SỬ GẦN NHẤT:
${history || "Chưa có chương đã viết."}

Hãy lập Arc ${safeVolumes.length + 1}, phủ chương ${start}-${end}.
Arc mới phải nối logic với các Arc đã có, có mục tiêu riêng, có chapterStart/chapterEnd rõ ràng, chưa cần bản đồ chương chi tiết.
Viết JSON gọn: summary/purpose tối đa 28 từ, không viết văn xuôi truyện.
Ghi rõ dữ kiện canon cần giữ và hậu quả cuối Arc nối sang Arc sau.
Ghi rõ trạng thái nhận thức/tên gọi của nhân vật ở đầu Arc nếu Arc có đổi tên, đổi tuổi, đổi người chăm sóc, đổi thân phận hoặc mất/khôi phục ký ức.
Không thêm nhân vật, vật phẩm, địa danh, cấp bậc hoặc số liệu mới nếu không ghi rõ chức năng trong Arc và không mâu thuẫn Thiên Cơ Lục.
Trả về JSON của một Volume có index, title, summary, purpose, chapterStart, chapterEnd, chapters: [].`;
  
  let data: AnyRecord;
  try {
    data = await chatJson(PLAN_MODEL, SYSTEM_INSTRUCTION_NEXT_ARC, prompt, 0.35, DEFAULT_MAX_OUTPUT_TOKENS);
  } catch (error) {
    if (!isAIJsonFormatError(error)) throw error;
    console.warn("AI trả Arc mở rộng không đúng JSON, dùng Arc dự phòng:", error);
    data = buildFallbackNextArcData(params, safeVolumes, start, end);
  }
  return {
    index: safeVolumes.length + 1,
    title: asText(data?.title, `Arc ${safeVolumes.length + 1}`),
    summary: asText(data?.summary, `Arc ${safeVolumes.length + 1} tiếp tục mở rộng đại cục.`),
    purpose: asText(data?.purpose, "Mở rộng xung đột, tăng sức ép và chuẩn bị cho bước ngoặt kế tiếp."),
    chapterStart: start,
    chapterEnd: end,
    chapters: [],
  };
};

export const generateChapterPlansForArc = async (
  params: StoryParams,
  worldBible: string,
  generalSummary: string,
  currentArc: Volume,
  writtenChapters: Chapter[],
) => {
  const existingIndexes = (currentArc.chapters || []).map(chapter => chapter.index);
  const start = currentArc.chapterStart || (existingIndexes.length ? Math.min(...existingIndexes) : 1);
  const end = currentArc.chapterEnd || (existingIndexes.length ? Math.max(...existingIndexes) : start);
  const chapterCount = Math.max(1, end - start + 1);
  const nearbyHistory = [...writtenChapters]
    .sort((a, b) => a.index - b.index)
    .filter(chapter => chapter.index >= Math.max(1, start - 5) && chapter.index <= end)
    .map(chapter => `[C.${chapter.index}] ${chapter.title}: ${chapter.summary}`)
    .join("\n");

  const prompt = `${buildProjectBrief(params)}

[LUẬT NHẬP VAI VÀ ĐIỂM NHÌN]
${IMMERSIVE_LOGIC_RULES}

[ĐẠI CỤC]
${generalSummary}

[THIÊN CƠ LỤC]
${worldBible.slice(0, 7000)}

[ARC CẦN LẬP BẢN ĐỒ CHƯƠNG]
- Arc ${currentArc.index}: ${currentArc.title}
- Phạm vi: chương ${start}-${end} (${chapterCount} chương)
- Chức năng Arc: ${currentArc.purpose || currentArc.summary}
- Tóm tắt Arc: ${currentArc.summary}

[CHƯƠNG ĐÃ VIẾT GẦN ARC NÀY]
${nearbyHistory || "Chưa có chương đã viết trong vùng này."}

Hãy lập bản đồ chi tiết cho đúng các chương ${start}-${end}.
Yêu cầu:
- Trả đúng ${chapterCount} chapter object, index liên tục từ ${start} đến ${end}; không thiếu, không trùng.
- Mỗi chương chỉ là kế hoạch, chưa viết văn xuôi.
- Mỗi chương có title, summary, objective, đúng 3 beats dạng cảnh, 2 mustInclude, cliffhanger, targetWords=${params.length}, pacing.
- Mỗi chương phải có một biến chuyển không thể đảo ngược và nối nhân quả với chương liền trước/sau.
- Mỗi chương phải khóa được trạng thái nhập vai: nhân vật hiện bao nhiêu tuổi/giai đoạn nào, đang được gọi bằng tên gì, biết/chưa biết gì, có thể nói/làm gì. Đưa các điểm này vào objective, beats hoặc mustInclude.
- Nếu chương có sự kiện được nhận nuôi/đặt tên/lớn lên/nhớ lại thân phận, beat phải viết rõ cảnh gây ra sự thay đổi đó; không được nhảy cóc.
- Không mở tuyến phụ nếu không phục vụ Arc. Mọi tên riêng/số liệu/luật thế giới phải khớp Thiên Cơ Lục.
- Viết JSON gọn: summary/objective tối đa 18 từ, mỗi beat tối đa 8 từ.

Trả về JSON:
{
  "chapters": [
    {
      "index": ${start},
      "title": "tên chương",
      "summary": "tóm tắt chương",
      "objective": "mục tiêu chương",
      "beats": ["beat 1", "beat 2", "beat 3"],
      "mustInclude": ["chi tiết bắt buộc 1", "chi tiết bắt buộc 2"],
      "cliffhanger": "hậu quả/móc nối",
      "targetWords": ${params.length},
      "pacing": "Chậm | Trung bình | Nhanh | Cao trào"
    }
  ]
}`;

  let data: AnyRecord;
  try {
    data = await chatJson(PLAN_MODEL, SYSTEM_INSTRUCTION_CHAPTER_PLAN, prompt, 0.32, DEFAULT_MAX_OUTPUT_TOKENS);
  } catch (error) {
    if (!isAIJsonFormatError(error)) throw error;
    console.warn("AI trả bản đồ chương không đúng JSON, dùng bản đồ chương dự phòng:", error);
    data = { chapters: [] };
  }
  return {
    ...currentArc,
    chapters: normalizeChapterPlans(data, params, currentArc),
  };
};

export const generateChapterStream = async (
  params: StoryParams,
  allWrittenChapters: Chapter[],
  newIndex: number,
  worldBible: string,
  userIdea: string,
  generalSummary: string,
  currentArc: Volume | { title: string; summary: string; chapters?: Chapter[]; purpose?: string },
  onChunk: (text: string) => void,
  isRetry: boolean = false,
): Promise<string> => {
  const previousChapters = [...allWrittenChapters]
    .filter(chapter => chapter.index !== newIndex)
    .sort((a, b) => a.index - b.index);
  const lastChapter = [...previousChapters].filter(chapter => chapter.index < newIndex).pop() || previousChapters[previousChapters.length - 1];
  const lastContent = lastChapter?.content ? lastChapter.content.slice(-2600) : "Truyện mới bắt đầu.";
  const chapterPlan = currentArc.chapters?.find(chapter => chapter.index === newIndex);
  const targetWords = chapterPlan?.targetWords || params.length || 2000;
  const minWords = minimumChapterWords(targetWords);
  const maxWords = Math.ceil(targetWords * 1.28);
  const history = previousChapters
    .slice(-6)
    .map(chapter => `[C.${chapter.index}] ${chapter.title}: ${chapter.summary}`)
    .join("\n");

  const prompt = `LỆNH CHẤP BÚT CHƯƠNG ${newIndex}
${isRetry ? "\nCHẾ ĐỘ SỬA: Bản trước chưa đạt thẩm định. Hãy viết lại chặt hơn, bám mục tiêu hơn, không rút gọn." : ""}

${buildProjectBrief(params)}

[LUẬT NHỊP VĂN VÀ LOGIC CẢNH]
${PROSE_RHYTHM_RULES}

${SCENE_LOGIC_RULES}

${IMMERSIVE_LOGIC_RULES}

[ĐẠI CỤC]
${generalSummary}

[ARC HIỆN TẠI]
- Tên Arc: ${currentArc.title}
- Mục đích Arc: ${currentArc.purpose || currentArc.summary}
- Tóm tắt Arc: ${currentArc.summary}

[KẾ HOẠCH CHƯƠNG ${newIndex}]
- Tên dự kiến: ${chapterPlan?.title || `Chương ${newIndex}`}
- Tóm tắt: ${chapterPlan?.summary || "Bám lộ trình Arc hiện tại."}
- Mục tiêu chương: ${chapterPlan?.objective || "Tạo một bước tiến rõ ràng cho nhân vật và xung đột."}
- Nhịp độ: ${chapterPlan?.pacing || pacingForChapter(newIndex, params.totalChapters)}
- Các beat phải triển khai thành cảnh: ${(chapterPlan?.beats || []).join(" | ") || "Mở cảnh, tạo va chạm, đẩy lựa chọn, để lại hậu quả."}
- Yếu tố bắt buộc: ${(chapterPlan?.mustInclude || []).join(" | ") || "Giữ đúng nhân vật, đúng thế giới, đúng đại cục."}
- Hook/cuối chương: ${chapterPlan?.cliffhanger || "Kết bằng một hậu quả hoặc câu hỏi đủ mạnh để sang chương sau."}

[THIÊN CƠ LỤC]
${worldBible}

[KHÓA CANON]
- Giữ nguyên tên riêng, số liệu, mốc thời gian, quan hệ, cấp bậc, luật thế giới và vật phẩm đã khóa trong Thiên Cơ Lục.
- Tên hồ sơ của nhân vật chính không tự động là tên được dùng trong cảnh. Nếu nhân vật chưa được đặt/gọi tên trong dòng thời gian, không dùng tên đó trong văn xuôi.
- Mỗi cảnh phải đúng trạng thái nhận thức hiện tại: tuổi, trí nhớ, điều đã biết, điều chưa biết, năng lực cơ thể, quyền lựa chọn và quan hệ với người đang đối thoại.
- Nếu chương buộc phải thêm dữ kiện mới, dữ kiện đó phải xuất hiện tự nhiên trong cảnh và không được phủ định dữ kiện cũ.
- Không mở tuyến phụ ngoài kế hoạch chương/Arc; nếu nhắc tuyến phụ, nó phải tạo hậu quả trực tiếp cho mục tiêu chương.
- Mọi cảnh chính phải bám ít nhất một beat hoặc yếu tố bắt buộc. Cắt bỏ đoạn chỉ giải thích, trang trí hoặc lặp ý.
- Không dùng số liệu tùy tiện. Nếu dữ kiện chưa khóa, diễn đạt thận trọng thay vì tự đặt con số chắc chắn.

[LỊCH SỬ CÁC CHƯƠNG GẦN NHẤT]
${history || "Chưa có."}

[NỐI MẠCH TỪ CHƯƠNG TRƯỚC]
${lastChapter ? `Chương trước: ${lastChapter.title}. ${lastChapter.summary}\nTrích đoạn cuối:\n${lastContent}` : lastContent}

[Ý ĐỒ NGƯỜI DÙNG CHO CHƯƠNG NÀY]
${userIdea || "Không có bổ sung. Hãy phát triển tự nhiên theo lộ trình đã lập."}

YÊU CẦU VIẾT:
- Mục tiêu độ dài: khoảng ${targetWords} chữ. Không được dừng dưới ${minWords} chữ; không vượt quá ${maxWords} chữ nếu không cần để khép cảnh.
- Bắt đầu bằng đúng mẫu: "Tên chương: [tên chương]".
- Sau dòng tên chương, viết văn xuôi liền mạch bằng tiếng Việt.
- Mỗi beat phải được viết thành cảnh có hành động, cảm giác, đối thoại hoặc quyết định cụ thể; không tóm tắt thay cho cảnh.
- Văn phong hiện đại và chuyên nghiệp: mạch lạc, có hơi văn, có nhạc tính vừa đủ, không cộc, không lạm dụng mỹ từ, không giảng đạo, không dùng câu sáo.
- Ưu tiên văn hay: hình ảnh chính xác, nhịp câu biến hóa, đối thoại có hàm ý, ít giải thích trực tiếp; mỗi đoạn phải làm tình thế, cảm xúc hoặc thông tin dịch chuyển.
- Nhân vật chính phải có lựa chọn, sai lầm hoặc trả giá trong chương. Nếu đang là trẻ sơ sinh, bị bỏ rơi, bất tỉnh, mất trí nhớ hoặc chưa đủ năng lực chủ động, lựa chọn có thể thuộc người chăm sóc/đối thủ/tình thế, nhưng hậu quả phải tác động trực tiếp lên nhân vật và đúng điểm nhìn.
- Trước khi viết từng cảnh, tự kiểm tra: nhân vật đang ở đâu, được ai gọi bằng tên gì, biết gì, chưa biết gì, cơ thể làm được gì, vì sao nói/hành động như vậy. Không xuất phần kiểm tra này ra văn bản.
- Mỗi cảnh phải làm rõ mục tiêu, trở ngại, lựa chọn hoặc hậu quả. Không kéo dài hồi tưởng/miêu tả nếu không đổi trạng thái truyện.
- Không mở bí mật, nhiệm vụ, nhân vật, tổ chức hoặc vật phẩm mới nếu nó không phục vụ mục tiêu chương hoặc Arc hiện tại.
- Tên riêng, số lượng, thời gian, cảnh giới, khoảng cách, vật phẩm, quan hệ phải nhất quán với Thiên Cơ Lục.
- Không viết dàn ý, không giải thích rằng bạn đang viết, không dùng markdown.
- Không kết thúc toàn bộ truyện nếu đây chưa phải chương ${params.totalChapters}.
- Nếu chương là phần giữa truyện, cuối chương phải tạo lực kéo sang chương sau.`;

  let fullText = "";
  try {
    fullText = await streamChat(WRITE_MODEL, ACTIVE_WRITER_SYSTEM_INSTRUCTION, prompt, onChunk, 0.78, estimateMaxTokens(targetWords, 3600));
  } catch (error) {
    if (!(error instanceof GeminiRequestError) || !error.message.includes("không trả về nội dung")) throw error;
  }
  if (!fullText.trim()) {
    const emergencyDraft = buildEmergencyChapterDraft(params, newIndex, currentArc, chapterPlan, userIdea, minWords);
    onChunk(emergencyDraft);
    return emergencyDraft;
  }
  let rounds = 0;
  const maxContinuationRounds = targetWords <= 2500 ? 6 : targetWords <= 6000 ? 7 : targetWords <= 12000 ? 9 : 12;

  while (chapterNeedsContinuation(fullText, minWords) && rounds < maxContinuationRounds) {
    rounds++;
    const currentWords = countWords(fullText);
    const remainingWords = Math.max(450, Math.min(1400, minWords - currentWords + 180));
    const continuationPrompt = `Chương ${newIndex} hiện mới khoảng ${countWords(fullText)} chữ, thấp hơn mục tiêu ${targetWords}.
Hãy VIẾT TIẾP ngay từ đoạn cuối khoảng ${remainingWords} chữ, không lặp lại dòng "Tên chương", không tóm tắt, không viết lại từ đầu.
Nếu đoạn cuối đang dở câu hoặc dở cảnh, nối tiếp trực tiếp để hoàn tất câu/cảnh đó trước.
Ưu tiên hoàn tất các beat còn thiếu, làm sâu tâm lý/xung đột, và kết chương bằng một câu hoàn chỉnh có hậu quả hoặc móc nối.
Không mở tuyến phụ mới, không đổi số liệu/timeline, không thêm dữ kiện canon nếu không cần cho beat còn thiếu.
Giữ nguyên điểm nhìn, tên gọi hiện tại, tuổi/nhận thức và trạng thái cơ thể trong đoạn đã có; không đưa tên hồ sơ vào nếu đoạn trước chưa có cảnh đặt hoặc gọi tên.

[KẾ HOẠCH CHƯƠNG]
${chapterPlan?.objective || ""}
${(chapterPlan?.beats || []).map((beat, index) => `${index + 1}. ${beat}`).join("\n")}

[NỘI DUNG ĐÃ CÓ, CHỈ ĐỂ NỐI MẠCH]
${fullText.slice(-3500)}`;

    onChunk("\n\n");
    fullText += "\n\n";
    const continuationText = await streamChat(WRITE_MODEL, ACTIVE_WRITER_SYSTEM_INSTRUCTION, continuationPrompt, onChunk, 0.72, estimateMaxTokens(Math.max(remainingWords, minWords - countWords(fullText)), 1800));
    fullText = appendDraftPart(fullText, continuationText);
  }

  if (isLikelyCutOffText(fullText)) {
    const closingPrompt = `Đoạn cuối chương ${newIndex} đang bị cụt hoặc chưa khép câu.
Hãy viết tiếp 180-320 chữ ngay từ đoạn cuối bên dưới để khép cảnh bằng câu hoàn chỉnh.
Không lặp lại tiêu đề, không tóm tắt, không mở tuyến mới, không đổi dữ kiện canon.
Chỉ nối để khép cảnh; không đổi điểm nhìn, tên gọi, tuổi, timeline hoặc quan hệ.

[ĐOẠN CUỐI ĐỂ NỐI MẠCH]
${fullText.slice(-2200)}`;
    onChunk("\n\n");
    fullText += "\n\n";
    const closingText = await streamChat(WRITE_MODEL, ACTIVE_WRITER_SYSTEM_INSTRUCTION, closingPrompt, onChunk, 0.68, estimateMaxTokens(420, 1200));
    fullText = appendDraftPart(fullText, closingText);
  }

  return normalizeGeneratedDraft(fullText);
};

export const validateChapterLogic = async (
  currentChapterContent: string,
  previousChapters: Chapter[],
  worldBible: string,
  currentArc: Volume | { title: string; summary: string; chapters?: Chapter[]; purpose?: string },
  generalSummary: string,
  params?: StoryParams,
  chapterIndex?: number,
): Promise<{ isValid: boolean; reason?: string }> => {
  const wordCount = countWords(currentChapterContent);
  const targetWords = params?.length || currentArc.chapters?.find(chapter => chapter.index === chapterIndex)?.targetWords;
  const chapterPlan = currentArc.chapters?.find(chapter => chapter.index === chapterIndex);
  if (params?.projectType === "Trường Thiên" && !chapterPlan) {
    return {
      isValid: false,
      reason: `Chưa có bản đồ chi tiết cho chương ${chapterIndex || ""}.`,
    };
  }
  if (params?.projectType === "Trường Thiên" && countWords(worldBible) < 45) {
    return {
      isValid: false,
      reason: "Thiên Cơ Lục quá mỏng, chưa đủ dữ kiện để khóa canon dài kỳ.",
    };
  }
  if (targetWords && wordCount < Math.max(650, targetWords * 0.95)) {
    return {
      isValid: false,
      reason: `Chương quá ngắn so với mục tiêu ${targetWords} chữ, hiện khoảng ${wordCount} chữ.`,
    };
  }
  if (isLikelyCutOffText(currentChapterContent)) {
    return {
      isValid: false,
      reason: "Đoạn cuối chương có dấu hiệu bị cụt câu hoặc chưa khép cảnh.",
    };
  }

  const lastChapter = [...previousChapters]
    .filter(chapter => chapter.index !== chapterIndex)
    .sort((a, b) => b.index - a.index)[0];
  const chapterAuditText = excerptForAudit(currentChapterContent, 12000);
  
  const prompt = `THẨM ĐỊNH CANON, TÍNH NHẤT QUÁN VÀ ĐỘ TẬP TRUNG

[LUẬT NHẬP VAI PHẢI KIỂM]
${IMMERSIVE_LOGIC_RULES}

[KẾ HOẠCH TỔNG THỂ]
${generalSummary}

[ARC HIỆN TẠI]
${currentArc.title}: ${currentArc.summary}

[KẾ HOẠCH CHƯƠNG]
${chapterPlan ? JSON.stringify(chapterPlan, null, 2) : "Không có kế hoạch chi tiết, thẩm định theo Arc."}

[THIÊN CƠ LỤC]
${worldBible.slice(0, 5000)}

[CHƯƠNG TRƯỚC]
${lastChapter ? `${lastChapter.title}: ${lastChapter.summary}` : "Không có."}

[NỘI DUNG CHƯƠNG MỚI]
${chapterAuditText}

CÂU HỎI KIỂM ĐỊNH:
1. Chương có thực hiện đúng mục tiêu và beat chính không?
2. Tên riêng, số liệu, thời gian, khoảng cách, cấp bậc, vật phẩm, địa danh có khớp Thiên Cơ Lục không?
3. Tính cách, mục tiêu, quan hệ nhân vật có đổi vô cớ không?
4. Có mở tuyến phụ, bí mật, nhiệm vụ hoặc nhân vật mới không phục vụ chương/Arc không?
5. Có cảnh nào chỉ lan man giải thích, lặp ý, tả cảnh dài hoặc hồi tưởng mà không đổi trạng thái truyện không?
6. Có lặp tình tiết chương trước mà không tạo biến chuyển mới không?
7. Có kết thúc toàn truyện quá sớm không?
8. Độ dài và nhịp chương có phù hợp mục tiêu không?
9. Tên nhân vật có được dùng đúng thời điểm không? Nếu nhân vật mới sinh/bị bỏ rơi/chưa được đặt tên thì văn bản có gọi sai tên hồ sơ không?
10. Nhân vật có biết điều họ chưa thể biết không: thân phận, mục tiêu, người thân, bí mật, tên riêng, luật thế giới, ký ức chưa xuất hiện?
11. Lời nói/hành động có đúng tuổi, cơ thể, địa vị, quan hệ và tình trạng hiện tại không?
12. Các bước chuyển như được nhận nuôi, đặt tên, lớn lên, đổi thân phận, nhớ lại quá khứ có cảnh nối nhân quả rõ không?

Chỉ chấp nhận nếu chương vừa đúng canon, đúng điểm nhìn, đúng logic nhập vai và tập trung vào mục tiêu chương. Nếu có lỗi tên gọi, tuổi/nhận thức, thông tin nhân vật chưa thể biết, hành động/lời nói vô lý, canon hoặc lan man đáng kể, isValid=false.
Trả về JSON: { "isValid": boolean, "reason": string, "canonIssues": string[], "povIssues": string[], "ramblingIssues": string[], "fixPlan": string }.`;

  try {
    return await chatJson(PLAN_MODEL, EDITOR_SYSTEM_INSTRUCTION, prompt, 0.2, 2500);
  } catch (error) {
    if (!isAIJsonFormatError(error)) throw error;
    console.warn("AI trả thẩm định không đúng JSON, chặn lưu chương để tránh lọt lỗi logic:", error);
    return {
      isValid: false,
      reason: "Không đọc được JSON thẩm định logic; app chưa lưu bản này để tránh lọt lỗi canon, điểm nhìn hoặc tên gọi.",
    };
  }
};

export const reviewStoryLogic = async (
  params: StoryParams,
  volumes: Volume[],
  writtenChapters: Chapter[],
  worldBible: string,
  generalSummary: string,
): Promise<StoryLogicReport> => {
  const plannedChapters = volumes
    .flatMap(volume => (volume.chapters || []).map(chapter => ({
      index: chapter.index,
      arc: volume.title,
      title: chapter.title,
      objective: chapter.objective,
      summary: chapter.summary,
      beats: chapter.beats,
    })))
    .sort((a, b) => a.index - b.index);
  const manuscript = [...writtenChapters]
    .sort((a, b) => a.index - b.index)
    .map(chapter => ({
      index: chapter.index,
      title: chapter.title,
      summary: chapter.summary,
      wordCount: countWords(chapter.content || ""),
      excerptStart: (chapter.content || "").slice(0, 900),
      excerptEnd: (chapter.content || "").slice(-900),
    }));

  const prompt = `${buildProjectBrief(params)}

[LUẬT NHẬP VAI PHẢI KIỂM]
${IMMERSIVE_LOGIC_RULES}

[ĐẠI CỤC]
${generalSummary}

[THIÊN CƠ LỤC]
${worldBible.slice(0, 8000)}

[BẢN ĐỒ CHƯƠNG]
${JSON.stringify(plannedChapters, null, 2)}

[BẢN THẢO ĐÃ VIẾT]
${JSON.stringify(manuscript, null, 2)}

Hãy kiểm tra logic toàn truyện đã viết:
- Có mâu thuẫn thế giới, nhân vật, quan hệ, timeline, số liệu, cấp bậc, vật phẩm hoặc địa danh không?
- Chương nào lệch khỏi kế hoạch chương hoặc Arc?
- Có lặp tình tiết, nhảy cóc, kết thúc quá sớm, mở tuyến phụ rơi rớt hoặc thiếu hậu quả không?
- Có chương nào lan man: nhiều đoạn giải thích/tả/hồi tưởng nhưng không đẩy mục tiêu chương?
- Có dữ kiện nào mới xuất hiện nhưng chưa được Thiên Cơ Lục ghi nhận hoặc mâu thuẫn dữ kiện đã khóa không?
- Có lỗi điểm nhìn/tên gọi không: dùng tên trước khi được đặt, nhân vật biết điều chưa thể biết, trẻ nhỏ nói/hành động quá tuổi, hoặc chuyển trạng thái nhận nuôi/lớn lên/nhớ lại quá khứ không có cảnh nối?
- Chương tiếp theo nên tập trung sửa/đẩy điều gì?

Trả về JSON:
{
  "score": 0-100,
  "summary": "nhận xét tổng quát",
  "issues": [
    { "severity": "Cao | Vừa | Nhẹ", "chapter": 1, "issue": "vấn đề", "fix": "cách sửa" }
  ],
  "suggestions": ["gợi ý biên tập"],
  "nextChapterFocus": "trọng tâm chương tiếp theo"
}`;

  try {
    const data = await chatJson(PLAN_MODEL, EDITOR_SYSTEM_INSTRUCTION, prompt, 0.25, 6000);
    return normalizeLogicReport(data);
  } catch (error) {
    if (!isAIJsonFormatError(error)) throw error;
    console.warn("AI trả báo cáo logic không đúng JSON, dùng báo cáo dự phòng:", error);
    return normalizeLogicReport({
      score: 50,
      summary: "AI trả báo cáo không đúng định dạng. Hãy kiểm tra thủ công các chương gần nhất và thử lại sau.",
      issues: [],
      suggestions: ["Đọc lại Thiên Cơ Lục trước khi viết chương kế tiếp.", "Giữ đúng mục tiêu chương và không mở tuyến phụ mới."],
      nextChapterFocus: "Bám bản đồ chương hiện tại và cập nhật canon sau khi viết.",
    });
  }
};

export const updateWorldBibleAndSummary = async (
  currentBible: string,
  lastChapterContent: string,
  chapterIndex: number,
  generalSummary: string,
  params?: StoryParams,
  currentArc?: Volume | { title: string; summary: string; chapters?: Chapter[]; purpose?: string },
) => {
  const chapterPlan = currentArc?.chapters?.find(chapter => chapter.index === chapterIndex);
  const chapterAuditText = excerptForAudit(lastChapterContent, 12000);
  const prompt = `CẬP NHẬT THIÊN CƠ LỤC SAU CHƯƠNG ${chapterIndex}

[HỒ SƠ TÁC PHẨM]
${params ? buildProjectBrief(params) : "Không có hồ sơ đầy đủ."}

[ĐẠI CỤC TRUYỆN]
${generalSummary}

[ARC VÀ KẾ HOẠCH CHƯƠNG]
${currentArc ? `${currentArc.title}: ${currentArc.summary}` : "Không có Arc."}
${chapterPlan ? JSON.stringify(chapterPlan, null, 2) : ""}

[THIÊN CƠ LỤC HIỆN TẠI]
${currentBible}

[NỘI DUNG CHƯƠNG VỪA VIẾT]
${chapterAuditText}

Hãy cập nhật hồ sơ truyện như một sổ canon dài kỳ:
- Giữ lại dữ kiện cũ quan trọng, nhất là dữ kiện chưa được giải quyết.
- Thêm dữ kiện mới theo đúng mục Markdown, không xóa mâu thuẫn đang mở nếu chương chưa giải quyết.
- Nếu chương phát sinh số liệu/timeline/quan hệ/vật phẩm mới, ghi lại rõ ràng.
- Nếu chương phát sinh hoặc thay đổi tên gọi, người đặt tên, nhận thức, trí nhớ, người chăm sóc, năng lực cơ thể hoặc điều nhân vật biết/chưa biết, ghi vào # ĐIỂM NHÌN VÀ TÊN GỌI.
- Nếu phát hiện nguy cơ lệch canon hoặc lan man, ghi vào # ĐỐI CHIẾU LOGIC.`;

  return chatJson(
    PLAN_MODEL,
    `Nhiệm vụ: rút tên chương, tóm tắt chương, cập nhật Thiên Cơ Lục.
Thiên Cơ Lục phải có các mục Markdown:
# DIỄN TIẾN TRUYỆN
# TIMELINE
# SỐ LIỆU VÀ QUY TẮC
# NHÂN VẬT CHÍNH
# NHÂN VẬT PHỤ VÀ QUAN HỆ
# ĐIỂM NHÌN VÀ TÊN GỌI
# ĐỊA DANH/VẬT PHẨM/HỆ THỐNG
# MÂU THUẪN ĐANG MỞ
# ĐIỀU CẤM PHÁ LOGIC
# ĐỐI CHIẾU LOGIC
Luôn bảo toàn dữ kiện cũ, chỉ sửa khi chương mới thật sự thay đổi canon.
Chỉ trả về JSON hợp lệ:
{
  "chapterTitle": "tên chương",
  "chapterSummary": "tóm tắt chương trong 1-2 câu",
  "updatedBible": "Thiên Cơ Lục markdown đầy đủ các mục trên"
}`,
    prompt,
    0.3,
    6000,
  );
};

export const generateShortStoryStream = async (params: StoryParams, onChunk: (text: string) => void, userIdea = ""): Promise<string> => {
  const targetWords = params.length || 3000;
  const minWords = minimumShortStoryWords(targetWords);
  const maxWords = Math.ceil(targetWords * 1.28);
  const prompt = `${buildProjectBrief(params)}

[LUẬT NHỊP VĂN VÀ LOGIC CẢNH]
${PROSE_RHYTHM_RULES}

${SCENE_LOGIC_RULES}

${IMMERSIVE_LOGIC_RULES}

Hãy viết một truyện ngắn hoàn chỉnh.
Yêu cầu:
- Độ dài mục tiêu: khoảng ${targetWords} chữ. Không được dừng dưới ${minWords} chữ nếu truyện chưa khép cảnh và dư âm; không vượt quá ${maxWords} chữ nếu không cần.
- Có mở truyện, phát triển xung đột, bước ngoặt, cao trào và dư âm.
- Nhân vật chính phải hành động theo tính cách và mục tiêu đã nhập khi đã đủ năng lực chủ động. Nếu mở đầu là trẻ sơ sinh, bị bỏ rơi, bất tỉnh hoặc mất trí nhớ, chỉ viết những phản ứng cơ thể/cảm giác phù hợp; lựa chọn lớn có thể thuộc người trong cảnh và phải tạo hậu quả cho nhân vật chính.
- Tên trong hồ sơ chỉ được dùng trong truyện sau khi có logic đặt tên/gọi tên. Nếu cảnh mở đầu là sơ sinh, bị bỏ rơi, mất trí nhớ hoặc chưa biết thân phận, phải viết đúng trạng thái đó.
- Bám thể loại, tông giọng và mode kết truyện.
- Văn phong hiện đại, chuyên nghiệp: cảnh rõ, thoại tự nhiên, câu văn có lực nhưng không cộc; ngắt đoạn có nhịp, có khoảng lặng, hạn chế sáo ngữ và giải thích trực tiếp.
- Không lan man: mỗi cảnh phải phục vụ xung đột chính, tính cách nhân vật hoặc hậu quả cao trào.
- Giữ nhất quán tên riêng, số liệu, mốc thời gian và luật thế giới đã tự thiết lập trong truyện ngắn.
- Bắt đầu bằng "Tên truyện: [tên]".
- Không dùng markdown, không dàn ý, không giải thích.

[Ý ĐỒ BỔ SUNG CỦA NGƯỜI DÙNG]
${userIdea || "Không có bổ sung."}`;

  let fullText = await streamChat(WRITE_MODEL, ACTIVE_WRITER_SYSTEM_INSTRUCTION, prompt, onChunk, 0.82, estimateMaxTokens(targetWords, 3600));
  let rounds = 0;
  const maxContinuationRounds = targetWords <= 2500 ? 6 : targetWords <= 6000 ? 7 : targetWords <= 12000 ? 9 : 12;

  while (chapterNeedsContinuation(fullText, minWords) && rounds < maxContinuationRounds) {
    rounds++;
    const currentWords = countWords(fullText);
    const remainingWords = Math.max(450, Math.min(1400, minWords - currentWords + 180));
    const continuationPrompt = `Truyện ngắn hiện mới khoảng ${currentWords} chữ, thấp hơn mục tiêu ${targetWords}.
Hãy viết tiếp ngay từ đoạn cuối khoảng ${remainingWords} chữ để hoàn chỉnh xung đột và dư âm, không lặp lại tiêu đề, không tóm tắt.
Nếu đoạn cuối đang dở câu hoặc dở cảnh, nối tiếp trực tiếp để hoàn tất câu/cảnh đó trước.
Giữ đúng điểm nhìn/tên gọi/tuổi/nhận thức đã thiết lập; không đổi tên hoặc cho nhân vật biết điều chưa có nguyên nhân.

[ĐOẠN CUỐI ĐỂ NỐI MẠCH]
${fullText.slice(-3500)}`;
    onChunk("\n\n");
    fullText += "\n\n";
    const continuationText = await streamChat(WRITE_MODEL, ACTIVE_WRITER_SYSTEM_INSTRUCTION, continuationPrompt, onChunk, 0.76, estimateMaxTokens(Math.max(remainingWords, minWords - countWords(fullText)), 1800));
    fullText = appendDraftPart(fullText, continuationText);
  }

  if (isLikelyCutOffText(fullText)) {
    const closingPrompt = `Đoạn cuối truyện đang bị cụt hoặc chưa khép câu.
Hãy viết tiếp 180-320 chữ ngay từ đoạn cuối bên dưới để khép cảnh bằng câu hoàn chỉnh.
Không lặp lại tiêu đề, không tóm tắt, không mở tuyến mới.
Chỉ khép cảnh; không mở tuyến mới, không đổi tên gọi, điểm nhìn, tuổi hoặc dữ kiện canon.

[ĐOẠN CUỐI ĐỂ NỐI MẠCH]
${fullText.slice(-2200)}`;
    onChunk("\n\n");
    fullText += "\n\n";
    const closingText = await streamChat(WRITE_MODEL, ACTIVE_WRITER_SYSTEM_INSTRUCTION, closingPrompt, onChunk, 0.7, estimateMaxTokens(420, 1200));
    fullText = appendDraftPart(fullText, closingText);
  }

  return normalizeGeneratedDraft(fullText);
};
