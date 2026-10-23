import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from windows import companion


class CompanionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def test_health(self):
        result = companion.execute({"version": 1, "op": "health"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["data"]["status"], "ready")

    def test_unknown_operation_rejected(self):
        result = companion.execute({"version": 1, "op": "run_shell", "command": "whoami"})
        self.assertFalse(result["ok"])
        self.assertIn("unsupported", result["error"])

    def test_extra_fields_rejected(self):
        with self.assertRaises(companion.BridgeError):
            companion._list_files(self.root, {
                "version": 1, "op": "list_files", "approved": True, "path": ".", "command": "whoami"
            })

    def test_path_traversal_rejected(self):
        with self.assertRaises(companion.BridgeError):
            companion._relative_path(self.root, "../outside.txt")

    def test_absolute_path_rejected(self):
        with self.assertRaises(companion.BridgeError):
            companion._relative_path(self.root, str(self.root / "outside.txt"))

    def test_symlink_outside_rejected(self):
        outside = self.root.parent / ("redbridge-outside-" + next(iter([self.root.name])) + ".txt")
        outside.write_text("do not read", encoding="utf-8")
        link = self.root / "escape.txt"
        try:
            link.symlink_to(outside)
            with self.assertRaises(companion.BridgeError):
                companion._relative_path(self.root, "escape.txt")
        except (OSError, NotImplementedError):
            self.skipTest("Symlink creation not available in this environment")
        finally:
            outside.unlink(missing_ok=True)

    def test_write_requires_approval(self):
        with self.assertRaises(companion.BridgeError):
            companion._write_file(self.root, {
                "version": 1, "op": "write_file", "path": "a.txt", "content": "hello"
            })

    def test_write_and_read(self):
        written = companion._write_file(self.root, {
            "version": 1, "op": "write_file", "approved": True, "path": "a.txt", "content": "hello"
        })
        self.assertEqual(written["bytes_written"], 5)
        read = companion._read_file(self.root, {
            "version": 1, "op": "read_file", "approved": True, "path": "a.txt"
        })
        self.assertEqual(read["content"], "hello")

    def test_write_rejects_missing_parent(self):
        with self.assertRaises(companion.BridgeError):
            companion._write_file(self.root, {
                "version": 1, "op": "write_file", "approved": True,
                "path": "missing/a.txt", "content": "hello"
            })

    def test_unknown_version_rejected(self):
        result = companion.execute({"version": 2, "op": "health"})
        self.assertFalse(result["ok"])

    def test_listing_is_bounded(self):
        for i in range(companion.MAX_LIST_ENTRIES + 3):
            (self.root / ("entry-" + str(i) + ".txt")).write_text("x", encoding="utf-8")
        result = companion._list_files(self.root, {
            "version": 1, "op": "list_files", "approved": True, "path": "."
        })
        self.assertEqual(len(result["entries"]), companion.MAX_LIST_ENTRIES)
        self.assertTrue(result["truncated"])

    def test_missing_config_is_neat_error(self):
        with patch.dict(os.environ, {"LOCALAPPDATA": str(self.root)}):
            result = companion.execute({
                "version": 1, "op": "list_files", "approved": True, "path": "."
            })
        self.assertFalse(result["ok"])
        self.assertIn("Configuration not found", result["error"])


if __name__ == "__main__":
    unittest.main()
