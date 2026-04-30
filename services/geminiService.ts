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
5. Mọi dữ kiện chưa chắc phải ghi "chưa khóa"; không bịa số liệu mơ hồ để lấp chỗ trống.
6. Không viết văn xuôi truyện ở bước này. Chỉ trả về JSON hợp lệ.`;

const SYSTEM_INSTRUCTION_NEXT_ARC = `Bạn là biên kịch trưởng đang mở rộng một truyện dài đã có hồ sơ.
Dựa vào Thiên Cơ Lục, đại cục và lịch sử chương, hãy tạo Arc kế tiếp sao cho không phá logic cũ, không lặp tình tiết và vẫn đẩy tác phẩm tới kết cục đã chọn.
Không được đổi số liệu, timeline, quan hệ, luật thế giới, vật phẩm hoặc cấp bậc đã khóa nếu không có lý do nhân quả rõ trong truyện.
Chỉ trả về JSON hợp lệ.`;

const SYSTEM_INSTRUCTION_CHAPTER_PLAN = `Bạn là biên kịch trưởng chuyên lập bản đồ chương cho một Arc đã khóa.
Nhiệm vụ:
1. Chia đúng phạm vi chương được giao thành các kế hoạch chương liên tục, không thiếu, không trùng.
2. Mỗi chương phải có mục tiêu, chức năng trong Arc, 3 beat dạng cảnh, 2 chi tiết bắt buộc, nhịp độ và móc nối.
3. Bám Thiên Cơ Lục tuyệt đối: không đổi tên riêng, số liệu, timeline, quan hệ, cấp bậc, vật phẩm hoặc luật thế giới.
4. Không viết văn xuôi truyện ở bước này. Chỉ trả về JSON hợp lệ.`;

const WRITER_SYSTEM_INSTRUCTION = `Bạn là tiểu thuyết gia tiếng Việt có tư duy biên kịch chặt chẽ.
Luôn viết thành văn xuôi hoàn chỉnh, giàu cảnh, giàu hành động cụ thể, giàu tâm lý nhân vật.
Bạn phải bám lộ trình chương, giữ đúng tính cách và mục tiêu nhân vật, không nhảy cóc, không tóm tắt thay cho cảnh, không dùng markdown, không gạch đầu dòng.
Khóa canon tuyệt đối:
- Mọi tên riêng, số liệu, mốc thời gian, cấp bậc, quan hệ, vật phẩm và luật thế giới phải lấy từ Thiên Cơ Lục, Đại cục, Arc và kế hoạch chương.
- Không tự ý đổi tuổi, số lượng, thời hạn, khoảng cách, tài nguyên, cảnh giới, chức vụ hoặc quan hệ nếu chưa có nguyên nhân và hậu quả trong cảnh.
- Nếu cần thêm dữ kiện mới, phải đưa vào bằng hành động/đối thoại cụ thể và không mâu thuẫn dữ kiện cũ.
- Không lan man: mỗi đoạn phải phục vụ ít nhất một việc: đẩy mục tiêu chương, bộc lộ nhân vật, tạo hậu quả, hoặc chuẩn bị xung đột kế tiếp.`;

const EDITOR_SYSTEM_INSTRUCTION = `Bạn là biên tập viên tuyến truyện khó tính.
Chỉ chấp nhận chương nếu nó bám đúng đại cục, đúng Arc, đúng mục tiêu chương, không phá logic nhân vật, không lặp chương cũ và không kết thúc sớm khi chưa tới chương cuối.
Thẩm định bắt buộc cả timeline, số liệu, tên riêng, quan hệ, cấp bậc/quy tắc thế giới, vật phẩm, khoảng cách, mục tiêu chương, nhịp độ và mức lan man.`;

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

let keyCursor = 0;
const keyCooldownUntil = new Map<number, number>();

const countWords = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

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

const estimateMaxTokens = (targetWords: number, floor = 900) => capOutputTokens(clamp(Math.ceil(targetWords * 1.55), floor, 32000));

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

const parseAIResponse = (text: string) => {
  try {
    const withoutFence = text.replace(/```json|```/gi, "").trim();
    const jsonMatch = withoutFence.match(/\{[\s\S]*\}/);
    const cleanJson = (jsonMatch ? jsonMatch[0] : withoutFence)
      .replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(cleanJson);
  } catch (e) {
    console.error("Lỗi parse JSON:", e, text);
    throw new Error("Dữ liệu từ AI không đúng định dạng JSON.");
  }
};

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

    const content = (data?.candidates?.[0]?.content?.parts || [])
      .map((part: AnyRecord) => part.text || "")
      .join("");
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

  const content = (data?.candidates?.[0]?.content?.parts || [])
    .map((part: AnyRecord) => part.text || "")
    .join("");
  if (!content) {
    const blockReason = data?.promptFeedback?.blockReason;
    throw new GeminiRequestError(blockReason ? `Gemini chặn prompt: ${blockReason}` : "Gemini không trả về nội dung.", response.status, keyIndex, true);
  }

  return parseAIResponse(content);
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

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const event of events) {
      const dataLines = event
        .split("\n")
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

        const content = (payload?.candidates?.[0]?.content?.parts || [])
          .map((part: AnyRecord) => part.text || "")
          .join("");
        if (content) {
          const cleaned = cleanStoryText(content);
          emittedAnyToken = true;
          fullText += cleaned;
          onChunk(cleaned);
        }
      }
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

const buildRanges = (volumeCount: number, totalChapters: number) => {
  const count = clamp(volumeCount, 1, Math.max(1, totalChapters));
  const base = Math.floor(totalChapters / count);
  const remainder = totalChapters % count;
  let cursor = 1;

  return Array.from({ length: count }, (_, index) => {
    const size = base + (index < remainder ? 1 : 0);
    const start = cursor;
    const end = cursor + size - 1;
    cursor = end + 1;
    return { start, end };
  });
};

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

  return (Object.keys(params.sliders) as Array<keyof StoryParams["sliders"]>)
    .map(key => `${labels[key]} ${params.sliders[key]}/100`)
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
- Giới tính/định danh: ${params.character.gender}
- Tính cách: ${params.character.personality || "Chưa mô tả"}
- Mục tiêu nhân vật: ${params.character.goal || "Chưa mô tả"}
- Tỷ trọng nội dung: ${sliderBrief(params)}
- Ý tưởng khởi nguồn: ${params.seed || "Chưa có"}
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
  const rawVolumes = Array.isArray(raw?.volumes)
    ? raw.volumes
    : raw?.firstVolume
      ? [raw.firstVolume]
      : [];
  const volumeTarget = desiredVolumeCount(totalChapters);
  const volumeCount = clamp(Math.max(rawVolumes.length, volumeTarget), 1, Math.min(totalChapters, 30));
  const ranges = buildRanges(volumeCount, totalChapters);

  return ranges.map((range, volumeOffset) => {
    const rawVolume = rawVolumes[volumeOffset] || {};
    const index = volumeOffset + 1;
    const title = asText(rawVolume.title, index === 1 ? "Khai cục" : `Arc ${index}`);
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
      summary: asText(rawVolume.summary, `Arc ${index} phụ trách các chương ${range.start}-${range.end}.`),
      purpose: asText(rawVolume.purpose, "Đẩy nhân vật chính qua một tầng xung đột mới trong đại cục."),
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
  const rawChapters = Array.isArray(raw?.chapters) ? raw.chapters : [];

  return Array.from({ length: end - start + 1 }, (_, offset) => {
    const chapterIndex = start + offset;
    const rawChapter = rawChapters.find((chapter: AnyRecord) => Number(chapter?.index) === chapterIndex) || rawChapters[offset];
    return normalizeChapter(rawChapter, chapterIndex, params, volume.title || `Arc ${chapterIndex}`);
  });
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

export const generateInitialRoadmap = async (params: StoryParams) => {
  const totalChapters = clamp(Math.round(params.totalChapters || 1), 1, 1000);
  const volumeCount = desiredVolumeCount(totalChapters);
  const prompt = `${buildProjectBrief(params)}

