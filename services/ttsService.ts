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

// Chọn giọng Việt TỐT NHẤT máy đang có: iOS/macOS thường có "Linh" (chuẩn) và bản
// nâng cao; bản "compact" nghe rè như robot nên trừ điểm nặng. Không chọn tay thì
// hệ thống hay rơi vào bản compact — đây là một nguồn "giọng lỗi, chưa hay".
export const pickBestBrowserVoice = (): SpeechSynthesisVoice | null => {
  const voices = getBrowserVietnameseVoices();
  if (!voices.length) return null;
  const score = (voice: SpeechSynthesisVoice): number => {
    const name = voice.name.toLowerCase();
    let points = 0;
    if (name.includes("linh")) points += 4;
    if (/enhanced|premium|natural|neural|siri/.test(name)) points += 3;
    if (/compact|eloquence/.test(name)) points -= 4;
    if (voice.default) points += 1;
    if (!voice.localService) points += 1;
    return points;
  };
  return [...voices].sort((x, y) => score(y) - score(x))[0];
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
  private mediaTitle = "";
  private wakeLock: any = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private utteranceStartedAt = 0;
  // App gan vao de nut next/prev o man hinh khoa (Media Session) nhay ca chuong khi het doan.
  onChapterSkip: ((direction: 1 | -1) => void) | null = null;

  constructor(callbacks: SpeechPlayerCallbacks) {
    this.callbacks = callbacks;
    this.installMediaSessionHandlers();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && this.state === "playing") void this.acquireWakeLock();
      });
    }
  }

  // Media Session: hien tieu de chuong + nut dieu khien o man hinh khoa/thong bao cua dien
  // thoai, dong thoi giup audio (engine VieNeu) tiep tuc chay khi tat man hinh/ngu nen.
  private installMediaSessionHandlers() {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler("play", () => { void this.play(); });
      navigator.mediaSession.setActionHandler("pause", () => { this.pause(); });
      navigator.mediaSession.setActionHandler("stop", () => { this.stop(); });
      navigator.mediaSession.setActionHandler("previoustrack", () => {
        if (this.index > 0) void this.previous();
        else this.onChapterSkip?.(-1);
      });
      navigator.mediaSession.setActionHandler("nexttrack", () => {
        if (this.index < this.segments.length - 1) void this.next();
        else this.onChapterSkip?.(1);
      });
    } catch { /* trinh duyet khong ho tro day du — bo qua */ }
  }

  private updateMediaMetadata() {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: this.mediaTitle || "Bút Nghiên — Nghe truyện",
        artist: "Bút Nghiên AI",
        album: "Nghe truyện",
      });
    } catch { /* bo qua */ }
  }

  private syncMediaPlaybackState() {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = this.state === "playing" ? "playing" : this.state === "paused" ? "paused" : "none";
    } catch { /* bo qua */ }
  }

  // Wake Lock: giu man hinh sang trong luc nghe o cac trinh duyet ho tro (Android/desktop);
  // tren iOS, co che chay nen chinh la Media Session + the <audio> cua engine VieNeu.
  private async acquireWakeLock() {
    try {
      const nav = navigator as any;
      if (nav.wakeLock && !this.wakeLock) {
        this.wakeLock = await nav.wakeLock.request("screen");
        this.wakeLock?.addEventListener?.("release", () => { this.wakeLock = null; });
      }
    } catch { /* nguoi dung/trinh duyet tu choi — bo qua */ }
  }

  private releaseWakeLock() {
    try {
      void this.wakeLock?.release?.();
    } catch { /* bo qua */ }
    this.wakeLock = null;
  }

  get currentIndex() { return this.index; }
  get totalSegments() { return this.segments.length; }
  get currentState() { return this.state; }
  get currentEngine() { return this.engine; }

  private setState(state: SpeechPlayerState) {
    this.state = state;
    this.syncMediaPlaybackState();
    if (state === "playing") void this.acquireWakeLock();
    if (state === "idle" || state === "ended" || state === "error") this.releaseWakeLock();
    this.syncWatchdog();
    this.callbacks.onState(state);
  }

  // Watchdog cho engine trình duyệt: speechSynthesis trên iOS/Chrome có lỗi kinh
  // điển là "câm giữa chừng" ở câu dài (không phát tiếp, cũng không bắn onend).
  // Mỗi 4 giây: nếu hàng đợi vẫn còn tiếng thì resume() để đánh thức; nếu im lặng
  // bất thường > 8 giây dù trạng thái đang playing thì tự nhảy đoạn kế tiếp.
  private syncWatchdog() {
    const shouldRun = this.state === "playing" && this.engine === "browser" && "speechSynthesis" in window;
    if (shouldRun && !this.watchdog) {
      this.watchdog = setInterval(() => {
        if (this.state !== "playing" || this.engine !== "browser" || !("speechSynthesis" in window)) return;
        const synth = window.speechSynthesis;
        if (synth.speaking || synth.pending) {
          synth.resume();
          if (synth.speaking) this.utteranceStartedAt = Date.now();
        } else if (this.utteranceStartedAt && Date.now() - this.utteranceStartedAt > 8000) {
          this.utteranceStartedAt = 0;
          void this.advance();
        }
      }, 4000);
    } else if (!shouldRun && this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private setIndex(index: number) {
    this.index = index;
    this.callbacks.onIndex(index);
  }

  async load(segments: string[], options?: { vieneuVoiceId?: string; browserVoice?: SpeechSynthesisVoice | null; rate?: number; mediaTitle?: string }) {
    this.stopInternal();
    this.segments = segments;
    if (options?.mediaTitle !== undefined) {
      this.mediaTitle = options.mediaTitle;
      this.updateMediaMetadata();
    }
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
    if (this.engine === "vieneu" && this.vieneuVoices) {
      const rest = this.vieneuVoices.filter(voice => voice.id !== "default");
      return [{ id: "default", name: "Giọng mặc định", source: "vieneu" as const }, ...rest];
    }
    return getBrowserVietnameseVoices().map(voice => ({ id: voice.voiceURI, name: `${voice.name} (${voice.lang})`, source: "browser" as const }));
  }

  // Giong player SE dung neu phat ngay bay gio (de UI hien dung, khong hien mot giong
  // ma nghe lai ra giong khac).
  get currentVoiceId(): string {
    if (this.engine === "vieneu") return this.vieneuVoiceId;
    return this.browserVoice?.voiceURI || "";
  }

  // Tham do engine ngay khi can (vd vua vao man Nghe) thay vi cho den luc phat:
  // co danh sach giong VieNeu thi chuyen engine + bao qua callback onEngine.
  async refreshVoices(): Promise<TtsVoiceOption[]> {
    const probed = await probeVieneuBridge();
    if (probed) {
      this.vieneuVoices = probed;
      this.engine = "vieneu";
      this.callbacks.onEngine(this.engine);
    }
    return this.voices;
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
    if (!this.browserVoice) this.browserVoice = pickBestBrowserVoice();
    if (this.browserVoice) {
      utterance.voice = this.browserVoice;
      utterance.lang = this.browserVoice.lang || "vi-VN";
    } else {
      utterance.lang = "vi-VN";
    }
    utterance.rate = this.rate;
    this.utteranceStartedAt = Date.now();
    utterance.onend = () => { this.utteranceStartedAt = 0; if (generation === this.generation) void this.advance(); };
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
