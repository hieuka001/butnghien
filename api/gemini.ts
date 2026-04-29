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
};

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_OUTPUT_TOKENS = Math.min(Math.max(Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 8192, 512), 65536);
let keyCursor = 0;
const keyCooldownUntil = new Map<number, number>();

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

const isRotatableStatus = (status: number) => [401, 402, 408, 429, 500, 502, 503].includes(status);

const markKeyCooling = (keyIndex: number, status: number) => {
  keyCooldownUntil.set(keyIndex, Date.now() + (status === 429 ? 90_000 : 20_000));
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

const withGeminiKeys = async <T,>(requester: (apiKey: string, keyIndex: number) => Promise<T>) => {
  const keys = getGeminiKeys();
  if (!keys.length) {
    throw new GeminiProxyError("Thieu GEMINI_API_KEY trong Vercel Environment Variables.", 500);
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < keys.length; attempt++) {
    const keyIndex = pickKeyIndex(keys);
    try {
      return await requester(keys[keyIndex], keyIndex);
    } catch (error) {
      lastError = error;
      if (error instanceof GeminiProxyError && error.rotatable && attempt < keys.length - 1) {
        markKeyCooling(keyIndex, error.status);
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new GeminiProxyError("Tat ca Gemini API key deu dang loi.", 500);
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

const callGemini = async (body: GeminiProxyBody) =>
  withGeminiKeys(async (apiKey) => {
    const model = body.model || process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const action = body.stream ? "streamGenerateContent?alt=sse" : "generateContent";
    const response = await fetch(`${GEMINI_API_BASE}/models/${model}:${action}`, {
      method: "POST",
      headers: requestHeaders(apiKey),
      body: JSON.stringify(buildGeminiPayload(body)),
    });

    if (!response.ok) {
      const message = await parseErrorBody(response);
      throw new GeminiProxyError(`Gemini loi ${response.status}: ${message}`, response.status, isRotatableStatus(response.status));
    }

    return response;
  });

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
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
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