YÊU CẦU LẬP LỘ TRÌNH:
- Chỉ tạo Đại cục và khoảng ${volumeCount} Arc, phủ đủ chương 1-${totalChapters}. Chưa viết bản đồ từng chương ở bước này.
- Mỗi Arc phải có chapterStart/chapterEnd rõ ràng, nối tiếp nhau, không trùng, không bỏ sót, không vượt quá ${totalChapters}.
- Nếu tổng số chương rất dài, chia Arc theo cụm 25-50 chương để sau này sinh bản đồ chương theo từng Arc.
- Mỗi Arc phải nêu: chức năng trong toàn truyện, xung đột chính, biến chuyển cuối Arc, dữ kiện canon cần giữ.
- General summary nêu rõ mở đầu, trung đoạn, cao trào, kết cục theo mode "${params.mode}" trong tối đa 120 từ.
- World building phải là Thiên Cơ Lục khởi tạo dạng Markdown, tối đa 260 từ, có đủ mục: # TIMELINE, # SỐ LIỆU VÀ QUY TẮC, # NHÂN VẬT VÀ QUAN HỆ, # ĐỊA DANH/VẬT PHẨM/HỆ THỐNG, # MÂU THUẪN ĐANG MỞ, # ĐIỀU CẤM PHÁ LOGIC.
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
      "purpose": "chức năng của Arc trong toàn truyện",
      "chapterStart": 1,
      "chapterEnd": 40,
      "chapters": []
    }
  ]
}`;
  
  const data = await chatJson(PLAN_MODEL, SYSTEM_INSTRUCTION_ROADMAP, prompt, 0.35, DEFAULT_MAX_OUTPUT_TOKENS);
  const volumes = normalizeVolumes(data, params);
  return {
    ...data,
    title: asText(data.title, (params.seed || "Tác phẩm mới").slice(0, 40)),
    generalSummary: asText(data.generalSummary, params.seed || "Đại cục chưa rõ."),
    worldBuilding: asText(data.worldBuilding, "Thiên Cơ Lục đang thành hình."),
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
  const arcSize = remainingInsidePlan > 0 ? clamp(remainingInsidePlan, 1, 8) : 6;
  const end = start + arcSize - 1;
  const history = [...writtenChapters]
    .sort((a, b) => a.index - b.index)
    .slice(-10)
    .map(chapter => `[C.${chapter.index}] ${chapter.title}: ${chapter.summary}`)
    .join("\n");

  const prompt = `${buildProjectBrief(params)}

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
Không thêm nhân vật, vật phẩm, địa danh, cấp bậc hoặc số liệu mới nếu không ghi rõ chức năng trong Arc và không mâu thuẫn Thiên Cơ Lục.
Trả về JSON của một Volume có index, title, summary, purpose, chapterStart, chapterEnd, chapters: [].`;
  
  const data = await chatJson(PLAN_MODEL, SYSTEM_INSTRUCTION_NEXT_ARC, prompt, 0.35, DEFAULT_MAX_OUTPUT_TOKENS);
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

  const data = await chatJson(PLAN_MODEL, SYSTEM_INSTRUCTION_CHAPTER_PLAN, prompt, 0.32, DEFAULT_MAX_OUTPUT_TOKENS);
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
  const minWords = Math.max(450, Math.floor(targetWords * 0.78));
  const maxWords = Math.ceil(targetWords * 1.18);
  const history = previousChapters
    .slice(-6)
    .map(chapter => `[C.${chapter.index}] ${chapter.title}: ${chapter.summary}`)
    .join("\n");

  const prompt = `LỆNH CHẤP BÚT CHƯƠNG ${newIndex}
