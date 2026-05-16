type ApiRequest = {
  method?: string;
  body?: unknown;
  on?: (event: string, callback: (chunk?: unknown) => void) => void;
};

type ApiResponse = {
  status: (code: number) => ApiResponse;
  json: (payload: unknown) => void;
  setHeader?: (name: string, value: string) => void;
  write?: (chunk: Uint8Array | string) => boolean;
  end?: (chunk?: Uint8Array | string) => void;
};

type GeminiProxyBody = {
  model?: string;
  systemInstruction?: string;
  prompt?: string;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  stream?: boolean;
  role?: GeminiKeyRole;
};

type GeminiKeyRole = "writer" | "reviewer" | "rewriter";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_OUTPUT_TOKENS = Math.min(Math.max(Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 8192, 512), 65536);
const keyCursorByRole: Record<GeminiKeyRole, number> = {
  writer: 0,
  reviewer: 0,
  rewriter: 0,
};
const keyCooldownUntil = new Map<string, number>();

class GeminiProxyError extends Error {
  status: number;
  rotatable: boolean;

  constructor(message: string, status: number, rotatable = false) {
    super(message);
    this.name = "GeminiProxyError";
    this.status = status;
    this.rotatable = rotatable;
  }
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const splitEnvList = (value?: string) => (value || "")
  .split(",")
  .map(item => item.trim())
  .filter(Boolean);

const uniqueKeys = (keys: Array<string | undefined>) => keys
  .map(key => key?.trim() || "")
  .filter(Boolean)
  .filter((key, index, all) => all.indexOf(key) === index);

const roleKeyHelp: Record<GeminiKeyRole, string> = {
  writer: "GEMINI_API_KEY_1 va GEMINI_API_KEY_2",
  reviewer: "GEMINI_API_KEY_3 va GEMINI_API_KEY_4",
  rewriter: "GEMINI_API_KEY_5 va GEMINI_API_KEY_6",
};

const roleLabel: Record<GeminiKeyRole, string> = {
  writer: "Cum 1 viet/lap khung",
  reviewer: "Cum 2 tham dinh",
  rewriter: "Cum 3 sua ban thao",
};

const getGeminiKeys = () => {
  const numberedKeys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
    process.env.GEMINI_API_KEY_6,
    process.env.GEMINI_WRITER_API_KEY,
    process.env.GEMINI_WRITER_API_KEY_2,
    process.env.GEMINI_REVIEWER_API_KEY,
    process.env.GEMINI_REVIEWER_API_KEY_2,
    process.env.GEMINI_REWRITER_API_KEY,
    process.env.GEMINI_REWRITER_API_KEY_2,
  ];
  const listKeys = splitEnvList(process.env.GEMINI_API_KEYS);
  return uniqueKeys([...numberedKeys, ...listKeys]);
};

const getGeminiKeysForRole = (role: GeminiKeyRole) => {
  const listKeys = splitEnvList(process.env.GEMINI_API_KEYS);
  const preferredByRole: Record<GeminiKeyRole, Array<string | undefined>> = {
    writer: [
      process.env.GEMINI_WRITER_API_KEY,
      process.env.GEMINI_WRITER_API_KEY_2,
      process.env.GEMINI_API_KEY_1,
      process.env.GEMINI_API_KEY_2,
      listKeys[0],
      listKeys[1],
    ],
    reviewer: [
      process.env.GEMINI_REVIEWER_API_KEY,
      process.env.GEMINI_REVIEWER_API_KEY_2,
      process.env.GEMINI_API_KEY_3,
      process.env.GEMINI_API_KEY_4,
      listKeys[2],
      listKeys[3],
    ],
    rewriter: [
      process.env.GEMINI_REWRITER_API_KEY,
      process.env.GEMINI_REWRITER_API_KEY_2,
      process.env.GEMINI_API_KEY_5,
      process.env.GEMINI_API_KEY_6,
      listKeys[4],
      listKeys[5],
    ],
  };

  return uniqueKeys(preferredByRole[role]);
};

const isRotatableStatus = (status: number) => [401, 402, 403, 408, 429, 500, 502, 503].includes(status);
const isFallbackStatus = (status: number) => [404, 429, 500, 502, 503].includes(status);

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

const getFallbackModels = (requestedModel?: string) => {
  const primaryModel = normalizeGeminiModel(requestedModel || process.env.GEMINI_MODEL || "gemini-2.5-flash");
  const envFallbacks = splitEnvList(process.env.GEMINI_FALLBACK_MODELS).map(normalizeGeminiModel);
  const defaultFallbacks = [
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash",
  ];

  return [primaryModel, ...envFallbacks, ...defaultFallbacks]
    .filter((model, index, all) => model && all.indexOf(model) === index);
};

const shouldTryFallbackModel = (error: unknown) =>
  error instanceof GeminiProxyError && isFallbackStatus(error.status);

const roleCooldownKey = (role: GeminiKeyRole, keyIndex: number) => `${role}:${keyIndex}`;

const normalizeRole = (role?: string): GeminiKeyRole =>
  role === "reviewer" || role === "rewriter" ? role : "writer";

const markKeyCooling = (role: GeminiKeyRole, keyIndex: number, status: number) => {
  keyCooldownUntil.set(roleCooldownKey(role, keyIndex), Date.now() + (status === 429 ? 90_000 : 20_000));
};

const pickKeyIndex = (keys: string[], role: GeminiKeyRole) => {
  const now = Date.now();
  for (let offset = 0; offset < keys.length; offset++) {
    const index = (keyCursorByRole[role] + offset) % keys.length;
    const coolingUntil = keyCooldownUntil.get(roleCooldownKey(role, index)) || 0;
    if (coolingUntil <= now) {
      keyCursorByRole[role] = (index + 1) % keys.length;
      return index;
    }
  }

  keyCooldownUntil.clear();
  const index = keyCursorByRole[role] % keys.length;
  keyCursorByRole[role] = (index + 1) % keys.length;
  return index;
};

