from __future__ import annotations

import json
import re
from typing import Any


MAX_IMPORT_BYTES = 120 * 1024
TYPE_MAP = {
    "article": "article-journal", "inproceedings": "paper-conference", "conference": "paper-conference",
    "proceedings": "book", "book": "book", "incollection": "chapter", "inbook": "chapter",
    "phdthesis": "thesis", "mastersthesis": "thesis", "techreport": "report", "manual": "document",
    "misc": "document", "unpublished": "manuscript",
}
RIS_TYPE_MAP = {
    "JOUR": "article-journal", "MGZN": "article-magazine", "NEWS": "article-newspaper",
    "CONF": "paper-conference", "CPAPER": "paper-conference", "BOOK": "book", "CHAP": "chapter",
    "RPRT": "report", "THES": "thesis", "UNPB": "manuscript", "ELEC": "webpage",
}


def _check_text(value: str) -> None:
    if len(value.encode("utf-8")) > MAX_IMPORT_BYTES or "\x00" in value:
        raise ValueError("书目导入内容超过 120 KiB 或包含无效字符。")


def _split_names(value: str) -> list[str]:
    parts: list[str] = []
    start = depth = index = 0
    while index < len(value):
        char = value[index]
        if char == "\\":
            index += 2
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth = max(0, depth - 1)
        elif depth == 0 and value[index:index + 3].casefold() == "and":
            before = index == 0 or value[index - 1].isspace()
            after = index + 3 == len(value) or value[index + 3].isspace()
            if before and after:
                parts.append(value[start:index].strip())
                index += 3
                start = index
                continue
        index += 1
    parts.append(value[start:].strip())
    return [part for part in parts if part]


def _author(value: str) -> dict[str, Any]:
    name = value.strip()
    if name.startswith("{") and name.endswith("}"):
        return {"literal": name[1:-1].strip()}
    if "," in name:
        parts = [part.strip() for part in name.split(",")]
        result: dict[str, Any] = {"family": parts[0]}
        if len(parts) == 2:
            result["given"] = parts[1]
        elif len(parts) >= 3:
            result.update({"suffix": parts[1], "given": ", ".join(parts[2:]), "comma-suffix": True})
        return result
    pieces = name.split()
    if len(pieces) == 1:
        return {"family": pieces[0]}
    family_start = len(pieces) - 1
    particle_start = family_start
    while particle_start > 0 and pieces[particle_start - 1][:1].islower():
        particle_start -= 1
    if particle_start < family_start:
        author = {"family": " ".join(pieces[family_start:]), "non-dropping-particle": " ".join(pieces[particle_start:family_start])}
        if particle_start:
            author["given"] = " ".join(pieces[:particle_start])
        return author
    return {"given": " ".join(pieces[:-1]), "family": pieces[-1]}


def _bibtex_entries(text: str) -> list[tuple[str, str, str, str]]:
    entries = []
    cursor = 0
    while True:
        match = re.search(r"@\s*([A-Za-z]+)\s*([({])", text[cursor:])
        if not match:
            break
        start = cursor + match.start()
        kind = match.group(1).lower()
        opening = match.group(2)
        begin = cursor + match.end()
        closing = "}" if opening == "{" else ")"
        depth, quoted, escaped = 1, False, False
        end = begin
        while end < len(text):
            char = text[end]
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = not quoted
            elif not quoted and char == opening:
                depth += 1
            elif not quoted and char == closing:
                depth -= 1
                if depth == 0:
                    break
            end += 1
        if depth:
            raise ValueError("BibTeX 条目未闭合。")
        raw = text[start:end + 1]
        body = text[begin:end]
        if kind not in {"comment", "preamble", "string"}:
            comma = _find_separator(body, {","})
            if comma < 0:
                raise ValueError("BibTeX 条目缺少键和字段。")
            key = body[:comma].strip()
            entries.append((kind, raw, key, body[comma + 1:]))
        cursor = end + 1
    if not entries:
        raise ValueError("没有找到 BibTeX 条目。")
    return entries


