# Bút Nghiên TTS Bridge — lõi nghe truyện bằng VieNeu-TTS

Phần lõi giọng đọc cho Bút Nghiên, theo đúng tinh thần "chỉ lấy phần lõi" của
VoiceStudio: một server local nhỏ phơi ra giao diện tương thích OpenAI
(`GET /v1/audio/voices`, `POST /v1/audio/speech`, cổng mặc định **3900** — cùng
quy ước cổng của VoiceStudio core), chạy bằng **VieNeu-TTS v3 Turbo** (giọng
tiếng Việt Bắc/Trung/Nam, ONNX trên CPU, không cần GPU, không cần tài khoản).

Không lấy: giao diện studio, voice cloning UI, dubbing, ASR, MCP… của VoiceStudio.

## Cách chạy (Windows)

1. Cài Python 3.10+ từ [python.org](https://www.python.org) (nhớ tick "Add python.exe to PATH").
2. Chạy **`start.bat`** — lần đầu nó tự tạo môi trường riêng và cài `vieneu`
   (vài trăm MB, tùy mạng). Các lần sau mở gần như ngay.
3. Để nguyên cửa sổ bridge, mở Bút Nghiên → vào một chương đã viết → bấm **Nghe**.
   App tự dò bridge ở `http://127.0.0.1:3900`; thanh phát sẽ hiện nhãn
   "Giọng VieNeu (máy này)".

Không chạy bridge thì app vẫn nghe được bằng giọng của trình duyệt (nhãn
"Giọng trình duyệt") — chất lượng tùy giọng vi-VN của hệ điều hành.

## Cách chạy (macOS / Linux)

```bash
cd tts-bridge
python3 -m venv .venv && source .venv/bin/activate
pip install vieneu
python server.py            # nạp model ở luồng nền, sẵn sàng sau ~1 phút
```

## Kiểm tra nhanh

- `http://127.0.0.1:3900/health` → `model_loaded: true` là đã sẵn sàng.
- `http://127.0.0.1:3900/v1/audio/voices` → danh sách giọng preset.

## Tùy chọn

- Đổi cổng: `python server.py --port 3901` — đồng thời đổi endpoint trong app:
  mở Console của trình duyệt tại trang Bút Nghiên và chạy
  `localStorage.setItem('butnghien-tts-endpoint', 'http://127.0.0.1:3901')`.
- Nghe từ thiết bị khác trong cùng mạng/Tailscale: `python server.py --host 0.0.0.0`
  rồi đặt endpoint như trên trỏ về IP máy chạy bridge. **Lưu ý:** bridge không có
  mật khẩu — chỉ mở `0.0.0.0` trong mạng nhà/tailscale của bạn, đừng phơi ra internet.

## Ghi chú kỹ thuật

- Audio WAV 48 kHz được cache theo (giọng + nội dung đoạn) trong thư mục `cache/`
  (tối đa 300 file) — nghe lại chương cũ gần như tức thì.
- VieNeu-TTS: mã nguồn + trọng số v3 Turbo theo giấy phép Apache-2.0
  (repo `pnnbao97/VieNeu-TTS`, gói PyPI `vieneu`). VoiceStudio theo AGPL-3.0 —
  bridge này không dùng mã của VoiceStudio, chỉ dùng chung quy ước API/cổng.
