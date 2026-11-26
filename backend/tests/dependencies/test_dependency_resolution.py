"""S13 (#85): the dependency engine reports correct, stable relations.

DEPGRAPH-2: unresolved calls are not external packages.
DEPGRAPH-3: relative imports resolve next to the importer, `import type` and
Python relative imports resolve, and the result does not depend on the hash seed.
DEPGRAPH-10: files whose names differ only in case get different node ids.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
UTILS = ROOT / "backend" / "src" / "utils"
if str(UTILS) not in sys.path:
    sys.path.insert(0, str(UTILS))

from dependency_analysis_engine import analyze_dependencies, analyze_file_dependencies  # noqa: E402


def write_project(root: Path, files: dict[str, str]) -> None:
    for relative, content in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def edges_by_path(result: dict) -> set[tuple[str, str, str]]:
    names = {node["id"]: node.get("relativePath") or f"EXT:{node['label']}" for node in result["nodes"]}
    return {(names[edge["source"]], names[edge["target"]], edge["kind"]) for edge in result["edges"]}


STEM_PROJECT = {
    "a/util.ts": "export const x = 1;\n",
    "b/util.ts": "export const y = 2;\n",
    "c/util.ts": "export const z = 3;\n",
    "c/main.ts": "import { z } from './util';\n",
    "c/up.ts": "import { y } from '../b/util';\n",
    "c/typed.ts": "import type { T } from './types';\nimport React from 'react';\n",
    "c/types.ts": "export type T = number;\n",
}


class DependencyResolutionTests(unittest.TestCase):
    def analyze(self, files: dict[str, str]) -> dict:
        with tempfile.TemporaryDirectory() as temporary:
            write_project(Path(temporary), files)
            return analyze_dependencies(temporary, recursive=True)

    def test_a_relative_import_resolves_to_the_sibling_file(self):
        edges = edges_by_path(self.analyze(STEM_PROJECT))
        self.assertIn(("c/main.ts", "c/util.ts", "import"), edges)
        self.assertNotIn(("c/main.ts", "a/util.ts", "import"), edges)
        self.assertIn(("c/up.ts", "b/util.ts", "import"), edges)

    def test_import_type_and_a_default_import_are_not_packages(self):
        result = self.analyze(STEM_PROJECT)
        labels = {node["label"] for node in result["nodes"] if node["external"]}
        self.assertNotIn("type", labels)
        self.assertNotIn("React", labels)
        self.assertIn("react", labels)
        self.assertIn(("c/typed.ts", "c/types.ts", "import"), edges_by_path(result))

    def test_python_relative_imports_resolve_inside_the_package(self):
        edges = edges_by_path(self.analyze({
            "pkg/__init__.py": "",
            "pkg/models.py": "class Model:\n    pass\n",
            "pkg/views.py": "from .models import Model\n",
            "pkg/sub/deep.py": "from ..models import Model\n",
            "other/models.py": "class Model:\n    pass\n",
        }))
        self.assertIn(("pkg/views.py", "pkg/models.py", "import"), edges)
        self.assertIn(("pkg/sub/deep.py", "pkg/models.py", "import"), edges)
        self.assertFalse(any(target.startswith("EXT:.") for _source, target, _kind in edges))

    def test_unresolved_calls_and_definitions_are_not_external_packages(self):
        result = self.analyze({
            "service.ts": (
                "export class Service {\n"
                "  constructor(private value: number) { super(); }\n"
                "  async run() { this.helper(); String(this.value); await fetchData(); }\n"
                "}\n"
            ),
            "views.py": "def f():\n    return len([])\n\nf()\n",
        })
        labels = {node["label"] for node in result["nodes"] if node["external"]}
        for junk in ("this", "constructor", "super", "async", "String", "fetchData", "f", "len"):
            self.assertNotIn(junk, labels)
        self.assertFalse(any(edge["kind"] == "call" and edge["target"].startswith("external:")
                             for edge in result["edges"]))

    def test_with_in_prose_or_python_is_not_a_mixin(self):
        result = self.analyze({
            "notes.ts": "// Works with a cache and with Deep links\nexport const a = 1;\n",
            "io.py": "with open('x') as handle:\n    pass\n",
            "Bird.scala": "class Bird extends Animal with Flyer {}\n",
        })
        labels = {node["label"] for node in result["nodes"] if node["external"]}
        self.assertFalse({"a", "Deep", "open"} & labels, labels)
        self.assertIn("Flyer", labels)

    def test_a_call_to_a_project_file_is_still_an_edge(self):
        edges = edges_by_path(self.analyze({
            "helpers.py": "def go():\n    return 1\n",
            "main.py": "import helpers\nhelpers.go()\n",
        }))
        self.assertIn(("main.py", "helpers.py", "call"), edges)

    def test_file_names_that_differ_only_in_case_get_different_ids(self):
        result = self.analyze({"Util.ts": "export const a = 1;\n", "util.ts": "export const b = 2;\n"})
        files = [node for node in result["nodes"] if node["kind"] == "file"]
        if len(files) < 2:
            self.skipTest("case-insensitive file system")
        self.assertEqual(len(files), len({node["id"] for node in files}))

    def test_file_scope_resolves_a_relative_import_next_to_the_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            write_project(Path(temporary), STEM_PROJECT)
            result = analyze_file_dependencies(str(Path(temporary) / "c" / "main.ts"), temporary)
        local = {node.get("relativePath") for node in result["nodes"] if node.get("kind") == "file"}
        self.assertEqual({"c/util.ts"}, local)

    def test_the_result_does_not_depend_on_the_hash_seed(self):
        script = (
            "import json, sys\n"
            f"sys.path.insert(0, {str(UTILS)!r})\n"
            "from dependency_analysis_engine import analyze_dependencies\n"
            "result = analyze_dependencies(sys.argv[1], recursive=True)\n"
            "print(json.dumps(sorted((e['source'], e['target'], e['kind'], e['confidence']) for e in result['edges'])))\n"
        )
        with tempfile.TemporaryDirectory() as temporary:
            write_project(Path(temporary), {**STEM_PROJECT, "c/alias.ts": "import { y } from 'b/util';\n"})
            outputs = set()
            for seed in ("0", "3", "5"):
                completed = subprocess.run(
                    [sys.executable, "-c", script, temporary],
                    env={**os.environ, "PYTHONHASHSEED": seed},
                    capture_output=True, text=True, check=True,
                )
                outputs.add(completed.stdout)
        self.assertEqual(1, len(outputs))
        self.assertTrue(json.loads(outputs.pop()))


if __name__ == "__main__":
    unittest.main()
