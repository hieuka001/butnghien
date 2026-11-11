#!/usr/bin/env python3
"""
Bút Nghiên TTS Bridge — lõi nghe truyện dùng VieNeu-TTS (giọng Việt).

Chỉ phần lõi, theo đúng giao diện của VoiceStudio core:
  GET  /health             -> trạng thái bridge + model
  GET  /v1/audio/voices    -> danh sách giọng VieNeu preset
  POST /v1/audio/speech    -> {input, voice} => WAV (OpenAI-compatible)

Chạy local trên máy người dùng (mặc định 127.0.0.1:3900). Bút Nghiên (web)
tự dò endpoint này; không thấy bridge thì app rơi xuống giọng của trình duyệt.

Yêu cầu: pip install vieneu  (bản tối thiểu, torch-free, chạy CPU bằng ONNX)
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# QUAN TRỌNG: tắt Xet storage của HuggingFace TRƯỚC khi nạp vieneu/huggingface_hub.
# Bản hub mới tải model qua Xet CAS: các file .onnx và file dữ liệu ngoài (.data) bị
# rải sang nhiều thư mục blob khác nhau, khiến ONNX Runtime báo lỗi "External data
# path escapes model directory" và không nạp được cả backbone lẫn codec MOSS.
# Tắt Xet -> tải kiểu LFS cổ điển, mọi file cùng một thư mục blob -> nạp bình thường.
# (Đã kiểm chứng thực tế 2026-11-11: bật Xet = lỗi nạp 100%, tắt Xet = infer thành công.)
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")

CACHE_DIR = Path(__file__).resolve().parent / "cache"
CACHE_MAX_FILES = 300

_state = {
    "tts": None,
    "load_error": None,
    "loading": True,
}
_load_event = threading.Event()
_infer_lock = threading.Lock()


def load_model() -> None:
    try:
        from vieneu import Vieneu

        _state["tts"] = Vieneu()
        print("[tts-bridge] VieNeu-TTS v3 Turbo đã sẵn sàng (48 kHz, CPU/ONNX).", flush=True)
    except Exception as exc:  # noqa: BLE001 — báo lỗi qua /health thay vì sập server
        _state["load_error"] = f"{type(exc).__name__}: {exc}"
        print(f"[tts-bridge] LỖI nạp model: {_state['load_error']}", file=sys.stderr, flush=True)
    finally:
        _state["loading"] = False
        _load_event.set()


def cache_path_for(text: str, voice: str) -> Path:
    digest = hashlib.sha256(f"vieneu-v3turbo|{voice}|{text}".encode("utf-8")).hexdigest()
    return CACHE_DIR / f"{digest}.wav"


def prune_cache() -> None:
    try:
        files = sorted(CACHE_DIR.glob("*.wav"), key=lambda p: p.stat().st_mtime)
        for stale in files[: max(0, len(files) - CACHE_MAX_FILES)]:
            stale.unlink(missing_ok=True)
    except OSError:
        pass


def synthesize(text: str, voice: str) -> bytes:
    if not _load_event.wait(timeout=180):
        raise RuntimeError("Model chưa nạp xong sau 180 giây.")
    if _state["load_error"]:
        raise RuntimeError(f"Model lỗi: {_state['load_error']}")
    tts = _state["tts"]
    target = cache_path_for(text, voice)
    if target.exists() and target.stat().st_size > 44:
        return target.read_bytes()
    with _infer_lock:
        # Kiểm tra lại trong lock: request trước có thể vừa ghi xong file này.
        if target.exists() and target.stat().st_size > 44:
            return target.read_bytes()
        voice_arg = None if voice in ("", "default") else voice
        audio = tts.infer(text, voice=voice_arg)
        if audio is None or len(audio) == 0:
            raise RuntimeError("VieNeu trả audio rỗng.")
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        tts.save(audio, target)
        prune_cache()
        return target.read_bytes()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args) -> None:  # noqa: A002 — tắt log ồn của http.server
        sys.stderr.write("[tts-bridge] %s\n" % (format % args))

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, code: int, payload: dict) -> None:
        self._send(code, json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def do_OPTIONS(self) -> None:  # noqa: N802 — tên hàm theo http.server
        self._send(204, b"", "text/plain")

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._json(200, {
                "ok": _state["load_error"] is None,
                "engine": "vieneu",
                "model": "VieNeu-TTS v3 Turbo",
                "model_loaded": _state["tts"] is not None,
                "loading": _state["loading"],
                "sample_rate": 48000,
                "error": _state["load_error"],
            })
            return
        if self.path == "/v1/audio/voices":
            if _state["tts"] is None:
                self._json(503, {"error": "Model chưa sẵn sàng", "detail": _state["load_error"]})
                return
            voices = [
                {"id": voice_id, "name": description, "language": "vi"}
                for description, voice_id in _state["tts"].list_preset_voices()
            ]
            self._json(200, {"voices": voices})
            return
        self._json(404, {"error": "Không tìm thấy đường này"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/audio/speech":
            self._json(404, {"error": "Không tìm thấy đường này"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"error": "Body phải là JSON"})
            return
        text = str(payload.get("input") or "").strip()
        voice = str(payload.get("voice") or "default")
        if not text:
            self._json(400, {"error": "Thiếu trường input"})
            return
        if len(text) > 2000:
            self._json(400, {"error": "Đoạn văn quá dài (tối đa 2000 ký tự/lần)"})
            return
        started = time.time()
        try:
            wav = synthesize(text, voice)
        except Exception as exc:  # noqa: BLE001
            self._json(500, {"error": f"Tổng hợp thất bại: {exc}"})
            return
        print(f"[tts-bridge] Đã đọc {len(text)} ký tự (giọng {voice}) trong {time.time() - started:.1f}s", flush=True)
        self._send(200, wav, "audio/wav")


def main() -> None:
    parser = argparse.ArgumentParser(description="Bút Nghiên TTS Bridge (VieNeu)")
    parser.add_argument("--host", default="127.0.0.1", help="Mặc định 127.0.0.1 (chỉ máy này). Dùng 0.0.0.0 để nghe từ máy khác trong LAN — tự chịu trách nhiệm bảo mật.")
    parser.add_argument("--port", type=int, default=3900)
    args = parser.parse_args()

    threading.Thread(target=load_model, daemon=True).start()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[tts-bridge] Đang nghe tại http://{args.host}:{args.port} — model đang nạp ở luồng nền…", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[tts-bridge] Đã dừng.")


if __name__ == "__main__":
    main()
