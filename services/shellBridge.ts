// Cầu nối với vỏ iOS (Capacitor) khi web app chạy bên trong app Bút Nghiên.
// Ngoài vỏ (trình duyệt thường) mọi hàm đều no-op/trả null để web chạy y nguyên.
//
// Vỏ nạp bản web trực tuyến nên cập nhật nội dung/tính năng tự đến theo deploy;
// cầu nối này lo các việc native thật sự cần: getInfo (báo bản vỏ mới),
// saveFile (mở khay lưu/chia sẻ iOS cho file xuất bản), và TTS native
// (ttsVoices/ttsSynthesize/ttsDiagnostics của engine VieNeu trong app).
//
// BÀI HỌC ĐỢT 24 (2026-11-12): bản cũ gọi window.Capacitor.registerPlugin() —
// hàm đó thuộc @capacitor/core (web app phải tự bundle), native-bridge.js của
// vỏ KHÔNG hề cung cấp → proxy luôn null, MỌI method native chết im lặng từ
// bản vỏ 1.0.0 (banner báo cập nhật, xuất file, TTS đều dính). native-bridge
// chỉ đảm bảo: isNativePlatform/getPlatform + nativePromise/nativeCallback.
// => Gọi thẳng nativePromise('ButnghienBridge', method, options) như dưới đây.

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  nativePromise?: (pluginName: string, methodName: string, options?: unknown) => Promise<unknown>;
}

const PLUGIN_NAME = 'ButnghienBridge';

const capacitor = (): CapacitorGlobal | undefined =>
  (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;

export const isInShell = (): boolean => {
  try {
    return Boolean(capacitor()?.isNativePlatform?.());
  } catch {
    return false;
  }
};

const hasNativeBridge = (): boolean => {
  try {
    return typeof capacitor()?.nativePromise === 'function';
  } catch {
    return false;
  }
};

const callNative = async <T>(method: string, options?: unknown): Promise<T> => {
  const cap = capacitor();
  if (!cap?.nativePromise) throw new Error('Cầu native không có nativePromise');
  return cap.nativePromise(PLUGIN_NAME, method, options) as Promise<T>;
};

interface ShellInfo { version: string; build?: string; platform?: string; ttsNative?: boolean }

export const getShellInfo = async (): Promise<{ version: string } | null> => {
  if (!hasNativeBridge()) return null;
  try {
    const info = await callNative<ShellInfo>('getInfo');
    return info?.version ? { version: info.version } : null;
  } catch {
    return null;
  }
};

const blobToBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
};

/** Trả true nếu vỏ đã nhận file (khay lưu/chia sẻ iOS sẽ hiện). */
export const saveFileViaShell = async (name: string, blob: Blob): Promise<boolean> => {
  if (!hasNativeBridge()) return false;
  try {
    await callNative('saveFile', { name, base64: await blobToBase64(blob) });
    return true;
  } catch {
    return false;
  }
};

export interface ShellTtsVoice { id: string; name: string }

/** Chẩn đoán cầu native TTS theo từng method, GIỮ NGUYÊN thông báo lỗi gốc —
 * để phân biệt: vỏ cũ (method chưa có) / plugin không đăng ký / lỗi phía native. */
export const diagnoseShellTts = async (): Promise<string[]> => {
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  if (!hasNativeBridge()) return ['Cầu native: KHÔNG có nativePromise (đang ngoài app?)'];
  const lines: string[] = ['Cầu native: có nativePromise'];
  try {
    const info = await callNative<ShellInfo>('getInfo');
    lines.push(`getInfo: vỏ ${info?.version ?? '?'} · ttsNative: ${String(info?.ttsNative ?? '?')}`);
  } catch (e) {
    lines.push(`getInfo LỖI: ${errText(e)}`);
  }
  try {
    const res = await callNative<{ voices: Array<{ id: string; name: string }> }>('ttsVoices');
    lines.push(`ttsVoices: OK — ${Array.isArray(res?.voices) ? res.voices.length : 0} giọng`);
  } catch (e) {
    lines.push(`ttsVoices LỖI: ${errText(e)}`);
  }
  try {
    const diag = await callNative<Record<string, unknown>>('ttsDiagnostics');
    lines.push(`ttsDiagnostics: OK · server: ${String(diag?.listener ?? '?')} · engine: ${String(diag?.engine ?? '?')}`);
    if (diag?.engineError) lines.push(`Lỗi engine: ${String(diag.engineError)}`);
    lines.push(`Native tự gọi /health: ${String(diag?.loopback ?? '?')}`);
  } catch (e) {
    lines.push(`ttsDiagnostics LỖI: ${errText(e)}`);
  }
  return lines;
};

/** Danh sách giọng VieNeu qua cầu native (vỏ 2.0.1+); null nếu vỏ cũ/không có. */
export const getTtsVoicesViaShell = async (): Promise<ShellTtsVoice[] | null> => {
  if (!hasNativeBridge()) return null;
  try {
    const res = await callNative<{ voices: Array<{ id: string; name: string }> }>('ttsVoices');
    const voices = Array.isArray(res?.voices) ? res.voices : [];
    const mapped = voices
      .filter(v => v && typeof v.id === 'string')
      .map(v => ({ id: v.id, name: String(v.name || v.id) }));
    return mapped.length ? mapped : null;
  } catch {
    return null;
  }
};

/** Tổng hợp một đoạn qua engine native trong app; null nếu vỏ cũ/không trả audio.
 * Timeout 60s (đợt 27): engine nạp lần đầu gồm 4 phiên ONNX + 260MB tài sản —
 * có thể chậm, nhưng nếu TREO hẳn thì không được để buổi nghe chết theo trong
 * im lặng: quá hạn coi như lỗi, player tự rơi về giọng trình duyệt + chẩn đoán. */
export const synthesizeViaShell = async (text: string, voice: string, timeoutMs = 60000): Promise<Blob | null> => {
  if (!hasNativeBridge()) return null;
  try {
    const res = await Promise.race([
      callNative<{ base64: string }>('ttsSynthesize', { text, voice }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`Tổng hợp VieNeu quá ${Math.round(timeoutMs / 1000)} giây`)), timeoutMs)),
    ]);
    if (!res?.base64) return null;
    const binary = atob(res.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: 'audio/wav' });
  } catch {
    return null;
  }
};

/** Chẩn đoán TTS phía vỏ (trạng thái server/engine/assets/loopback) — vỏ 2.0.1+. */
export const getTtsDiagnosticsViaShell = async (): Promise<Record<string, unknown> | null> => {
  if (!hasNativeBridge()) return null;
  try {
    return await callNative<Record<string, unknown>>('ttsDiagnostics');
  } catch {
    return null;
  }
};

/** So sánh version dạng x.y.z: <0 nếu a<b, 0 nếu bằng, >0 nếu a>b. */
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(n => Number(n) || 0);
  const pb = b.split('.').map(n => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
};