${isRetry ? "\nCHẾ ĐỘ SỬA: Bản trước chưa đạt thẩm định. Hãy viết lại chặt hơn, bám mục tiêu hơn, không rút gọn." : ""}

${buildProjectBrief(params)}

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
- Mục tiêu độ dài: khoảng ${targetWords} chữ, chấp nhận ${minWords}-${maxWords} chữ.
- Bắt đầu bằng đúng mẫu: "Tên chương: [tên chương]".
- Sau dòng tên chương, viết văn xuôi liền mạch bằng tiếng Việt.
- Mỗi beat phải được viết thành cảnh có hành động, cảm giác, đối thoại hoặc quyết định cụ thể; không tóm tắt thay cho cảnh.
- Ưu tiên văn hay: hình ảnh chính xác, nhịp câu biến hóa, đối thoại có hàm ý, ít giải thích trực tiếp.
- Nhân vật chính phải chủ động lựa chọn, sai lầm hoặc trả giá trong chương.
- Mỗi cảnh phải làm rõ mục tiêu, trở ngại, lựa chọn hoặc hậu quả. Không kéo dài hồi tưởng/miêu tả nếu không đổi trạng thái truyện.
- Không mở bí mật, nhiệm vụ, nhân vật, tổ chức hoặc vật phẩm mới nếu nó không phục vụ mục tiêu chương hoặc Arc hiện tại.
- Tên riêng, số lượng, thời gian, cảnh giới, khoảng cách, vật phẩm, quan hệ phải nhất quán với Thiên Cơ Lục.
- Không viết dàn ý, không giải thích rằng bạn đang viết, không dùng markdown.
- Không kết thúc toàn bộ truyện nếu đây chưa phải chương ${params.totalChapters}.
- Nếu chương là phần giữa truyện, cuối chương phải tạo lực kéo sang chương sau.`;

  let fullText = await streamChat(WRITE_MODEL, WRITER_SYSTEM_INSTRUCTION, prompt, onChunk, 0.78, estimateMaxTokens(targetWords, 2000));
  let rounds = 0;
  const maxContinuationRounds = targetWords <= 2500 ? 1 : targetWords <= 6000 ? 2 : 3;

  while (countWords(fullText) < minWords && rounds < maxContinuationRounds) {
    rounds++;
    const continuationPrompt = `Chương ${newIndex} hiện mới khoảng ${countWords(fullText)} chữ, thấp hơn mục tiêu ${targetWords}.
