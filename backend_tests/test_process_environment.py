"""Environment isolation for the independently packaged PDF helper."""

import ast
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.process_environment import pdf_engine_environment


class PDFEngineEnvironmentTests(unittest.TestCase):
    def environment(self, source, *, frozen=True, entry="", bundle=None):
        with patch.dict(os.environ, source, clear=True), patch("sys.frozen", frozen, create=True), patch("sys._MEIPASS", bundle, create=True):
            result = pdf_engine_environment(entry=entry)
            self.assertEqual(dict(os.environ), source)
            return result

    def test_frozen_independent_helper_requests_bootloader_reset(self):
        source = {"_PYI_ARCHIVE_FILE": "/parent/service", "_PYI_APPLICATION_HOME_DIR": "/parent/bundle", "_PYI_PARENT_PROCESS_LEVEL": "1", "WORKBENCH_SETTING": "keep"}
        result = self.environment(source)
        self.assertEqual(result, {**source, "PYINSTALLER_RESET_ENVIRONMENT": "1"})

    def test_source_and_entry_modes_are_unchanged_copies(self):
        source = {"LD_LIBRARY_PATH": "/parent/bundle", "SSL_CERT_FILE": "/user/custom.pem"}
        for frozen, entry in ((False, ""), (False, "entry.py"), (True, "entry.py")):
            with self.subTest(frozen=frozen, entry=entry):
                result = self.environment(source, frozen=frozen, entry=entry, bundle="/parent/bundle")
                self.assertEqual(result, source)
                self.assertIsNot(result, os.environ)

    def test_removes_only_absolute_paths_inside_parent_bundle(self):
        with tempfile.TemporaryDirectory() as temporary:
            bundle = Path(temporary) / "bundle"
            external = str(Path(temporary) / "bundle-other")
            variables = ("LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "DYLD_FALLBACK_LIBRARY_PATH")
            source = {name: os.pathsep.join((str(bundle), str(bundle / "lib"), external, "", "relative/lib")) for name in variables}
            result = self.environment(source, bundle=str(bundle))
            for name in variables:
                self.assertEqual(result[name], os.pathsep.join((external, "", "relative/lib")))

    def test_unsets_library_variable_when_all_paths_are_parent_bundle(self):
        with tempfile.TemporaryDirectory() as temporary:
            result = self.environment({"DYLD_LIBRARY_PATH": temporary}, bundle=temporary)
            self.assertNotIn("DYLD_LIBRARY_PATH", result)

    def test_missing_bundle_does_not_guess_library_path_origin(self):
        source = {"DYLD_LIBRARY_PATH": "/unknown/lib"}
        result = self.environment(source)
        self.assertEqual(result["DYLD_LIBRARY_PATH"], source["DYLD_LIBRARY_PATH"])

    def test_explicit_ca_proxy_and_other_configuration_are_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = {name: str(Path(temporary) / "custom.pem") for name in ("SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE")}
            source.update({"HTTPS_PROXY": "http://proxy.invalid:8080", "PATH": temporary, "LD_LIBRARY_PATH_ORIG": "/user/lib"})
            result = self.environment(source, bundle=temporary)
            for name, value in source.items():
                self.assertEqual(result[name], value)

    def test_run_pdf_engine_uses_environment_builder_with_entry_mode(self):
        tree = ast.parse((Path(__file__).resolve().parents[1] / "backend" / "app.py").read_text(encoding="utf-8"))
        function = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef) and node.name == "run_pdf_engine")
        assignment = next(node for node in function.body if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "environment" for target in node.targets))
        self.assertEqual(ast.dump(assignment.value), ast.dump(ast.parse("pdf_engine_environment(entry=entry)", mode="eval").body))

    def test_existing_reset_flag_is_overridden_only_for_frozen_helper(self):
        self.assertEqual(self.environment({"PYINSTALLER_RESET_ENVIRONMENT": "0"})["PYINSTALLER_RESET_ENVIRONMENT"], "1")
        self.assertEqual(self.environment({"PYINSTALLER_RESET_ENVIRONMENT": "0"}, entry="entry.py")["PYINSTALLER_RESET_ENVIRONMENT"], "0")


if __name__ == "__main__":
    unittest.main()
