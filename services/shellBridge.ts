// Cầu nối với vỏ iOS (Capacitor) khi web app chạy bên trong app Bút Nghiên.
// Ngoài vỏ (trình duyệt thường) mọi hàm đều no-op/trả null để web chạy y nguyên.
//
// Vỏ nạp bản web trực tuyến nên cập nhật nội dung/tính năng tự đến theo deploy;
// cầu nối này chỉ lo 2 việc native thật sự cần:
//  1) saveFile — WKWebView không tải blob như Safari; file xuất bản (.txt/.md/
//     .json/.docx) được đưa qua plugin ButNghienBridge để mở khay lưu/chia sẻ iOS.
//  2) getInfo — biết phiên bản vỏ đang chạy, so với /shell-version.json để báo
//     khi cần cài IPA mới (chỉ khi phần native thay đổi).

interface ShellBridgePlugin {
  getInfo: () => Promise<{ version: string; build?: string; platform?: string; ttsNative?: boolean }>;
  saveFile: (options: { name: string; base64: string }) => Promise<unknown>;
  // Vỏ 2.0.1+: cầu TTS native. Vỏ cũ không có — gọi sẽ bị reject, nơi gọi tự bắt.
  ttsVoices?: () => Promise<{ voices: Array<{ id: string; name: string }> }>;
  ttsSynthesize?: (options: { text: string; voice: string }) => Promise<{ base64: string }>;
  ttsDiagnostics?: () => Promise<Record<string, unknown>>;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  registerPlugin?: (name: string) => unknown;
}

const capacitor = (): CapacitorGlobal | undefined =>
  (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;

export const isInShell = (): boolean => {
  try {
    return Boolean(capacitor()?.isNativePlatform?.());
  } catch {
    return false;
  }
};

let cachedPlugin: ShellBridgePlugin | null | undefined;
const bridge = (): ShellBridgePlugin | null => {
  if (cachedPlugin !== undefined) return cachedPlugin;
  try {
    cachedPlugin = (capacitor()?.registerPlugin?.('ButNghienBridge') as ShellBridgePlugin) ?? null;
  } catch {
    cachedPlugin = null;
  }
  return cachedPlugin;
};

export const getShellInfo = async (): Promise<{ version: string } | null> => {
  const plugin = bridge();
  if (!plugin) return null;
  try {
    const info = await plugin.getInfo();
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
  const plugin = bridge();
  if (!plugin) return false;
  try {
    await plugin.saveFile({ name, base64: await blobToBase64(blob) });
    return true;
  } catch {
    return false;
  }
};

export interface ShellTtsVoice { id: string; name: string }

/** Chẩn đoán cầu native TTS theo từng method, GIỮ NGUYÊN thông báo lỗi gốc —
 * để phân biệt: vỏ cũ (method chưa có) / plugin không đăng ký / lỗi phía native. */
export const diagnoseShellTts = async (): Promise<string[]> => {
  const plugin = bridge();
  if (!plugin) return ['Cầu native: không dựng được proxy plugin'];
  const lines: string[] = [];
  const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  try {
    const info = await plugin.getInfo();
    lines.push(`getInfo: vỏ ${info?.version ?? '?'} · ttsNative: ${String(info?.ttsNative ?? '?')}`);
  } catch (e) {
    lines.push(`getInfo LỖI: ${errText(e)}`);
  }
  try {
    if (!plugin.ttsVoices) lines.push('ttsVoices: proxy không có method');
    else {
      const res = await plugin.ttsVoices();
      lines.push(`ttsVoices: OK — ${Array.isArray(res?.voices) ? res.voices.length : 0} giọng`);
    }
  } catch (e) {
    lines.push(`ttsVoices LỖI: ${errText(e)}`);
  }
  try {
    if (!plugin.ttsDiagnostics) lines.push('ttsDiagnostics: proxy không có method');
    else {
      const diag = await plugin.ttsDiagnostics();
      lines.push(`ttsDiagnostics: OK · server: ${String(diag?.listener ?? '?')} · engine: ${String(diag?.engine ?? '?')}`);
      if (diag?.engineError) lines.push(`Lỗi engine: ${String(diag.engineError)}`);
      lines.push(`Native tự gọi /health: ${String(diag?.loopback ?? '?')}`);
    }
  } catch (e) {
    lines.push(`ttsDiagnostics LỖI: ${errText(e)}`);
  }
  return lines;
};

/** Danh sách giọng VieNeu qua cầu native (vỏ 2.0.1+); null nếu vỏ cũ/không có. */
export const getTtsVoicesViaShell = async (): Promise<ShellTtsVoice[] | null> => {
  const plugin = bridge();
  if (!plugin?.ttsVoices) return null;
  try {
    const res = await plugin.ttsVoices();
    const voices = Array.isArray(res?.voices) ? res.voices : [];
    const mapped = voices
      .filter(v => v && typeof v.id === 'string')
      .map(v => ({ id: v.id, name: String(v.name || v.id) }));
    return mapped.length ? mapped : null;
  } catch {
    return null;
  }
};

/** Tổng hợp một đoạn qua engine native trong app; null nếu vỏ cũ/không trả audio. */
export const synthesizeViaShell = async (text: string, voice: string): Promise<Blob | null> => {
  const plugin = bridge();
  if (!plugin?.ttsSynthesize) return null;
  try {
    const res = await plugin.ttsSynthesize({ text, voice });
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
  const plugin = bridge();
  if (!plugin?.ttsDiagnostics) return null;
  try {
    return await plugin.ttsDiagnostics();
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