Hãy VIẾT TIẾP ngay từ đoạn cuối, không lặp lại dòng "Tên chương", không tóm tắt, không viết lại từ đầu.
Ưu tiên hoàn tất các beat còn thiếu và làm sâu tâm lý/xung đột.
Không mở tuyến phụ mới, không đổi số liệu/timeline, không thêm dữ kiện canon nếu không cần cho beat còn thiếu.

[KẾ HOẠCH CHƯƠNG]
${chapterPlan?.objective || ""}
${(chapterPlan?.beats || []).map((beat, index) => `${index + 1}. ${beat}`).join("\n")}

[NỘI DUNG ĐÃ CÓ, CHỈ ĐỂ NỐI MẠCH]
${fullText.slice(-3500)}`;

    onChunk("\n\n");
    fullText += "\n\n";
    fullText += await streamChat(WRITE_MODEL, WRITER_SYSTEM_INSTRUCTION, continuationPrompt, onChunk, 0.72, estimateMaxTokens(Math.max(800, targetWords - countWords(fullText)), 1200));
  }

  return fullText;
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
  if (targetWords && wordCount < Math.max(350, targetWords * 0.62)) {
    return {
      isValid: false,
      reason: `Chương quá ngắn so với mục tiêu ${targetWords} chữ, hiện khoảng ${wordCount} chữ.`,
    };
  }

  const lastChapter = [...previousChapters]
    .filter(chapter => chapter.index !== chapterIndex)
    .sort((a, b) => b.index - a.index)[0];
  
  const prompt = `THẨM ĐỊNH CANON, TÍNH NHẤT QUÁN VÀ ĐỘ TẬP TRUNG

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
${currentChapterContent.slice(0, 6500)}

