import os
import sys
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

    def test_health_advertises_supported_operations(self):
        result = companion.execute({"version": 1, "op": "health"})
        self.assertTrue(result["ok"])
        self.assertIn("run_process", result["data"]["operations"])
        self.assertLessEqual(result["data"]["limits"]["max_request_bytes"], 1024 * 1024)

    def test_windows_drive_qualified_paths_rejected(self):
        with self.assertRaises(companion.BridgeError):
            companion._relative_path(self.root, "C:outside.txt")

    def test_listing_is_bounded(self):
        for i in range(companion.MAX_LIST_ENTRIES + 3):
            (self.root / ("entry-" + str(i) + ".txt")).write_text("x", encoding="utf-8")
        result = companion._list_files(self.root, {
            "version": 1, "op": "list_files", "approved": True, "path": "."
        })
        self.assertEqual(len(result["entries"]), companion.MAX_LIST_ENTRIES)
        self.assertTrue(result["truncated"])

    def test_process_cannot_change_working_directory_outside_workspace(self):
        with self.assertRaises(companion.BridgeError):
            companion._run_process(self.root, {
                "version": 1, "op": "run_process", "approved": True,
                "executable": sys.executable, "args": ["--version"],
                "cwd": "../"
            })

    def test_write_files_batch(self):
        result = companion._write_files(self.root, {
            "version": 1, "op": "write_files", "approved": True,
            "files": [
                {"path": "one.txt", "content": "one"},
                {"path": "two.txt", "content": "two\n"}
            ]
        })
        self.assertEqual(result["count"], 2)
        self.assertTrue((self.root / "one.txt").exists())
        self.assertEqual((self.root / "two.txt").read_text(encoding="utf-8"), "two\n")

    def test_write_files_requires_approval(self):
        with self.assertRaises(companion.BridgeError):
            companion._write_files(self.root, {
                "version": 1, "op": "write_files",
                "files": [{"path": "one.txt", "content": "one"}]
            })

    def test_write_files_preflight_rejects_duplicate_without_writes(self):
        with self.assertRaises(companion.BridgeError):
            companion._write_files(self.root, {
                "version": 1, "op": "write_files", "approved": True,
                "files": [
                    {"path": "same.txt", "content": "one"},
                    {"path": "same.txt", "content": "two"}
                ]
            })
        self.assertFalse((self.root / "same.txt").exists())

    def test_write_files_rollback_restores_first_file_if_second_replace_fails(self):
        first = self.root / "first.txt"
        second = self.root / "second.txt"
        first.write_text("before one", encoding="utf-8")
        second.write_text("before two", encoding="utf-8")
        real_replace = companion.os.replace
        calls = {"count": 0}
        def fail_second_replace(source, target):
            calls["count"] += 1
            if calls["count"] == 2:
                raise OSError("simulated replacement failure")
            return real_replace(source, target)
        with patch.object(companion.os, "replace", side_effect=fail_second_replace):
            with self.assertRaises(companion.BridgeError):
                companion._write_files(self.root, {
                    "version": 1, "op": "write_files", "approved": True,
                    "files": [
                        {"path": "first.txt", "content": "after one"},
                        {"path": "second.txt", "content": "after two"}
                    ]
                })
        self.assertEqual(first.read_text(encoding="utf-8"), "before one")
        self.assertEqual(second.read_text(encoding="utf-8"), "before two")

    def test_write_files_batch(self):
        result = companion._write_files(self.root, {
            "version": 1, "op": "write_files", "approved": True,
            "files": [
                {"path": "one.txt", "content": "one"},
                {"path": "two.txt", "content": "two\\n"}
            ]
        })
        self.assertEqual(result["count"], 2)
        self.assertTrue((self.root / "one.txt").exists())
        self.assertEqual((self.root / "two.txt").read_text(encoding="utf-8"), "two\\n")

    def test_write_files_requires_approval(self):
        with self.assertRaises(companion.BridgeError):
            companion._write_files(self.root, {
                "version": 1, "op": "write_files",
                "files": [{"path": "one.txt", "content": "one"}]
            })

    def test_write_files_preflight_rejects_duplicate_without_writes(self):
        with self.assertRaises(companion.BridgeError):
            companion._write_files(self.root, {
                "version": 1, "op": "write_files", "approved": True,
                "files": [
                    {"path": "same.txt", "content": "one"},
                    {"path": "same.txt", "content": "two"}
                ]
            })
        self.assertFalse((self.root / "same.txt").exists())

    def test_write_files_rollback_restores_first_file_if_second_replace_fails(self):
        first = self.root / "first.txt"
        second = self.root / "second.txt"
        first.write_text("before one", encoding="utf-8")
        second.write_text("before two", encoding="utf-8")
        real_replace = companion.os.replace
        calls = {"count": 0}
        def fail_second_replace(source, target):
            calls["count"] += 1
            if calls["count"] == 2:
                raise OSError("simulated replacement failure")
            return real_replace(source, target)
        with patch.object(companion.os, "replace", side_effect=fail_second_replace):
            with self.assertRaises(companion.BridgeError):
                companion._write_files(self.root, {
                    "version": 1, "op": "write_files", "approved": True,
                    "files": [
                        {"path": "first.txt", "content": "after one"},
                        {"path": "second.txt", "content": "after two"}
                    ]
                })
        self.assertEqual(first.read_text(encoding="utf-8"), "before one")
        self.assertEqual(second.read_text(encoding="utf-8"), "before two")

    def test_run_process_requires_approval(self):
        with self.assertRaises(companion.BridgeError):
            companion._run_process(self.root, {
                "version": 1, "op": "run_process", "executable": sys.executable,
                "args": ["-c", "print('should not run')"], "cwd": "."
            })

    def test_run_process_requires_argument_array(self):
        with self.assertRaises(companion.BridgeError):
            companion._run_process(self.root, {
                "version": 1, "op": "run_process", "approved": True,
                "executable": sys.executable, "args": "print('no shell string')", "cwd": "."
            })

    def test_run_process_reports_actual_exit_code_and_streams(self):
        result = companion._run_process(self.root, {
            "version": 1, "op": "run_process", "approved": True,
            "executable": sys.executable,
            "args": ["-c", "import sys; print('bridge stdout'); print('bridge stderr', file=sys.stderr); sys.exit(7)"],
            "cwd": ".", "timeout_seconds": 10
        })
        self.assertEqual(result["exit_code"], 7)
        self.assertFalse(result["timed_out"])
        self.assertIn("bridge stdout", result["stdout"])
        self.assertIn("bridge stderr", result["stderr"])
        self.assertFalse(result["command"][0] == "python")

    def test_missing_config_is_neat_error(self):
        with patch.dict(os.environ, {"LOCALAPPDATA": str(self.root)}):
            result = companion.execute({
                "version": 1, "op": "list_files", "approved": True, "path": "."
            })
        self.assertFalse(result["ok"])
        self.assertIn("Configuration not found", result["error"])


if __name__ == "__main__":
    unittest.main()
