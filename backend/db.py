from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

FOLDER_COLORS = ("#42775f", "#4f718f", "#95723e", "#8a6386", "#4a8080", "#a65f4d")


def data_root() -> Path:
    configured = os.environ.get("WORKBENCH_DATA_DIR")
    root = Path(configured) if configured else Path(r"D:\个人工作台\data")
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def library_root() -> Path:
    root = data_root() / "papers"
    root.mkdir(parents=True, exist_ok=True)
    return root


def database_path() -> Path:
    return data_root() / "workbench.sqlite"


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    connection = sqlite3.connect(database_path(), timeout=30)
    try:
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA busy_timeout = 30000")
        with connection:
            yield connection
    finally:
        connection.close()


def initialize() -> None:
    with connect() as db:
        db.executescript(
            """
            CREATE TABLE IF NOT EXISTS folders (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                created_at TEXT NOT NULL,
                color TEXT NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS papers (
                id TEXT PRIMARY KEY,
                source_hash TEXT NOT NULL UNIQUE,
                source_name TEXT NOT NULL,
                file_name TEXT NOT NULL,
                english_title TEXT NOT NULL DEFAULT '',
                chinese_title TEXT NOT NULL DEFAULT '',
                title_confident INTEGER NOT NULL DEFAULT 0,
                page_count INTEGER NOT NULL,
                status TEXT NOT NULL,
                error TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_page INTEGER NOT NULL DEFAULT 1,
                mono_pdf_file_name TEXT NOT NULL DEFAULT '',
                dual_pdf_file_name TEXT NOT NULL DEFAULT '',
                pdf_progress INTEGER NOT NULL DEFAULT 0,
                model_override TEXT NOT NULL DEFAULT '',
                folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL
            );
            CREATE TABLE IF NOT EXISTS pages (
                paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                page_no INTEGER NOT NULL,
                extraction_status TEXT NOT NULL,
                text_chars INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (paper_id, page_no)
            );
            CREATE TABLE IF NOT EXISTS segments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                sequence_no INTEGER NOT NULL,
                start_page INTEGER NOT NULL,
                end_page INTEGER NOT NULL,
                original_text TEXT NOT NULL,
                translation TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                UNIQUE (paper_id, sequence_no)
            );
            CREATE INDEX IF NOT EXISTS segments_by_paper ON segments(paper_id, sequence_no);
            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                base_url TEXT NOT NULL,
                model TEXT NOT NULL,
                model_options_json TEXT NOT NULL DEFAULT '[]',
                models_url TEXT NOT NULL DEFAULT '',
                web_search_enabled INTEGER NOT NULL DEFAULT 1,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS api_usage (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                paper_id TEXT REFERENCES papers(id) ON DELETE SET NULL,
                operation TEXT NOT NULL,
                prompt_tokens INTEGER,
                completion_tokens INTEGER,
                total_tokens INTEGER,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                sources_json TEXT NOT NULL DEFAULT '[]',
                reasoning TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'completed',
                error TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS analysis_runs (
                id TEXT PRIMARY KEY,
                paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                kind TEXT NOT NULL,
                question TEXT NOT NULL,
                status TEXT NOT NULL,
                error TEXT NOT NULL DEFAULT '',
                final_answer TEXT NOT NULL DEFAULT '',
                sources_json TEXT NOT NULL DEFAULT '[]',
                model_snapshot TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS analysis_chunks (
                run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
                chunk_no INTEGER NOT NULL,
                source_ids_json TEXT NOT NULL,
                response TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                error TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (run_id, chunk_no)
            );
            CREATE TABLE IF NOT EXISTS paper_glossary (
                paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                term TEXT NOT NULL COLLATE NOCASE,
                translation TEXT NOT NULL,
                PRIMARY KEY (paper_id, term)
            );
            CREATE TABLE IF NOT EXISTS paper_notes (
                paper_id TEXT PRIMARY KEY REFERENCES papers(id) ON DELETE CASCADE,
                text TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS paper_annotations (
                id TEXT PRIMARY KEY,
                paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
                pdf_kind TEXT NOT NULL,
                page_no INTEGER NOT NULL,
                rects_json TEXT NOT NULL,
                selected_text TEXT NOT NULL DEFAULT '',
                comment TEXT NOT NULL DEFAULT '',
                color TEXT NOT NULL,
                kind TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS annotations_by_paper_page ON paper_annotations(paper_id, pdf_kind, page_no);
            """
        )
        columns = {row["name"] for row in db.execute("PRAGMA table_info(papers)").fetchall()}
        for name, definition in (
            ("mono_pdf_file_name", "TEXT NOT NULL DEFAULT ''"),
            ("dual_pdf_file_name", "TEXT NOT NULL DEFAULT ''"),
            ("pdf_progress", "INTEGER NOT NULL DEFAULT 0"),
            ("model_override", "TEXT NOT NULL DEFAULT ''"),
            ("folder_id", "TEXT REFERENCES folders(id) ON DELETE SET NULL"),
        ):
            if name not in columns:
                db.execute(f"ALTER TABLE papers ADD COLUMN {name} {definition}")
        db.execute("CREATE INDEX IF NOT EXISTS papers_by_folder ON papers(folder_id)")
        folder_columns = {row["name"] for row in db.execute("PRAGMA table_info(folders)").fetchall()}
        if "color" not in folder_columns:
            db.execute("ALTER TABLE folders ADD COLUMN color TEXT NOT NULL DEFAULT ''")
        color_counts = {color: 0 for color in FOLDER_COLORS}
        folder_rows = db.execute("SELECT id, color FROM folders ORDER BY created_at, id").fetchall()
        for row in folder_rows:
            if row["color"] in color_counts:
                color_counts[row["color"]] += 1
                continue
            if row["color"]:
                continue
            color = next((candidate for candidate in FOLDER_COLORS if color_counts[candidate] == 0), min(FOLDER_COLORS, key=lambda candidate: color_counts[candidate]))
            db.execute("UPDATE folders SET color = ? WHERE id = ?", (color, row["id"]))
            color_counts[color] += 1
        for table, name, definition in (
            ("settings", "model_options_json", "TEXT NOT NULL DEFAULT '[]'"),
            ("settings", "models_url", "TEXT NOT NULL DEFAULT ''"),
            ("settings", "web_search_enabled", "INTEGER NOT NULL DEFAULT 1"),
            ("analysis_runs", "model_snapshot", "TEXT NOT NULL DEFAULT ''"),
            ("chat_messages", "reasoning", "TEXT NOT NULL DEFAULT ''"),
            ("chat_messages", "status", "TEXT NOT NULL DEFAULT 'completed'"),
            ("chat_messages", "error", "TEXT NOT NULL DEFAULT ''"),
        ):
            columns = {row["name"] for row in db.execute(f"PRAGMA table_info({table})").fetchall()}
            if name not in columns:
                db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")
        db.execute("UPDATE chat_messages SET status = 'interrupted', error = '应用关闭时回答未完成；部分内容已保留。' WHERE status = 'streaming'")
        db.execute("UPDATE analysis_runs SET status = 'interrupted', error = '应用关闭时总结未完成；可继续重试。', updated_at = datetime('now') WHERE kind = 'full_prompt' AND status = 'running'")
