from __future__ import annotations

import re
from pathlib import Path
from pypdf import PdfReader


class PDFProblem(Exception):
    pass


def _has_images(page) -> bool:
    try:
        return len(page.images) > 0
    except Exception:
        try:
            resources = page.get("/Resources") or {}
            xobjects = resources.get("/XObject") or {}
            for item in xobjects.values():
                try:
                    if item.get_object().get("/Subtype") == "/Image":
                        return True
                except Exception:
                    continue
        except Exception:
            pass
    return False


def _has_visible_content(page) -> bool:
    try:
        content = page.get_contents()
        if content is None:
            return False
        visible_ops = {b"Tj", b"TJ", b"'", b'"', b"Do", b"S", b"s", b"f", b"F", b"f*", b"B", b"B*", b"b", b"b*", b"sh"}
        return any(operator in visible_ops for _, operator in content.operations)
    except Exception:
        return _has_images(page)


def _clean_lines(raw: str) -> list[str]:
    cleaned = raw.replace("\x00", "").replace("\r", "\n")
    lines: list[str] = []
    for line in cleaned.split("\n"):
        line = line.strip()
        if not line:
            if lines and lines[-1] != "":
                lines.append("")
            continue
        if lines and lines[-1] and lines[-1].endswith("-") and line[:1].islower():
            lines[-1] = lines[-1][:-1] + line
        else:
            lines.append(line)
    while lines and not lines[-1]:
        lines.pop()
    return lines


def _split_long(text: str, limit: int) -> list[str]:
    output: list[str] = []
    remaining = text.strip()
    while len(remaining) > limit:
        cut = remaining.rfind(" ", 0, limit + 1)
        if cut < limit // 2:
            cut = limit
        output.append(remaining[:cut].strip())
        remaining = remaining[cut:].strip()
    if remaining:
        output.append(remaining)
    return output


def make_segments(lines: list[str], page_no: int, limit: int = 2800) -> list[dict[str, int | str]]:
    paragraphs: list[str] = []
    current = ""
    for line in lines:
        if not line:
            if current:
                paragraphs.extend(_split_long(current, limit))
                current = ""
            continue
        current = (current + " " + line).strip()
    if current:
        paragraphs.extend(_split_long(current, limit))
    return [
        {"start_page": page_no, "end_page": page_no, "original_text": paragraph}
        for paragraph in paragraphs
        if paragraph.strip()
    ]


def _candidate_title(raw: str, filename: str, metadata_title: str) -> tuple[str, bool]:
    lines = [line.strip() for line in _clean_lines(raw) if line.strip()]
    normalized_lines = " ".join(re.sub(r"\s+", " ", line) for line in lines[:18]).casefold()
    generic = {"generic export document", "untitled", "untitled document", "document", "pdf document", "article"}
    if metadata_title.strip():
        candidate = re.sub(r"\s+", " ", metadata_title).strip()
        words = re.findall(r"[A-Za-z]{2,}", candidate)
        if candidate.casefold() not in generic and len(words) >= 2 and len(candidate) <= 240:
            if candidate.casefold() in normalized_lines:
                return candidate, True

    excluded = re.compile(
        r"\b(abstract|copyright|doi|www\.|http|journal|vol\.|volume|issn|received|accepted|keywords|email)\b",
        re.I,
    )
    for line in lines[:18]:
        words = re.findall(r"[A-Za-z][A-Za-z'-]*", line)
        if not (4 <= len(words) <= 24 and 18 <= len(line) <= 200):
            continue
        if excluded.search(line) or "@" in line:
            continue
        if re.search(r"\b(?:university|department|institute|laboratory|corresponding author)\b", line, re.I):
            continue
        return line, True
    return "", False


def _candidate_chinese_title(raw: str) -> str:
    excluded = ("作者", "单位", "大学", "学院", "研究所", "医院", "中心", "摘要", "关键词", "基金", "通信作者")
    for line in [line.strip() for line in _clean_lines(raw) if line.strip()][:24]:
        if any(token in line for token in excluded) or len(line) > 120:
            continue
        han = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", line))
        if han >= 6:
            return line
    return ""


def detect_source_language(raw_pages: list[str]) -> str:
    text = "\n".join(raw_pages)
    han = len(re.findall(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]", text))
    latin = len(re.findall(r"[A-Za-z]", text))
    total = han + latin
    if (han >= 200 and total and han / total >= 0.35) or (han >= 40 and total and han / total >= 0.70):
        return "zh"
    if latin >= 200 and total and latin / total >= 0.75:
        return "en"
    return "unknown"


def extract_pdf(path: Path) -> dict:
    try:
        reader = PdfReader(str(path), strict=False)
    except Exception as exc:
        raise PDFProblem("无法读取 PDF 文件。") from exc
    if reader.is_encrypted:
        try:
            if reader.decrypt("") == 0:
                raise PDFProblem("该 PDF 已加密，暂不支持导入。")
        except PDFProblem:
            raise
        except Exception as exc:
            raise PDFProblem("该 PDF 已加密，暂不支持导入。") from exc
    try:
        page_count = len(reader.pages)
        raw_pages = [page.extract_text() or "" for page in reader.pages]
    except Exception as exc:
        raise PDFProblem("PDF 文本解析失败，请检查文件是否损坏。") from exc

    extracted: list[dict] = []
    segments: list[dict[str, int | str]] = []
    for page_no, (page, raw) in enumerate(zip(reader.pages, raw_pages), start=1):
        lines = _clean_lines(raw)
        text = " ".join(line for line in lines if line)
        if text:
            page_segments = make_segments(lines, page_no)
            state = "text" if page_segments else "needs_attention"
            segments.extend(page_segments)
        elif _has_visible_content(page):
            state = "needs_ocr" if _has_images(page) else "needs_attention"
        else:
            state = "blank"
        extracted.append({"page_no": page_no, "status": state, "text_chars": len(text)})

    metadata_title = ""
    try:
        metadata_title = str((reader.metadata or {}).get("/Title") or "")
    except Exception:
        pass
    first_page = raw_pages[0] if raw_pages else ""
    english_title, title_confident = _candidate_title(first_page, path.name, metadata_title)
    source_language = detect_source_language(raw_pages)
    chinese_title = _candidate_chinese_title(first_page) if source_language == "zh" else ""
    has_blocker = any(page["status"] in {"needs_ocr", "needs_attention"} for page in extracted)
    if not segments:
        has_blocker = True
    return {
        "page_count": page_count,
        "pages": extracted,
        "segments": segments,
        "english_title": english_title,
        "chinese_title": chinese_title,
        "source_language": source_language,
        "title_confident": title_confident,
        "has_blocker": has_blocker,
    }


def safe_pdf_name(title: str, fallback: str, short_id: str) -> str:
    value = title.strip() or fallback.strip() or "待确认标题"
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", value)
    value = value.rstrip(" .") or "待确认标题"
    reserved = {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))}
    if value.split(".")[0].upper() in reserved:
        value = "_" + value
    if len(value) > 120:
        value = value[:120].rstrip(" .") or "待确认标题"
    return value + ".pdf"