def _find_separator(value: str, separators: set[str], start: int = 0) -> int:
    braces = parens = 0
    quoted = escaped = False
    for index in range(start, len(value)):
        char = value[index]
        if escaped:
            escaped = False
        elif char == "\\":
            escaped = True
        elif char == '"':
            quoted = not quoted
        elif not quoted and char == "{":
            braces += 1
        elif not quoted and char == "}":
            braces = max(0, braces - 1)
        elif not quoted and char == "(":
            parens += 1
        elif not quoted and char == ")":
            parens = max(0, parens - 1)
        elif not quoted and braces == 0 and parens == 0 and char in separators:
            return index
    return -1


def _bibtex_fields(body: str) -> dict[str, str]:
    result: dict[str, str] = {}
    cursor = 0
    while cursor < len(body):
        while cursor < len(body) and body[cursor] in " \t\r\n,":
            cursor += 1
        if cursor >= len(body):
            break
        match = re.match(r"([A-Za-z][A-Za-z0-9_-]*)\s*=\s*", body[cursor:])
        if not match:
            raise ValueError("BibTeX 字段格式无效。")
        name = match.group(1).lower()
        cursor += match.end()
        values = []
        while cursor < len(body):
            while cursor < len(body) and body[cursor].isspace():
                cursor += 1
            if cursor >= len(body):
                break
            if body[cursor] == "{":
                depth, start = 1, cursor + 1
                cursor += 1
                while cursor < len(body) and depth:
                    if body[cursor] == "\\":
                        cursor += 2
                        continue
                    if body[cursor] == "{":
                        depth += 1
                    elif body[cursor] == "}":
                        depth -= 1
                    cursor += 1
                if depth:
                    raise ValueError("BibTeX 字段中的花括号未闭合。")
                values.append(body[start:cursor - 1].strip())
            elif body[cursor] == '"':
                cursor += 1
                start = cursor
                escaped = False
                while cursor < len(body):
                    if body[cursor] == '"' and not escaped:
                        break
                    escaped = body[cursor] == "\\" and not escaped
                    if body[cursor] != "\\":
                        escaped = False
                    cursor += 1
                if cursor >= len(body):
                    raise ValueError("BibTeX 引号字段未闭合。")
                values.append(body[start:cursor].strip())
                cursor += 1
            else:
                end = _find_separator(body, {",", "#"}, cursor)
                if end < 0:
                    end = len(body)
                values.append(body[cursor:end].strip())
                cursor = end
            while cursor < len(body) and body[cursor].isspace():
                cursor += 1
            if cursor < len(body) and body[cursor] == "#":
                cursor += 1
                continue
            break
        if values:
            result[name] = " ".join(part for part in values if part)
        while cursor < len(body) and body[cursor] not in ",":
            cursor += 1
    return result


def _csl_from_bibtex(kind: str, fields: dict[str, str], entry_id: str) -> dict[str, Any]:
    csl: dict[str, Any] = {"id": entry_id, "type": TYPE_MAP.get(kind, "document")}
    for source, target in (("title", "title"), ("journal", "container-title"), ("journaltitle", "container-title"), ("booktitle", "container-title"),
                           ("volume", "volume"), ("number", "issue"), ("series", "collection-title"), ("pages", "page"), ("publisher", "publisher"),
                           ("address", "publisher-place"), ("doi", "DOI"), ("url", "URL"), ("isbn", "ISBN"), ("issn", "ISSN"),
                           ("edition", "edition"), ("abstract", "abstract"), ("keywords", "keyword"), ("note", "note")):
        value = fields.get(source, "").strip()
        if value:
            csl[target] = value
    if fields.get("year", "").isdigit() and len(fields["year"]) == 4:
        csl["issued"] = {"date-parts": [[int(fields["year"])] ]}
    if fields.get("month") and "issued" in csl:
        month = fields["month"].strip()
        month_number = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}.get(month[:3].lower())
        if month.isdigit():
            month_number = int(month)
        if month_number and 1 <= month_number <= 12:
            csl["issued"]["date-parts"][0].append(month_number)
    if fields.get("author"):
        csl["author"] = [_author(name) for name in _split_names(fields["author"])]
    if fields.get("editor"):
        csl["editor"] = [_author(name) for name in _split_names(fields["editor"])]
    for source, target in (("organization", "authority"), ("institution", "authority"), ("school", "publisher"), ("chapter", "chapter-number"),
                           ("howpublished", "medium"), ("language", "language")):
        if fields.get(source) and target not in csl:
            csl[target] = fields[source]
    return csl


