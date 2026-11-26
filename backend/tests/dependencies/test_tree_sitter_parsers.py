"""The dependency graph never downloads a parser during an analysis (decision 2026-11-26).

tree-sitter-language-pack 1.x fetches a language's parser from GitHub the first
time it is asked for it. Code-XR downloads them only in the consented
environment set-up, into ``<venv>/codexr-tree-sitter``, and the engine uses a
parser only when it is already there. These tests run against a fake pack, so
nothing here touches the network either.
"""
import importlib
import os
import sys
import types
import unittest
from pathlib import Path
from typing import Literal

ROOT = Path(__file__).resolve().parents[3]
UTILS = ROOT / "backend" / "src" / "utils"
if str(UTILS) not in sys.path:
    sys.path.insert(0, str(UTILS))

import tree_sitter_parsers  # noqa: E402


class FakePack(types.ModuleType):
    """Records configure/download calls; process() fails the test if reached without a cached parser."""

    SupportedLanguage = Literal["python", "cpp", "csharp", "javascript", "java", "rust"]

    def __init__(self, cached=()):
        super().__init__("tree_sitter_language_pack")
        self.cached = set(cached)
        self.configured = []
        self.downloads = []
        self.processed = []

    class PackConfig:
        def __init__(self, cache_dir=None):
            self.cache_dir = cache_dir

    class ProcessConfig:
        def __init__(self, language, **_):
            self.language = language

    def configure(self, config):
        self.configured.append(config.cache_dir)

    def download(self, names):
        self.downloads.append(list(names))
        self.cached.update(n for n in names if n != "rust")  # one fails, like a missing release asset
        return len(names)

    def downloaded_languages(self):
        return sorted(self.cached)

    def process(self, _text, config):
        if config.language not in self.cached:
            raise AssertionError(f"process() reached for {config.language} without a cached parser: it would download")
        self.processed.append(config.language)
        return types.SimpleNamespace(imports=[types.SimpleNamespace(source="os")])


class TreeSitterParsersTest(unittest.TestCase):
    def setUp(self):
        self._saved = sys.modules.get("tree_sitter_language_pack")
        tree_sitter_parsers.cached_grammars.cache_clear()
        tree_sitter_parsers._configured_for = None

    def tearDown(self):
        if self._saved is None:
            sys.modules.pop("tree_sitter_language_pack", None)
        else:
            sys.modules["tree_sitter_language_pack"] = self._saved
        tree_sitter_parsers.cached_grammars.cache_clear()
        tree_sitter_parsers._configured_for = None

    def install(self, pack):
        sys.modules["tree_sitter_language_pack"] = pack
        return pack

    def test_grammar_names_follow_the_metric_language_names(self):
        self.assertEqual(tree_sitter_parsers.grammar_for("C++"), "cpp")
        self.assertEqual(tree_sitter_parsers.grammar_for("C#"), "csharp")
        self.assertEqual(tree_sitter_parsers.grammar_for("Python"), "python")
        self.assertEqual(tree_sitter_parsers.grammar_for("Objective-C"), "objc")

    def test_the_cache_lives_inside_the_venv(self):
        self.assertEqual(tree_sitter_parsers.parser_cache_dir(), os.path.join(sys.prefix, "codexr-tree-sitter"))
        self.assertEqual(tree_sitter_parsers.parser_cache_dir("/v"), os.path.join("/v", "codexr-tree-sitter"))

    def test_required_grammars_are_the_supported_ones_for_the_metric_languages(self):
        self.install(FakePack())
        self.assertEqual(tree_sitter_parsers.required_grammars(["Python", "C++", "C#", "Fortran"]), ["cpp", "csharp", "python"])

    def test_without_the_pack_nothing_is_available(self):
        sys.modules["tree_sitter_language_pack"] = None  # import fails
        self.assertEqual(tree_sitter_parsers.supported_grammars(), set())
        self.assertFalse(tree_sitter_parsers.is_available("python"))

    def test_availability_reads_the_venv_cache_and_never_downloads(self):
        pack = self.install(FakePack(cached={"python"}))
        self.assertTrue(tree_sitter_parsers.is_available("python"))
        self.assertFalse(tree_sitter_parsers.is_available("java"))
        self.assertEqual(pack.downloads, [])
        self.assertEqual(pack.configured, [tree_sitter_parsers.parser_cache_dir()])

    def test_download_reports_what_arrived_and_what_is_missing(self):
        pack = self.install(FakePack())
        result = tree_sitter_parsers.download_grammars(["python", "rust"])
        self.assertEqual(pack.downloads, [["python", "rust"]])
        self.assertEqual(result["downloaded"], ["python"])
        self.assertEqual(result["missing"], ["rust"])
        self.assertEqual(result["cacheDir"], tree_sitter_parsers.parser_cache_dir())
        self.assertTrue(tree_sitter_parsers.is_available("python"), "the per-process cache is refreshed after a download")


class EngineUsesOnlyCachedParsersTest(unittest.TestCase):
    def setUp(self):
        self._saved = sys.modules.get("tree_sitter_language_pack")
        tree_sitter_parsers.cached_grammars.cache_clear()
        tree_sitter_parsers._configured_for = None
        self.engine = importlib.import_module("dependency_analysis_engine")

    def tearDown(self):
        if self._saved is None:
            sys.modules.pop("tree_sitter_language_pack", None)
        else:
            sys.modules["tree_sitter_language_pack"] = self._saved
        tree_sitter_parsers.cached_grammars.cache_clear()
        tree_sitter_parsers._configured_for = None

    def test_a_language_without_a_cached_parser_falls_back_without_asking_the_pack(self):
        pack = FakePack(cached=set())
        sys.modules["tree_sitter_language_pack"] = pack
        structured, targets = self.engine._extract_structured_targets("Python", "import os\n")
        self.assertFalse(structured)
        self.assertEqual(targets, [])
        self.assertEqual(pack.processed, [])
        self.assertEqual(pack.downloads, [])

    def test_a_cached_parser_is_used(self):
        pack = FakePack(cached={"python"})
        sys.modules["tree_sitter_language_pack"] = pack
        structured, _targets = self.engine._extract_structured_targets("Python", "import os\n")
        self.assertTrue(structured)
        self.assertEqual(pack.processed, ["python"])
        self.assertEqual(pack.downloads, [])


if __name__ == "__main__":
    unittest.main()
