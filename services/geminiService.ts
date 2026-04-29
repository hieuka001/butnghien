import { StoryParams, Chapter, Volume, StoryLogicReport } from "../types";

type AnyRecord = Record<string, any>;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const PLAN_MODEL = process.env.GEMINI_PLAN_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
const WRITE_MODEL = process.env.GEMINI_WRITE_MODEL || process.env.GEMINI_MODEL || "gemini-2.5-flash";
const DEFAULT_MAX_OUTPUT_TOKENS = clamp(Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 8192, 512, 65536);
const USE_GEMINI_PROXY = process.env.GEMINI_SERVER_PROXY === "true";

const SYSTEM_INSTRUCTION_ROADMAP = `Bạn là một biên kịch trưởng chuyên thiết kế truyện dài theo cấu trúc chương.
Nhiệm vụ bắt buộc:
1. Biến dữ liệu đầu vào thành hồ sơ tác phẩm có nhân quả rõ ràng.
2. Lập lộ trình đủ từ chương 1 đến chương cuối, chia thành các Arc hợp lý.
3. Mỗi chương phải có mục tiêu, chức năng trong Arc, các beat cần viết và yếu tố bắt buộc.
4. Không viết văn xuôi truyện ở bước này. Chỉ trả về JSON hợp lệ.`;

const SYSTEM_INSTRUCTION_NEXT_ARC = `Bạn là biên kịch trưởng đang mở rộng một truyện dài đã có hồ sơ.
Dựa vào Thiên Cơ Lục, đại cục và lịch sử chương, hãy tạo Arc kế tiếp sao cho không phá logic cũ, không lặp tình tiết và vẫn đẩy tác phẩm tới kết cục đã chọn.
Chỉ trả về JSON hợp lệ.`;

const WRITER_SYSTEM_INSTRUCTION = `Bạn là tiểu thuyết gia tiếng Việt có tư duy biên kịch chặt chẽ.
Luôn viết thành văn xuôi hoàn chỉnh, giàu cảnh, giàu hành động cụ thể, giàu tâm lý nhân vật.
Bạn phải bám lộ trình chương, giữ đúng tính cách và mục tiêu nhân vật, không nhảy cóc, không tóm tắt thay cho cảnh, không dùng markdown, không gạch đầu dòng.`;

