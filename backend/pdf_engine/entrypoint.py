from __future__ import annotations

import asyncio
import json
import multiprocessing
import os
import shutil
import sys
from pathlib import Path


def configure_runtime_home(home: Path) -> Path:
    home = home.resolve()
    if os.name == "nt" and home.drive.upper() != "D:":
        raise RuntimeError("PDF engine runtime must stay on D drive.")
    os.environ["WORKBENCH_PDF_ENGINE_RUNTIME_HOME"] = str(home)
    os.environ["XDG_CACHE_HOME"] = str(home / ".cache")
    os.environ["TIKTOKEN_CACHE_DIR"] = str(home / ".cache" / "babeldoc" / "tiktoken")
    Path.home = classmethod(lambda cls: home)
    return home


def prepare_runtime(home: Path, bundled_assets: Path) -> None:
    home = configure_runtime_home(home)
    home.mkdir(parents=True, exist_ok=True)

    cache = home / ".cache" / "babeldoc"
    cache.mkdir(parents=True, exist_ok=True)
    for name in ("fonts", "models", "cmap", "tiktoken"):
        source = bundled_assets / name
        target = cache / name
        if source.is_dir():
            for source_file in source.rglob("*"):
                if not source_file.is_file():
                    continue
                target_file = target / source_file.relative_to(source)
                if not target_file.is_file() or target_file.stat().st_size != source_file.stat().st_size:
                    target_file.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source_file, target_file)


def emit(event: dict) -> None:
    print(json.dumps(event, ensure_ascii=False), flush=True)


async def translate(source: Path, output: Path) -> None:
    from pdf2zh_next.config.model import BasicSettings, PDFSettings, SettingsModel, TranslationSettings
    from pdf2zh_next.config.translate_engine_model import SiliconFlowFreeSettings
    from babeldoc.format.pdf.high_level import async_translate
    from pdf2zh_next.high_level import create_babeldoc_config

    settings = SettingsModel(
        basic=BasicSettings(debug=False),
        translation=TranslationSettings(
            lang_in="en",
            lang_out="zh-CN",
            output=str(output),
            qps=10,
            pool_max_workers=10,
            term_qps=10,
            term_pool_max_workers=10,
            no_auto_extract_glossary=True,
            save_auto_extracted_glossary=False,
        ),
        pdf=PDFSettings(
            no_dual=False,
            no_mono=False,
            use_alternating_pages_dual=False,
            watermark_output_mode="no_watermark",
            translate_table_text=False,
        ),
        translate_engine_settings=SiliconFlowFreeSettings(),
    )
    settings.validate_settings()
    config = create_babeldoc_config(settings, source)
    finished = False
    async for event in async_translate(config):
        if event.get("type") == "progress_update":
            emit({
                "type": "progress",
                "progress": max(0, min(100, int(event.get("overall_progress", 0)))),
            })
        elif event.get("type") == "error":
            raise RuntimeError(str(event.get("error") or "PDF 翻译失败。"))
        elif event.get("type") == "finish":
            result = event["translate_result"]
            mono = getattr(result, "mono_pdf_path", None)
            dual = getattr(result, "dual_pdf_path", None)
            if not mono or not dual:
                raise RuntimeError("PDF 引擎未同时生成中文与双语 PDF。")
            emit({"type": "finish", "mono_pdf_path": str(mono), "dual_pdf_path": str(dual)})
            finished = True
            break
    if not finished:
        raise RuntimeError("PDF 引擎未返回完成结果。")


def self_test() -> int:
    asset_value = os.environ.get("WORKBENCH_PDF_ENGINE_ASSETS", "").strip()
    assets = Path(asset_value).resolve() if asset_value else None
    if assets is None or not assets.is_dir() or not all((assets / name).is_dir() for name in ("fonts", "models", "cmap", "tiktoken")):
        emit({"type": "error", "message": "PDF 引擎缓存资源不完整。"})
        return 2
    home_value = os.environ.get("WORKBENCH_PDF_ENGINE_HOME", "").strip()
    if home_value:
        configure_runtime_home(Path(home_value))
    try:
        from pdf2zh_next.config.model import BasicSettings, PDFSettings, SettingsModel, TranslationSettings
        from pdf2zh_next.config.translate_engine_model import SiliconFlowFreeSettings
        from babeldoc.format.pdf.high_level import async_translate
        from pdf2zh_next.high_level import create_babeldoc_config

        if not all((BasicSettings, PDFSettings, SettingsModel, TranslationSettings, SiliconFlowFreeSettings, async_translate, create_babeldoc_config)):
            raise RuntimeError("PDF 翻译运行时未能加载。")
    except Exception as error:
        emit({"type": "error", "message": str(error)[:1000]})
        return 1
    emit({"type": "self_test", "status": "ok"})
    return 0


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if sys.argv[1:] in (["--help"], ["-h"]):
        print("Usage: workbench-pdf-engine [--help | --self-test | SOURCE.pdf OUTPUT_DIR RUNTIME_HOME]")
        return 0
    if sys.argv[1:] == ["--self-test"]:
        return self_test()
    if len(sys.argv) != 4:
        emit({"type": "error", "message": "helper 参数无效。"})
        return 2
    source, output, home = (Path(value).resolve() for value in sys.argv[1:])
    asset_value = os.environ.get("WORKBENCH_PDF_ENGINE_ASSETS", "").strip()
    assets = Path(asset_value).resolve() if asset_value else None
    if not source.is_file() or assets is None or not assets.is_dir():
        emit({"type": "error", "message": "PDF 引擎输入文件或资源缺失。"})
        return 2
    if not all((assets / name).is_dir() for name in ("fonts", "models", "cmap", "tiktoken")):
        emit({"type": "error", "message": "PDF 引擎缓存资源不完整。"})
        return 2
    output.mkdir(parents=True, exist_ok=True)
    prepare_runtime(home, assets)
    try:
        asyncio.run(translate(source, output))
    except Exception as error:
        emit({"type": "error", "message": str(error)[:1000]})
        return 1
    return 0


if __name__ == "__main__":
    runtime_home = os.environ.get("WORKBENCH_PDF_ENGINE_RUNTIME_HOME", "").strip()
    if runtime_home:
        configure_runtime_home(Path(runtime_home))
    multiprocessing.freeze_support()
    raise SystemExit(main())
