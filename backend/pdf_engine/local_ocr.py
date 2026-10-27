"""Offline OCR using the Windows language packs; keep the source PDF untouched."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def command() -> list[str]:
    if sys.platform != "win32":
        raise RuntimeError("本地 OCR 当前支持 Windows。")
    shell = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe"
    resources = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1]))
    return [str(shell), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(resources / "ocr_windows.ps1")]


def status() -> dict:
    try:
        result = subprocess.run(command() + ["-Status"], capture_output=True, encoding="utf-8", timeout=30, creationflags=subprocess.CREATE_NO_WINDOW)
        value = json.loads(result.stdout)
        if not value.get("available"):
            value["error"] = value.get("error") or "请在 Windows 语言设置中安装英文或简体中文的 OCR 语言包。"
        return value
    except Exception as error:
        return {"available": False, "languages": [], "error": str(error)[:300]}


def recognize_pdf(source: Path, destination: Path, language: str, emit) -> list[int]:
    import pymupdf

    available = status()
    if not available.get("available"):
        raise RuntimeError(available["error"])
    tags = {item["tag"] for item in available["languages"]}
    if language == "auto":
        with pymupdf.open(source) as document:
            sample = "".join(page.get_text() for page in document)
        chinese = sum("\u4e00" <= char <= "\u9fff" for char in sample)
        preferred = "zh-Hans-CN" if chinese > sum(char.isascii() and char.isalpha() for char in sample) else "en-US"
        language = preferred if preferred in tags else "auto"
    elif language not in tags:
        raise RuntimeError("所选 OCR 语言未安装，请在设置中重新选择。")
    requested = json.loads(os.environ.get("WORKBENCH_OCR_PAGES", "[]"))
    with tempfile.TemporaryDirectory(prefix="ocr-", dir=destination.parent) as temporary:
        temporary = Path(temporary)
        with pymupdf.open(source) as document:
            pages = requested or [page.number + 1 for page in document if not page.get_text().strip() and page.get_contents()]
            images = []
            for number in pages:
                page = document[number - 1]
                scale = min(300 / 72, available["max_dimension"] / max(page.rect.width, page.rect.height) * .95)
                image = temporary / f"page-{number}.png"
                page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False).save(image)
                images.append({"page": number, "path": str(image)})
            request = temporary / "request.json"
            request.write_text(json.dumps({"language": language, "images": images}), encoding="utf-8")
            process = subprocess.Popen(command() + ["-InputFile", str(request)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                       encoding="utf-8", creationflags=subprocess.CREATE_NO_WINDOW)
            recognized = []
            try:
                for raw in process.stdout:
                    result = json.loads(raw)
                    if result.get("error"):
                        raise RuntimeError(result["error"])
                    number = int(result["page"])
                    if not result.get("text", "").strip():
                        raise RuntimeError(f"第 {number} 页 OCR 未识别到文字，请调整语言或检查原文件。")
                    page = document[number - 1]
                    sx, sy = page.rect.width / result["width"], page.rect.height / result["height"]
                    shape = page.new_shape()
                    for line in result["lines"]:
                        for word in line["words"]:
                            text = word["text"].strip()
                            width, height = word["width"] * sx, word["height"] * sy
                            if not text or min(width, height) <= 0:
                                continue
                            font = "china-s" if any(ord(char) > 255 for char in text) else "helv"
                            unit_width = pymupdf.get_text_length(text, fontname=font, fontsize=1)
                            size = min(height * .8, width / max(unit_width, .01))
                            shape.insert_text((word["x"] * sx, word["y"] * sy + height * .8), text,
                                              fontsize=size, fontname=font, render_mode=3)
                    shape.commit()
                    recognized.append(number)
                    emit({"type": "ocr_progress", "page": number, "completed": len(recognized), "total": len(pages)})
                if process.wait() != 0 or sorted(recognized) != sorted(pages):
                    raise RuntimeError("本地 OCR 未完成全部缺失页面，请重试。")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait()
                process.stdout.close()
                process.stderr.close()
            document.save(destination, garbage=4, deflate=True)
    return recognized
