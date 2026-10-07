"""Credential namespace remains stable when only the library location changes."""
import hashlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend import ai
from backend.db import data_root

ROOT = Path(__file__).resolve().parents[1]


class StorageIdentityReview(unittest.TestCase):
    def test_legacy_data_root_namespace_is_unchanged(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.review') as directory, patch.dict(os.environ, {'WORKBENCH_DATA_DIR': directory}):
            with patch.dict(os.environ):
                os.environ.pop('WORKBENCH_CREDENTIAL_ROOT', None)
                digest = hashlib.sha256(str(data_root()).casefold().encode('utf-8')).hexdigest()[:16]
                self.assertEqual(ai.credential_service(), f'personal-paper-workbench-{digest}')

    def test_moved_library_keeps_original_credential_namespace(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.review') as directory:
            first, second = Path(directory) / 'old', Path(directory) / 'new'
            first.mkdir()
            second.mkdir()
            with patch.dict(os.environ, {'WORKBENCH_DATA_DIR': str(first)}):
                with patch.dict(os.environ):
                    os.environ.pop('WORKBENCH_CREDENTIAL_ROOT', None)
                    original = ai.credential_service()
            with patch.dict(os.environ, {'WORKBENCH_DATA_DIR': str(second), 'WORKBENCH_CREDENTIAL_ROOT': str(first)}):
                self.assertEqual(ai.credential_service(), original)
                self.assertEqual(data_root(), second.resolve())

    def test_key_lookup_uses_identity_without_copying_credentials(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.review') as directory:
            old, new = Path(directory) / 'old', Path(directory) / 'new'
            old.mkdir()
            new.mkdir()
            expected = 'personal-paper-workbench-' + hashlib.sha256(str(old.resolve()).casefold().encode('utf-8')).hexdigest()[:16]
            with patch.dict(os.environ, {'WORKBENCH_DATA_DIR': str(new), 'WORKBENCH_CREDENTIAL_ROOT': str(old)}):
                with patch('keyring.get_password', return_value='dummy-storage-review-key') as lookup:
                    self.assertTrue(ai.key_is_configured())
                    self.assertEqual(ai.saved_api_key(), 'dummy-storage-review-key')
                    self.assertEqual(lookup.call_args.args, (expected, 'api-key'))


if __name__ == '__main__':
    unittest.main()
