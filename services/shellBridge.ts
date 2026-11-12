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
  getInfo: () => Promise<{ version: string; build?: string; platform?: string }>;
  saveFile: (options: { name: string; base64: string }) => Promise<unknown>;
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

/** So sánh version dạng x.y.z: <0 nếu a<b, 0 nếu bằng, >0 nếu a>b. */
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(n => Number(n) || 0);
  const pb = b.split('.').map(n => Number(n) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
};
