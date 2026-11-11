// Nghe truyện (TTS) cho Bút Nghiên.
// Kiến trúc hai lớp giọng đọc:
//  1) Bridge VieNeu chạy local trên máy người dùng (mặc định http://127.0.0.1:3900 —
//     cùng cổng + cùng giao diện OpenAI-compatible /v1/audio/speech như lõi VoiceStudio):
//     giọng Việt neural VieNeu-TTS v3 Turbo, tổng hợp theo từng đoạn, tải trước đoạn kế.
//  2) Fallback: speechSynthesis của trình duyệt (giọng vi-VN của hệ điều hành) khi bridge
//     không chạy — vẫn nghe được ở mọi máy, chất lượng tùy giọng hệ thống.
// Endpoint bridge đổi được qua localStorage 'butnghien-tts-endpoint' (vd nghe qua LAN/Tailscale).

export interface TtsVoiceOption {
  id: string;
  name: string;
  source: "vieneu" | "browser";
}

const ENDPOINT_STORAGE_KEY = "butnghien-tts-endpoint";
export const DEFAULT_TTS_ENDPOINT = "http://127.0.0.1:3900";

export const getTtsEndpoint = (): string => {
  try {
    return (localStorage.getItem(ENDPOINT_STORAGE_KEY) || DEFAULT_TTS_ENDPOINT).replace(/\/+$/, "");
  } catch {
    return DEFAULT_TTS_ENDPOINT;
  }
};

export const setTtsEndpoint = (endpoint: string) => {
  try {
    const cleaned = endpoint.trim().replace(/\/+$/, "");
    if (cleaned) localStorage.setItem(ENDPOINT_STORAGE_KEY, cleaned);
    else localStorage.removeItem(ENDPOINT_STORAGE_KEY);
  } catch { /* localStorage bị chặn — dùng mặc định */ }
};

const fetchWithTimeout = async (url: string, init: RequestInit, timeoutMs: number): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

// Kiểm tra bridge VieNeu có đang chạy không; trả danh sách giọng nếu có.
export const probeVieneuBridge = async (): Promise<TtsVoiceOption[] | null> => {
  try {
    const response = await fetchWithTimeout(`${getTtsEndpoint()}/v1/audio/voices`, { method: "GET" }, 1800);
    if (!response.ok) return null;
    const data = await response.json().catch(() => null);
    const voices = Array.isArray(data?.voices) ? data.voices : [];
    const mapped: TtsVoiceOption[] = voices
      .filter((voice: any) => voice && typeof voice.id === "string")
      .map((voice: any) => ({ id: voice.id, name: String(voice.name || voice.id), source: "vieneu" as const }));
    return mapped.length ? mapped : [{ id: "default", name: "VieNeu (mặc định)", source: "vieneu" }];
  } catch {
    return null;
  }
};

// Tổng hợp một đoạn văn thành audio blob qua bridge.
export const synthesizeWithVieneu = async (text: string, voiceId: string): Promise<Blob> => {
  const response = await fetchWithTimeout(
    `${getTtsEndpoint()}/v1/audio/speech`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "vieneu", input: text, voice: voiceId || "default", response_format: "wav" }),
    },
    120000,
  );
  if (!response.ok) throw new Error(`Bridge VieNeu trả lỗi ${response.status}`);
  return response.blob();
};

// Giọng tiếng Việt của trình duyệt/hệ điều hành (fallback).
export const getBrowserVietnameseVoices = (): SpeechSynthesisVoice[] => {
  if (!("speechSynthesis" in window)) return [];
  return window.speechSynthesis.getVoices().filter(voice => /^vi([-_]|$)/i.test(voice.lang));
};

export type SpeechEngineKind = "vieneu" | "browser";
export type SpeechPlayerState = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

interface SpeechPlayerCallbacks {
  onState: (state: SpeechPlayerState) => void;
  onIndex: (index: number) => void;
  onEngine: (engine: SpeechEngineKind) => void;
}

// Trình phát theo hàng đợi đoạn văn: engine bridge tải audio từng đoạn (tải trước 1 đoạn),
// engine trình duyệt đọc bằng speechSynthesis. Tốc độ áp bằng playbackRate / utterance.rate.
export class SpeechPlayer {
  private segments: string[] = [];
  private index = 0;
  private state: SpeechPlayerState = "idle";
  private engine: SpeechEngineKind = "browser";
  private vieneuVoices: TtsVoiceOption[] | null = null;
  private vieneuVoiceId = "default";
  private browserVoice: SpeechSynthesisVoice | null = null;
  private rate = 1;
  private audio: HTMLAudioElement | null = null;
  private audioUrl: string | null = null;
  private blobCache = new Map<number, Promise<Blob>>();
  private generation = 0;
  private callbacks: SpeechPlayerCallbacks;

  constructor(callbacks: SpeechPlayerCallbacks) {
    this.callbacks = callbacks;
  }

  get currentIndex() { return this.index; }
  get totalSegments() { return this.segments.length; }
  get currentState() { return this.state; }
  get currentEngine() { return this.engine; }

  private setState(state: SpeechPlayerState) {
    this.state = state;
    this.callbacks.onState(state);
  }

  private setIndex(index: number) {
    this.index = index;
    this.callbacks.onIndex(index);
  }

