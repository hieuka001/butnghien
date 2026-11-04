import { createVerify, X509Certificate } from "node:crypto";

type ApiRequest = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
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

type GeminiKeyRole = "writer" | "reviewer" | "rewriter" | "direction";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_OUTPUT_TOKENS = Math.min(Math.max(Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 16384, 512), 65536);
const DEFAULT_GEMINI_MODEL = "gemini-3-flash-preview";
const keyCursorByRole: Record<GeminiKeyRole, number> = {
  writer: 0,
  reviewer: 0,
  rewriter: 0,
  direction: 0,
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

const uniqueKeys = (keys: Array<string | undefined>) => keys
  .map(key => key?.trim() || "")
  .filter(Boolean)
  .filter((key, index, all) => all.indexOf(key) === index);

const roleKeyHelp: Record<GeminiKeyRole, string> = {
  writer: "GEMINI_API_KEY_1 va GEMINI_API_KEY_2",
  reviewer: "GEMINI_API_KEY_3 va GEMINI_API_KEY_4",
  rewriter: "GEMINI_API_KEY_5 va GEMINI_API_KEY_6",
  direction: "GEMINI_API_KEY_6",
};

const roleLabel: Record<GeminiKeyRole, string> = {
  writer: "Cum 1 viet/lap khung",
  reviewer: "Cum 2 tham dinh",
  rewriter: "Cum 3 sua ban thao",
  direction: "Key 6 chon huong truyen",
};

const getGeminiKeys = () => {
  return uniqueKeys([
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
    process.env.GEMINI_API_KEY_6,
  ]);
};

const getGeminiKeysForRole = (role: GeminiKeyRole) => {
  const preferredByRole: Record<GeminiKeyRole, Array<string | undefined>> = {
    writer: [
      process.env.GEMINI_API_KEY_1,
      process.env.GEMINI_API_KEY_2,
    ],
    reviewer: [
      process.env.GEMINI_API_KEY_3,
      process.env.GEMINI_API_KEY_4,
    ],
    rewriter: [
      process.env.GEMINI_API_KEY_5,
      process.env.GEMINI_API_KEY_6,
    ],
    direction: [
      process.env.GEMINI_API_KEY_6,
    ],
  };

  return uniqueKeys(preferredByRole[role]);
};

const isRotatableStatus = (status: number) => [401, 402, 403, 408, 429, 500, 502, 503].includes(status);
const isFallbackStatus = (status: number) => [404, 429, 500, 502, 503].includes(status);

const normalizeGeminiModel = (model?: string) => {
  const cleaned = (model || "").trim().replace(/^models\//, "");
  if (!cleaned) return DEFAULT_GEMINI_MODEL;

  const deprecatedModelMap: Record<string, string> = {
    "gemini-1.5-flash": DEFAULT_GEMINI_MODEL,
    "gemini-1.5-flash-latest": DEFAULT_GEMINI_MODEL,
    "gemini-1.5-flash-8b": "gemini-flash-lite-latest",
    "gemini-1.5-pro": "gemini-3.8-flash",
    "gemini-1.5-pro-latest": "gemini-3.8-flash",
    "gemini-pro": DEFAULT_GEMINI_MODEL,
    "gemini-2.0-flash": DEFAULT_GEMINI_MODEL,
    "gemini-2.0-flash-lite": "gemini-flash-lite-latest",
    "gemini-2.5-flash": DEFAULT_GEMINI_MODEL,
    "gemini-2.5-flash-lite": "gemini-flash-lite-latest",
    "gemini-2.5-pro": "gemini-3.8-flash",
  };

  return deprecatedModelMap[cleaned] || cleaned;
};

const getFallbackModels = (requestedModel?: string) => {
  const primaryModel = normalizeGeminiModel(requestedModel || process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL);
  const envFallbacks = (process.env.GEMINI_FALLBACK_MODELS || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean)
    .map(normalizeGeminiModel);
  const defaultFallbacks = [
    "gemini-3-flash-preview",
    "gemini-flash-lite-latest",
    "gemini-3.5-flash-lite",
    "gemini-3.8-flash",
  ];

  return [primaryModel, ...envFallbacks, ...defaultFallbacks]
    .filter((model, index, all) => model && all.indexOf(model) === index);
};

const shouldTryFallbackModel = (error: unknown) =>
  error instanceof GeminiProxyError && isFallbackStatus(error.status);

const roleCooldownKey = (role: GeminiKeyRole, keyIndex: number) => `${role}:${keyIndex}`;

const normalizeRole = (role?: string): GeminiKeyRole =>
  role === "reviewer" || role === "rewriter" || role === "direction" ? role : "writer";

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
    thinkingConfig: { thinkingLevel: "low" },
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
        const controller = new AbortController();
        const headerTimer = setTimeout(() => controller.abort(), 120_000);
        let response: Response;
        try {
          response = await fetch(`${GEMINI_API_BASE}/models/${model}:${action}`, {
            method: "POST",
            headers: requestHeaders(apiKey),
            body: JSON.stringify(buildGeminiPayload(body)),
            signal: controller.signal,
          });
        } catch (error) {
          if ((error as Error)?.name === "AbortError") {
            throw new GeminiProxyError(`Gemini (${model}) qua 120 giay chua phan hoi (timeout).`, 408, true);
          }
          throw error;
        } finally {
          clearTimeout(headerTimer);
        }

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


const getHeaderValue = (req: ApiRequest, name: string): string => {
  const headers = req.headers || {};
  const raw = headers[name] || headers[name.toLowerCase()];
  return Array.isArray(raw) ? String(raw[0] || "") : String(raw || "");
};

let googleCertCache: { certs: Record<string, string>; expiresAt: number } | null = null;
const getGoogleCerts = async (): Promise<Record<string, string>> => {
  if (googleCertCache && googleCertCache.expiresAt > Date.now()) return googleCertCache.certs;
  const response = await fetch("https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com");
  if (!response.ok) throw new GeminiProxyError("Khong tai duoc chung thu xac thuc Firebase.", 503, true);
  const certs = (await response.json()) as Record<string, string>;
  googleCertCache = { certs, expiresAt: Date.now() + 50 * 60 * 1000 };
  return certs;
};

const base64UrlToBuffer = (value: string) =>
  Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="), "base64");

// Khoa proxy bang Firebase ID token khi server da cau hinh FIREBASE_PROJECT_ID.
// Neu chua cau hinh Firebase tren server (moi truong local), proxy giu nguyen hanh vi cu.
const verifyFirebaseIdToken = async (req: ApiRequest): Promise<boolean> => {
  const projectId = process.env.FIREBASE_PROJECT_ID || "";
  if (!projectId) return true;
  const authorization = getHeaderValue(req, "authorization");
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token) return false;
  try {
    const [headerPart, payloadPart, signaturePart] = token.split(".");
    if (!headerPart || !payloadPart || !signaturePart) return false;
    const header = JSON.parse(base64UrlToBuffer(headerPart).toString("utf8"));
    const payload = JSON.parse(base64UrlToBuffer(payloadPart).toString("utf8"));
    if (header.alg !== "RS256" || !header.kid) return false;
    const certs = await getGoogleCerts();
    const pem = certs[header.kid];
    if (!pem) return false;
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${headerPart}.${payloadPart}`);
    verifier.end();
    if (!verifier.verify(new X509Certificate(pem).publicKey, base64UrlToBuffer(signaturePart))) return false;
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (payload.aud !== projectId) return false;
    if (payload.iss !== `https://securetoken.google.com/${projectId}`) return false;
    if (!payload.sub || Number(payload.exp) <= nowSeconds || Number(payload.iat) > nowSeconds + 300) return false;
    return true;
  } catch {
    return false;
  }
};

export default async function handler(req: ApiRequest, res: ApiResponse) {
  res.setHeader?.("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end?.();
    return;
  }

  if (req.method === "GET") {
    const authed = await verifyFirebaseIdToken(req);
    if (!authed) {
      res.status(200).json({
        configured: getGeminiKeys().length > 0,
        model: normalizeGeminiModel(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL),
        authRequired: true,
      });
      return;
    }
    res.status(200).json({
      configured: getGeminiKeys().length > 0,
      keyCount: getGeminiKeys().length,
      roleKeyCounts: {
        writer: getGeminiKeysForRole("writer").length,
        reviewer: getGeminiKeysForRole("reviewer").length,
        rewriter: getGeminiKeysForRole("rewriter").length,
        direction: getGeminiKeysForRole("direction").length,
      },
      model: normalizeGeminiModel(process.env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL),
      fallbackModels: getFallbackModels(),
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!(await verifyFirebaseIdToken(req))) {
    res.status(401).json({ error: { message: "Can dang nhap Firebase de dung Gemini proxy." } });
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
      let readResult: { value?: Uint8Array; done: boolean };
      try {
        readResult = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("STREAM_IDLE_TIMEOUT")), 120_000)),
        ]);
      } catch {
        try { await reader.cancel(); } catch { /* bo qua */ }
        break;
      }
      const { value, done } = readResult;
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