const EDITOR_SYSTEM_INSTRUCTION = `Bạn là biên tập viên tuyến truyện khó tính.
Chỉ chấp nhận chương nếu nó bám đúng đại cục, đúng Arc, đúng mục tiêu chương, không phá logic nhân vật, không lặp chương cũ và không kết thúc sớm khi chưa tới chương cuối.`;

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
  return clamp(Math.ceil(totalChapters / 8), 3, 8);
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
  const totalChapters = clamp(Math.round(params.totalChapters || 1), 1, 300);
  const rawVolumes = Array.isArray(raw?.volumes)
    ? raw.volumes
    : raw?.firstVolume
      ? [raw.firstVolume]
      : [];
  const allRawChapters = rawVolumes.flatMap((volume: AnyRecord) => Array.isArray(volume?.chapters) ? volume.chapters : []);
  const volumeCount = clamp(Math.max(rawVolumes.length, desiredVolumeCount(totalChapters)), 1, totalChapters);
  const ranges = buildRanges(volumeCount, totalChapters);

  return ranges.map((range, volumeOffset) => {
    const rawVolume = rawVolumes[volumeOffset] || {};
    const index = volumeOffset + 1;
    const title = asText(rawVolume.title, index === 1 ? "Khai cục" : `Arc ${index}`);
    const rawChapters = Array.isArray(rawVolume.chapters) ? rawVolume.chapters : [];
    const chapters = Array.from({ length: range.end - range.start + 1 }, (_, chapterOffset) => {
      const chapterIndex = range.start + chapterOffset;
      const rawChapter =
        rawChapters.find((chapter: AnyRecord) => Number(chapter?.index) === chapterIndex) ||
        allRawChapters.find((chapter: AnyRecord) => Number(chapter?.index) === chapterIndex) ||
        rawChapters[chapterOffset];
      return normalizeChapter(rawChapter, chapterIndex, params, title);
    });

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

const normalizeSingleVolume = (raw: AnyRecord, params: StoryParams, index: number, start: number, end: number): Volume => {
  const title = asText(raw?.title, `Arc ${index}`);
  const rawChapters = Array.isArray(raw?.chapters) ? raw.chapters : [];
  const chapters = Array.from({ length: Math.max(1, end - start + 1) }, (_, offset) => {
    const chapterIndex = start + offset;
    const rawChapter = rawChapters.find((chapter: AnyRecord) => Number(chapter?.index) === chapterIndex) || rawChapters[offset];
    return normalizeChapter(rawChapter, chapterIndex, params, title);
  });

  return {
    index,
    title,
    summary: asText(raw?.summary, `Arc ${index} tiếp tục mở rộng đại cục.`),
    purpose: asText(raw?.purpose, "Mở rộng xung đột, tăng sức ép và chuẩn bị cho bước ngoặt kế tiếp."),
    chapterStart: start,
    chapterEnd: end,
    chapters,
  };
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
  const totalChapters = clamp(Math.round(params.totalChapters || 1), 1, 300);
  const volumeCount = desiredVolumeCount(totalChapters);
  const prompt = `${buildProjectBrief(params)}

YÊU CẦU LẬP LỘ TRÌNH:
- Tạo khoảng ${volumeCount} Arc, phủ đủ chương 1-${totalChapters}.
- Bắt buộc trả đúng ${totalChapters} chapter object, index liên tục từ 1 đến ${totalChapters}. Không bỏ sót, không trùng, không vượt quá ${totalChapters}.
- Nếu tổng số chương ngắn, vẫn lập Arc như một khung ba hồi: mở mâu thuẫn, đảo chiều, trả giá/kết.
- Viết JSON thật gọn để tiết kiệm quota: mỗi summary/objective tối đa 18 từ, mỗi beat tối đa 8 từ.
- Mỗi chương phải có: title, summary, objective, đúng 3 beats dạng cảnh, 2 mustInclude, targetWords=${params.length}, pacing.
- Mỗi chương cần có một biến chuyển không thể đảo ngược: thông tin mới, lựa chọn mới, tổn thất mới hoặc quan hệ đổi trạng thái.
- General summary nêu rõ mở đầu, trung đoạn, cao trào, kết cục theo mode "${params.mode}" trong tối đa 120 từ.
- World building có quy luật, giới hạn, rủi ro, bí mật trung tâm và điều cấm phá logic trong tối đa 160 từ.
- Nếu có truyện mẫu/lưu ý tham chiếu, chỉ học nhịp độ và chất văn, không sao chép tên riêng hay tình tiết.

JSON bắt buộc:
{
  "title": "tên tác phẩm",
  "worldBuilding": "markdown ngắn về thế giới và luật logic",
  "generalSummary": "đại cục toàn truyện",
  "volumes": [
    {
      "index": 1,
      "title": "tên Arc",
      "summary": "tóm tắt Arc",
      "purpose": "chức năng của Arc trong toàn truyện",
      "chapterStart": 1,
      "chapterEnd": 8,
      "chapters": [
        {
          "index": 1,
          "title": "tên chương",
          "summary": "tóm tắt chương",
          "objective": "mục tiêu chương",
          "beats": ["beat 1", "beat 2", "beat 3"],
          "mustInclude": ["chi tiết bắt buộc"],
          "cliffhanger": "móc câu cuối chương",
          "targetWords": ${params.length},
          "pacing": "Chậm | Trung bình | Nhanh | Cao trào"
        }
      ]
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
  const maxPlannedChapter = Math.max(0, ...safeVolumes.flatMap(volume => (volume.chapters || []).map(chapter => chapter.index)));
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
Arc mới phải nối logic với các Arc đã có, có mục tiêu riêng, và mỗi chương phải có kế hoạch viết rõ ràng.
Viết JSON gọn: summary/objective tối đa 18 từ, mỗi chương 3 beats và 2 mustInclude.
Trả về JSON của một Volume có index, title, summary, purpose, chapterStart, chapterEnd, chapters.`;
  
  const data = await chatJson(PLAN_MODEL, SYSTEM_INSTRUCTION_NEXT_ARC, prompt, 0.35, DEFAULT_MAX_OUTPUT_TOKENS);
  return normalizeSingleVolume(data, params, safeVolumes.length + 1, start, end);
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
  if (targetWords && wordCount < Math.max(350, targetWords * 0.62)) {
    return {
      isValid: false,
      reason: `Chương quá ngắn so với mục tiêu ${targetWords} chữ, hiện khoảng ${wordCount} chữ.`,
    };
  }

  const lastChapter = [...previousChapters]
    .filter(chapter => chapter.index !== chapterIndex)
    .sort((a, b) => b.index - a.index)[0];
  const chapterPlan = currentArc.chapters?.find(chapter => chapter.index === chapterIndex);
  
  const prompt = `THẨM ĐỊNH TÍNH NHẤT QUÁN VÀ LỘ TRÌNH

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
2. Có phá logic thế giới, nhân vật hoặc đại cục không?
3. Có lặp tình tiết chương trước mà không tạo biến chuyển mới không?
4. Có kết thúc toàn truyện quá sớm không?
5. Độ dài và nhịp chương có phù hợp mục tiêu không?

Trả về JSON: { "isValid": boolean, "reason": string }.`;

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
- Có mâu thuẫn thế giới, nhân vật, quan hệ, timeline không?
- Chương nào lệch khỏi kế hoạch chương hoặc Arc?
- Có lặp tình tiết, nhảy cóc, kết thúc quá sớm, hoặc thiếu hậu quả không?
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

Hãy cập nhật hồ sơ truyện, không làm mất dữ kiện cũ quan trọng.`;

  return chatJson(
    PLAN_MODEL,
    `Nhiệm vụ: rút tên chương, tóm tắt chương, cập nhật Thiên Cơ Lục.
Thiên Cơ Lục phải có các mục Markdown:
# DIỄN TIẾN TRUYỆN
# NHÂN VẬT CHÍNH
# NHÂN VẬT PHỤ VÀ QUAN HỆ
# HỆ THỐNG THẾ GIỚI
# MÂU THUẪN ĐANG MỞ
# ĐỐI CHIẾU LOGIC
Chỉ trả về JSON hợp lệ.`,
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
