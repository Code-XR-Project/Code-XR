import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
PYTHON_ROOT = PROJECT_ROOT / "backend" / "src"
for extra_path in [PYTHON_ROOT, PYTHON_ROOT / "utils", PYTHON_ROOT / "tools"]:
    if str(extra_path) not in sys.path:
        sys.path.insert(0, str(extra_path))


class _FakeFunction:
    name = "sample"
    start_line = 1
    end_line = 2
    nloc = 2
    cyclomatic_complexity = 1
    parameter_count = 0
    max_nesting_depth = 0


class _FakeAnalysis:
    def __init__(self, file_path):
        self.file_path = file_path
        self.nloc = 2
        self.function_list = [_FakeFunction()]


def _fake_analyze_file(file_path):
    return _FakeAnalysis(file_path)


WORKER_PATH = (
    PYTHON_ROOT / "export" / "git_export_analysis_worker.py"
)


class GitExportAnalysisWorkerTests(unittest.TestCase):
    def test_directory_and_file_results_are_written_atomically(self):
        isolated_names = [
            "lizard",
            "lizard_analyzer",
            "file_analysis_engine",
            "file_metric_summary",
        ]
        originals = {name: sys.modules.get(name) for name in isolated_names}
        fake_lizard_module = types.ModuleType("lizard")
        fake_lizard_module.analyze_file = _fake_analyze_file
        fake_lizard_module.FileAnalyzer = lambda *args, **kwargs: _fake_analyze_file
        fake_lizard_module.get_extensions = lambda *_: []
        try:
            for name in isolated_names:
                sys.modules.pop(name, None)
            sys.modules["lizard"] = fake_lizard_module
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
        runner = (
            "import runpy, sys, types\n"
            "class F:\n"
            "    name='sample'; start_line=1; end_line=2; nloc=2\n"
            "    cyclomatic_complexity=1; parameter_count=0; max_nesting_depth=0\n"
            "class A:\n"
            "    def __init__(self, p): self.file_path=p; self.nloc=2; self.function_list=[F()]\n"
            "lizard = types.ModuleType('lizard')\n"
            "lizard.analyze_file = A\n"
            "lizard.FileAnalyzer = lambda *a, **k: A\n"
            "lizard.get_extensions = lambda *_: []\n"
            "sys.modules['lizard'] = lizard\n"
            "runpy.run_path(sys.argv[1], run_name='__main__')\n"
        )
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
