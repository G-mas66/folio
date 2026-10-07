"""Article-level terminology is carried forward and source-checked."""

import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend import ai
from backend.db import connect, initialize
from review.paths import REVIEW_ROOT


class GlossaryContract(unittest.TestCase):
    def test_translated_terms_are_saved_and_reused_for_the_same_paper(self):
        with tempfile.TemporaryDirectory(dir=REVIEW_ROOT) as data_dir:
            with patch.dict(os.environ, {"WORKBENCH_DATA_DIR": data_dir}):
                initialize()
                with connect() as db:
                    db.execute(
                        "INSERT INTO papers(id, source_hash, source_name, file_name, english_title, title_confident, page_count, status, created_at, updated_at) "
                        "VALUES ('paper1', ?, 'source.pdf', 'copy.pdf', 'Quartz Study', 1, 1, 'waiting_api', 'now', 'now')",
                        ("1" * 64,),
                    )

                requests = []

                def completion(messages, **kwargs):
                    requests.append(messages)
                    if len(requests) == 1:
                        return {"content": "石英测量结果。\n<WORKBENCH_GLOSSARY>\nQuartz\t石英\nmeasurement\t测量"}
                    return {"content": "石英测量完成。"}

                with patch.object(ai, "chat_completion", side_effect=completion):
                    first = ai.translate_text("Quartz measurement result", context="论文：Quartz Study。", paper_id="paper1")
                    second = ai.translate_text("Quartz measurement complete", context="论文：Quartz Study。", paper_id="paper1")

                self.assertEqual(first, "石英测量结果。")
                self.assertEqual(second, "石英测量完成。")
                self.assertIn("Quartz → 石英", requests[1][1]["content"])
                self.assertIn("measurement → 测量", requests[1][1]["content"])
                with connect() as db:
                    entries = db.execute("SELECT term, translation FROM paper_glossary WHERE paper_id = 'paper1'").fetchall()
                self.assertEqual({(row["term"], row["translation"]) for row in entries}, {("Quartz", "石英"), ("measurement", "测量")})


if __name__ == "__main__":
    unittest.main()