def _parse_bibtex(text: str) -> list[dict[str, Any]]:
    entries = _bibtex_entries(text)
    if len(entries) > 100:
        raise ValueError("一次最多导入 100 条书目。")
    result = []
    for kind, raw, key, fields_text in entries:
        result.append({"record": _csl_from_bibtex(kind, _bibtex_fields(fields_text), key or f"import-{len(result) + 1}"), "source_citation": raw})
    return result


def _parse_ris(text: str) -> list[dict[str, Any]]:
    result = []
    current: dict[str, list[str]] = {}
    raw_lines: list[str] = []

    def finish() -> None:
        if not current:
            return
        if len(result) >= 100:
            raise ValueError("一次最多导入 100 条书目。")
        tags = {key: values for key, values in current.items()}
        get = lambda *keys: next((tags[key][0] for key in keys if tags.get(key)), "")
        kind = get("TY").split("/", 1)[0].upper()
        csl: dict[str, Any] = {"id": f"import-{len(result) + 1}", "type": RIS_TYPE_MAP.get(kind, "document")}
        for source, target in (("TI", "title"), ("T1", "title"), ("JF", "container-title"), ("JO", "container-title"), ("JA", "container-title"),
                               ("T2", "container-title"), ("BT", "container-title"), ("VL", "volume"), ("IS", "issue"), ("SP", "page"),
                               ("DO", "DOI"), ("UR", "URL"), ("PB", "publisher"), ("CY", "publisher-place"), ("AB", "abstract"), ("SN", "ISBN")):
            value = get(source)
            if value and target not in csl:
                csl[target] = value.strip()
        start_page, end_page = get("SP"), get("EP")
        if start_page and end_page:
            csl["page"] = f"{start_page}-{end_page}"
        date = get("PY", "Y1", "DA")
        match = re.search(r"\b(\d{4})(?:[/-](\d{1,2}))?", date)
        if match:
            parts = [int(match.group(1))]
            if match.group(2):
                parts.append(int(match.group(2)))
            csl["issued"] = {"date-parts": [parts]}
        authors = tags.get("AU") or tags.get("A1") or []
        if authors:
            csl["author"] = [_author(author) for author in authors]
        editors = tags.get("ED") or []
        if editors:
            csl["editor"] = [_author(editor) for editor in editors]
        result.append({"record": csl, "source_citation": "\n".join(raw_lines).strip()})

    for line in text.splitlines():
        match = re.match(r"^([A-Z0-9]{2})\s*-\s*(.*)$", line)
        if not match:
            if current:
                current.setdefault("N1", []).append(line.strip())
                raw_lines.append(line)
            continue
        tag, value = match.group(1), match.group(2).strip()
        raw_lines.append(line)
        if tag == "TY" and current:
            finish()
            current, raw_lines = {}, []
            raw_lines.append(line)
        if tag == "ER":
            finish()
            current, raw_lines = {}, []
        else:
            current.setdefault(tag, []).append(value)
    finish()
    if not result:
        raise ValueError("没有找到 RIS 条目。")
    return result


def parse_import(format: str, data: Any) -> list[dict[str, Any]]:
    if not isinstance(format, str) or format not in {"bibtex", "ris", "csl-json"}:
        raise ValueError("仅支持 BibTeX、RIS 和 CSL-JSON。")
    if format == "csl-json":
        if isinstance(data, str):
            _check_text(data)
            try:
                value = json.loads(data)
            except json.JSONDecodeError as exc:
                raise ValueError("CSL-JSON 格式无效。") from exc
            raw = data
        else:
            value = data
            raw = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
            _check_text(raw)
        records = value if isinstance(value, list) else [value]
        if not records or len(records) > 100 or any(not isinstance(record, dict) for record in records):
            raise ValueError("CSL-JSON 需为不超过 100 条的对象列表。")
        return [
            {"record": record, "source_citation": raw if len(records) == 1 else json.dumps(record, ensure_ascii=False, separators=(",", ":"))}
            for record in records
        ]

    if not isinstance(data, str):
        raise ValueError("导入内容需为文本。")
    _check_text(data)
    return _parse_bibtex(data) if format == "bibtex" else _parse_ris(data)