const withGeminiKeys = async <T,>(role: GeminiKeyRole, requester: (apiKey: string, keyIndex: number) => Promise<T>) => {
  const keys = getGeminiKeysForRole(role);
  if (!keys.length) {
    throw new GeminiProxyError(`Thieu Gemini API key cho ${roleLabel[role]}. Hay cau hinh ${roleKeyHelp[role]} trong Vercel Environment Variables.`, 500);
  }

  let lastError: unknown;
  let lastStatus = 500;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const keyIndex = pickKeyIndex(keys, role);
    try {
      return await requester(keys[keyIndex], keyIndex);
    } catch (error) {
      lastError = error;
      lastStatus = error instanceof GeminiProxyError ? error.status : 500;
      if (error instanceof GeminiProxyError && error.rotatable) {
        markKeyCooling(role, keyIndex, error.status);
        if (attempt < keys.length - 1) continue;
        break;
      }
      throw error;
    }
  }

  const detail = lastError instanceof Error ? lastError.message : "Khong ro loi.";
  const credentialHint = lastStatus === 401 || lastStatus === 403
    ? `Gemini API key cua ${roleLabel[role]} khong hop le hoac chua duoc cap quyen dung API. Kiem tra ${roleKeyHelp[role]}, bat Generative Language API, bo gioi han referrer/IP khong phu hop voi Vercel Serverless, roi redeploy.`
    : `Tat ca Gemini API key cua ${roleLabel[role]} deu dang loi. Kiem tra ${roleKeyHelp[role]} hoac thu lai sau.`;
  throw new GeminiProxyError(`${credentialHint} Loi cuoi: ${detail}`, lastStatus, isRotatableStatus(lastStatus));
};

const parseBody = async (req: ApiRequest): Promise<GeminiProxyBody> => {
  if (req.body) {
    if (req.body instanceof Uint8Array) {
      return JSON.parse(Buffer.from(req.body).toString("utf8"));
    }
    return typeof req.body === "string" ? JSON.parse(req.body) : req.body as GeminiProxyBody;
  }

  return await new Promise((resolve, reject) => {
    let raw = "";
    req.on?.("data", chunk => {
      raw += typeof chunk === "string" ? chunk : Buffer.from(chunk as ArrayBuffer).toString("utf8");
    });
    req.on?.("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on?.("error", reject);
  });
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

const buildGeminiPayload = (body: GeminiProxyBody) => ({
  systemInstruction: { parts: [{ text: body.systemInstruction || "" }] },
  contents: [{ role: "user", parts: [{ text: body.prompt || "" }] }],
  generationConfig: {
    temperature: Number.isFinite(body.temperature) ? body.temperature : 0.7,
    maxOutputTokens: clamp(Math.floor(Number(body.maxTokens) || 4096), 512, MAX_OUTPUT_TOKENS),
    ...(body.jsonMode ? { responseMimeType: "application/json" } : {}),
  },
});

const requestHeaders = (apiKey: string) => ({
  "x-goog-api-key": apiKey,
  "Content-Type": "application/json",
});

const callGemini = async (body: GeminiProxyBody) => {
  let lastError: unknown;
  const models = getFallbackModels(body.model);
  const role = normalizeRole(body.role);

  for (const model of models) {
    try {
      return await withGeminiKeys(role, async (apiKey) => {
        const action = body.stream ? "streamGenerateContent?alt=sse" : "generateContent";
        const response = await fetch(`${GEMINI_API_BASE}/models/${model}:${action}`, {
          method: "POST",
          headers: requestHeaders(apiKey),
          body: JSON.stringify(buildGeminiPayload(body)),
        });

        if (!response.ok) {
          const message = await parseErrorBody(response);
          throw new GeminiProxyError(`Gemini loi ${response.status} (${model}): ${message}`, response.status, isRotatableStatus(response.status));
        }

        return response;
      });
    } catch (error) {
      lastError = error;
      if (shouldTryFallbackModel(error)) continue;
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new GeminiProxyError("Tat ca Gemini model du phong deu dang loi.", 503, true);
};

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader?.("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end?.();
    return;
  }

  if (req.method === "GET") {
    res.status(200).json({
      configured: getGeminiKeys().length > 0,
      keyCount: getGeminiKeys().length,
      roleKeyCounts: {
        writer: getGeminiKeysForRole("writer").length,
        reviewer: getGeminiKeysForRole("reviewer").length,
        rewriter: getGeminiKeysForRole("rewriter").length,
      },
      model: normalizeGeminiModel(process.env.GEMINI_MODEL || "gemini-2.5-flash"),
      fallbackModels: getFallbackModels(),
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const body = await parseBody(req);
    if (!body.prompt || !body.model) {
      res.status(400).json({ error: "Thieu prompt hoac model." });
      return;
    }

    const upstream = await callGemini(body);
    if (!body.stream) {
      res.status(200).json(await upstream.json());
      return;
    }

    res.status(200);
    res.setHeader?.("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader?.("Connection", "keep-alive");

    if (!upstream.body) {
      throw new GeminiProxyError("Gemini khong mo duoc stream.", 502, true);
    }

    const reader = upstream.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) res.write?.(value);
    }
    res.end?.();
  } catch (error) {
    const status = error instanceof GeminiProxyError ? error.status : 500;
    const message = error instanceof Error ? error.message : "Khong goi duoc Gemini.";
    res.status(status).json({ error: { message } });
  }
}
