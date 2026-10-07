"""Locations for synthetic review fixtures and temporary test data."""

import os
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REVIEW_ROOT = Path(os.environ.get("WORKBENCH_REVIEW_ROOT") or ROOT / ".review").resolve()
FIXTURE_ROOT = Path(os.environ.get("WORKBENCH_REVIEW_FIXTURES_DIR") or REVIEW_ROOT / "fixtures").resolve()
