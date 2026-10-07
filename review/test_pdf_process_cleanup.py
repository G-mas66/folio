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
                "import signal, subprocess, sys, time\n"
                f"child = subprocess.Popen([sys.executable, '-c', {child_script!r}], stdout=subprocess.PIPE, text=True)\n"
                "assert child.stdout.readline().strip() == 'ready'\n"
                "def stop(*_):\n"
                "    child.wait(timeout=10)\n"
                "    print('child-reaped', flush=True)\n"
                "    sys.exit(0)\n"
                "signal.signal(signal.SIGTERM, stop)\n"
                "print(child.pid, flush=True)\n"
                "time.sleep(60)\n"
            )
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-c", parent_script,
                stdout=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            assert process.stdout is not None
            self.assertGreater(int((await process.stdout.readline()).decode().strip()), 0)
            try:
                await terminate_pdf_process(process)
                self.assertIsNotNone(process.returncode)
                self.assertEqual((await process.stdout.readline()).decode().strip(), "child-reaped")
                for _ in range(50):
                    if marker.exists():
                        break
                    await asyncio.sleep(0.02)
                self.assertTrue(marker.exists(), "the helper's child received the group termination signal")
            finally:
                if process.returncode is None:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    await process.wait()


if __name__ == "__main__":
    unittest.main()