CÂU HỎI KIỂM ĐỊNH:
1. Chương có thực hiện đúng mục tiêu và beat chính không?
2. Tên riêng, số liệu, thời gian, khoảng cách, cấp bậc, vật phẩm, địa danh có khớp Thiên Cơ Lục không?
3. Tính cách, mục tiêu, quan hệ nhân vật có đổi vô cớ không?
4. Có mở tuyến phụ, bí mật, nhiệm vụ hoặc nhân vật mới không phục vụ chương/Arc không?
5. Có cảnh nào chỉ lan man giải thích, lặp ý, tả cảnh dài hoặc hồi tưởng mà không đổi trạng thái truyện không?
6. Có lặp tình tiết chương trước mà không tạo biến chuyển mới không?
7. Có kết thúc toàn truyện quá sớm không?
8. Độ dài và nhịp chương có phù hợp mục tiêu không?

Chỉ chấp nhận nếu chương vừa đúng canon vừa tập trung vào mục tiêu chương. Nếu có lỗi canon hoặc lan man đáng kể, isValid=false.
Trả về JSON: { "isValid": boolean, "reason": string, "canonIssues": string[], "ramblingIssues": string[], "fixPlan": string }.`;

  return chatJson(PLAN_MODEL, EDITOR_SYSTEM_INSTRUCTION, prompt, 0.2, 2500);
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

  const data = await chatJson(PLAN_MODEL, EDITOR_SYSTEM_INSTRUCTION, prompt, 0.25, 6000);
  return normalizeLogicReport(data);
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
${lastChapterContent.slice(0, 7500)}

Hãy cập nhật hồ sơ truyện như một sổ canon dài kỳ:
- Giữ lại dữ kiện cũ quan trọng, nhất là dữ kiện chưa được giải quyết.
- Thêm dữ kiện mới theo đúng mục Markdown, không xóa mâu thuẫn đang mở nếu chương chưa giải quyết.
- Nếu chương phát sinh số liệu/timeline/quan hệ/vật phẩm mới, ghi lại rõ ràng.
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

export const generateShortStoryStream = async (params: StoryParams, onChunk: (text: string) => void): Promise<string> => {
  const targetWords = params.length || 3000;
  const minWords = Math.max(600, Math.floor(targetWords * 0.72));
  const maxWords = Math.ceil(targetWords * 1.2);
  const prompt = `${buildProjectBrief(params)}

Hãy viết một truyện ngắn hoàn chỉnh.
Yêu cầu:
- Độ dài mục tiêu: khoảng ${targetWords} chữ, chấp nhận ${minWords}-${maxWords} chữ.
- Có mở truyện, phát triển xung đột, bước ngoặt, cao trào và dư âm.
- Nhân vật chính phải hành động theo tính cách và mục tiêu đã nhập.
- Bám thể loại, tông giọng và mode kết truyện.
- Không lan man: mỗi cảnh phải phục vụ xung đột chính, tính cách nhân vật hoặc hậu quả cao trào.
- Giữ nhất quán tên riêng, số liệu, mốc thời gian và luật thế giới đã tự thiết lập trong truyện ngắn.
- Bắt đầu bằng "Tên truyện: [tên]".
- Không dùng markdown, không dàn ý, không giải thích.`;

  let fullText = await streamChat(WRITE_MODEL, WRITER_SYSTEM_INSTRUCTION, prompt, onChunk, 0.82, estimateMaxTokens(targetWords, 2000));
  let rounds = 0;

  while (countWords(fullText) < minWords && rounds < 2) {
    rounds++;
    const continuationPrompt = `Truyện ngắn hiện mới khoảng ${countWords(fullText)} chữ, thấp hơn mục tiêu ${targetWords}.
Hãy viết tiếp ngay từ đoạn cuối để hoàn chỉnh xung đột và dư âm, không lặp lại tiêu đề, không tóm tắt.

[ĐOẠN CUỐI ĐỂ NỐI MẠCH]
${fullText.slice(-3500)}`;
    onChunk("\n\n");
    fullText += "\n\n";
    fullText += await streamChat(WRITE_MODEL, WRITER_SYSTEM_INSTRUCTION, continuationPrompt, onChunk, 0.76, estimateMaxTokens(Math.max(800, targetWords - countWords(fullText)), 1200));
  }

  return fullText;
};
