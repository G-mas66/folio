"""A cancelled PDF helper must not leave its own child process running."""

import asyncio
import os
import signal
import sys
import tempfile
import unittest
from pathlib import Path

from backend.app import terminate_pdf_process


@unittest.skipIf(sys.platform == "win32", "Windows uses taskkill /T")
class PdfProcessCleanup(unittest.IsolatedAsyncioTestCase):
    async def test_termination_stops_only_the_helper_process_group(self):
        with tempfile.TemporaryDirectory() as temporary:
            marker = Path(temporary) / "descendant-stopped"
            child_script = (
                "import pathlib, signal, sys, time; "
                f"marker = pathlib.Path({str(marker)!r}); "
                "signal.signal(signal.SIGTERM, lambda *_: (marker.write_text('stopped'), sys.exit(0))); "
                "print('ready', flush=True); time.sleep(60)"
            )
            parent_script = (
                "import subprocess, sys, time; "
                f"child = subprocess.Popen([sys.executable, '-c', {child_script!r}], stdout=subprocess.PIPE, text=True); "
                "assert child.stdout.readline().strip() == 'ready'; "
                "print(child.pid, flush=True); time.sleep(60)"
            )
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-c", parent_script,
                stdout=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            assert process.stdout is not None
            child_pid = int((await process.stdout.readline()).decode().strip())
            try:
                await terminate_pdf_process(process)
                self.assertIsNotNone(process.returncode)
                for _ in range(50):
                    if marker.exists():
                        break
                    await asyncio.sleep(0.02)
                self.assertTrue(marker.exists(), "the helper's child received the group termination signal")
            finally:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                if process.returncode is None:
                    await process.wait()
                try:
                    os.kill(child_pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


if __name__ == "__main__":
    unittest.main()
