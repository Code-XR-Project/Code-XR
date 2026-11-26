import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
PYTHON_ROOT = PROJECT_ROOT / "backend" / "src"
for extra_path in [PYTHON_ROOT, PYTHON_ROOT / "utils", PYTHON_ROOT / "tools"]:
    if str(extra_path) not in sys.path:
        sys.path.insert(0, str(extra_path))


WORKER_PATH = (
    PYTHON_ROOT / "export" / "git_export_analysis_worker.py"
)


class GitExportAnalysisWorkerTests(unittest.TestCase):
    def test_directory_and_file_results_are_written_atomically(self):
        # The worker imports the backend by name; drop cached copies so it binds
        # to the files on disk, and put them back afterwards.
        isolated_names = [
            "code_metrics_analyzer",
            "file_analysis_engine",
            "file_metric_summary",
        ]
        originals = {name: sys.modules.get(name) for name in isolated_names}
        try:
            for name in isolated_names:
                sys.modules.pop(name, None)
            worker_spec = importlib.util.spec_from_file_location(
                "git_export_analysis_worker_test",
                WORKER_PATH,
            )
            worker_module = importlib.util.module_from_spec(worker_spec)
            worker_spec.loader.exec_module(worker_module)

            with tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                source = root / "sample.py"
                source.write_text("def sample():\n    return 1\n", encoding="utf-8")

                directory_output = root / "directory.json"
                worker_module.analyze(
                    {
                        "id": "directory",
                        "inputPath": str(source),
                        "outputPath": str(directory_output),
                        "targetType": "directory",
                    }
                )
                directory_result = json.loads(directory_output.read_text(encoding="utf-8"))
                self.assertEqual(directory_result["fileName"], "sample.py")
                self.assertEqual(directory_result["functionCount"], 1)

                file_output = root / "file.json"
                worker_module.analyze(
                    {
                        "id": "file",
                        "inputPath": str(source),
                        "outputPath": str(file_output),
                        "targetType": "file",
                    }
                )
                file_result = json.loads(file_output.read_text(encoding="utf-8"))
                self.assertEqual(len(file_result), 1)
                self.assertEqual(file_result[0]["functionName"], "sample")
                self.assertFalse(any(root.glob(".*.tmp-*")))
        finally:
            for name, module in originals.items():
                if module is None:
                    sys.modules.pop(name, None)
                else:
                    sys.modules[name] = module

    def test_a_non_ascii_path_survives_a_non_utf8_stdin(self):
        # S14 (EVO-9): on Windows Python decodes a piped stdin with the ANSI
        # code page; `C:\\Users\\Adrián\\...` arrived as mojibake and every job
        # failed with worker-input-missing. cp1252 emulates that here, and the
        # command is sent unescaped, as raw UTF-8, the worst case.
        runner = "import runpy, sys\nrunpy.run_path(sys.argv[1], run_name='__main__')\n"
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary) / "Adrián" / "código"
            folder.mkdir(parents=True)
            source = folder / "sample.py"
            source.write_text("def sample():\n    return 1\n", encoding="utf-8")
            output = folder / "out.json"
            command = json.dumps({
                "type": "analyze", "id": "job-á", "inputPath": str(source),
                "outputPath": str(output), "targetType": "directory",
            }, ensure_ascii=False)
            env = {**os.environ, "PYTHONIOENCODING": "cp1252", "PYTHONUTF8": "0"}
            completed = subprocess.run(
                [sys.executable, "-c", runner, str(WORKER_PATH)],
                input=(command + "\n" + json.dumps({"type": "shutdown"}) + "\n").encode("utf-8"),
                capture_output=True, env=env, timeout=60,
            )
            messages = [json.loads(line) for line in completed.stdout.decode("ascii").splitlines() if line.strip()]
            self.assertEqual(["ready", "complete", "stopped"], [message["type"] for message in messages],
                             completed.stderr.decode("utf-8", "replace"))
            self.assertEqual("job-á", messages[1]["id"])
            self.assertTrue(output.is_file())


if __name__ == "__main__":
    unittest.main()