  async load(segments: string[], options?: { vieneuVoiceId?: string; browserVoice?: SpeechSynthesisVoice | null; rate?: number }) {
    this.stopInternal();
    this.segments = segments;
    this.blobCache.clear();
    if (options?.vieneuVoiceId) this.vieneuVoiceId = options.vieneuVoiceId;
    if (options?.browserVoice !== undefined) this.browserVoice = options.browserVoice;
    if (options?.rate) this.rate = options.rate;
    this.setIndex(0);
    this.vieneuVoices = await probeVieneuBridge();
    this.engine = this.vieneuVoices ? "vieneu" : "browser";
    this.callbacks.onEngine(this.engine);
  }

  get voices(): TtsVoiceOption[] {
    if (this.engine === "vieneu" && this.vieneuVoices) return this.vieneuVoices;
    return getBrowserVietnameseVoices().map(voice => ({ id: voice.voiceURI, name: `${voice.name} (${voice.lang})`, source: "browser" as const }));
  }

  setVoice(id: string) {
    if (this.engine === "vieneu") {
      this.vieneuVoiceId = id;
      this.blobCache.clear();
    } else {
      this.browserVoice = getBrowserVietnameseVoices().find(voice => voice.voiceURI === id) || null;
    }
    if (this.state === "playing" || this.state === "paused") void this.playFrom(this.index);
  }

  setRate(rate: number) {
    this.rate = rate;
    if (this.audio) this.audio.playbackRate = rate;
  }

  private fetchSegmentBlob(index: number): Promise<Blob> {
    const cached = this.blobCache.get(index);
    if (cached) return cached;
    const promise = synthesizeWithVieneu(this.segments[index], this.vieneuVoiceId);
    this.blobCache.set(index, promise);
    promise.catch(() => this.blobCache.delete(index));
    return promise;
  }

  private stopInternal() {
    this.generation += 1;
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio = null;
    }
    if (this.audioUrl) {
      URL.revokeObjectURL(this.audioUrl);
      this.audioUrl = null;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  }

  async playFrom(index: number) {
    if (!this.segments.length) return;
    const target = Math.min(Math.max(0, index), this.segments.length - 1);
    this.stopInternal();
    const generation = this.generation;
    this.setIndex(target);
    if (this.engine === "vieneu") {
      this.setState("loading");
      try {
        const blob = await this.fetchSegmentBlob(target);
        if (generation !== this.generation) return;
        // Tải trước đoạn kế tiếp trong lúc phát đoạn này.
        if (target + 1 < this.segments.length) void this.fetchSegmentBlob(target + 1).catch(() => undefined);
        this.audioUrl = URL.createObjectURL(blob);
        const audio = new Audio(this.audioUrl);
        this.audio = audio;
        audio.playbackRate = this.rate;
        audio.onended = () => { if (generation === this.generation) void this.advance(); };
        audio.onerror = () => { if (generation === this.generation) this.setState("error"); };
        await audio.play();
        if (generation !== this.generation) return;
        this.setState("playing");
      } catch {
        if (generation !== this.generation) return;
        // Bridge chết giữa chừng → rơi xuống giọng trình duyệt để buổi nghe không đứt.
        this.engine = "browser";
        this.callbacks.onEngine("browser");
        this.speakWithBrowser(target, generation);
      }
    } else {
      this.speakWithBrowser(target, generation);
    }
  }

  private speakWithBrowser(index: number, generation: number) {
    if (!("speechSynthesis" in window)) {
      this.setState("error");
      return;
    }
    const utterance = new SpeechSynthesisUtterance(this.segments[index]);
    utterance.lang = "vi-VN";
    if (this.browserVoice) utterance.voice = this.browserVoice;
    utterance.rate = this.rate;
    utterance.onend = () => { if (generation === this.generation) void this.advance(); };
    utterance.onerror = (event) => {
      if (generation !== this.generation) return;
      if (event.error !== "canceled" && event.error !== "interrupted") this.setState("error");
    };
    this.setState("playing");
    window.speechSynthesis.speak(utterance);
  }

  private async advance() {
    if (this.index + 1 >= this.segments.length) {
      this.setState("ended");
      return;
    }
    await this.playFrom(this.index + 1);
  }

  async play() {
    if (this.state === "paused") {
      if (this.engine === "vieneu" && this.audio) {
        await this.audio.play();
        this.setState("playing");
      } else {
        // speechSynthesis không resume đáng tin trên mọi trình duyệt — phát lại đoạn hiện tại.
        await this.playFrom(this.index);
      }
      return;
    }
    await this.playFrom(this.state === "ended" ? 0 : this.index);
  }

  pause() {
    if (this.engine === "vieneu" && this.audio) {
      // Giữ nguyên generation để onended của đoạn hiện tại vẫn hợp lệ khi nghe tiếp.
      this.audio.pause();
      this.setState("paused");
      return;
    }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    this.generation += 1;
    this.setState("paused");
  }

  async next() { await this.playFrom(this.index + 1); }
  async previous() { await this.playFrom(this.index - 1); }

  stop() {
    this.stopInternal();
    this.setState("idle");
  }

  currentSegmentText(): string {
    return this.segments[this.index] || "";
  }
}
