from __future__ import annotations

import os
from pathlib import Path

home = Path(os.environ["WORKBENCH_PDF_ENGINE_BUILD_HOME"]).resolve()
home.mkdir(parents=True, exist_ok=True)
Path.home = classmethod(lambda cls: home)

from PyInstaller.__main__ import run

run()
