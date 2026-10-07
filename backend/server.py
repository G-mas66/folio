from __future__ import annotations

import os
import uvicorn
from . import app


def main() -> None:
    port = int(os.environ.get("WORKBENCH_PORT", "8765"))
    uvicorn.run(app.app, host="127.0.0.1", port=port, log_level="warning", access_log=False)


if __name__ == "__main__":
    main()
