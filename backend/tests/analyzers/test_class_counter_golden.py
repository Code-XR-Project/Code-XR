"""Extension-driven golden of ``analyze_classes`` (1.2.1, roadmap W5-44).

Characterization for the table-driven rewrite of the 21-arm dispatch (W5-45,
audit python-backend/DUP-01). The audit's skeptic asked for a golden driven by
EXTENSIONS, not by a corpus of real projects: every alias of every arm, an
extension no arm lists, an upper-case spelling, a missing path and a file that
is not UTF-8.

Every extension reads the SAME text, ``fixtures/class_counter_corpus.txt``:
the per-language manual_test fixtures plus one generated line per dispatch
pattern (so a pattern mis-copied into a table changes some arm's answer). The
golden stores the full result dict, ``classCount`` and the ``classes`` list
with exact names, types, line numbers and order; only ``file`` (a temporary
absolute path) is reduced to its basename.

Pinned as they are, quirks included (``.h`` routed to the C++ arm, Vue line
numbers relative to the <script> block, overlapping patterns that count one
declaration twice): this is a characterization, not an endorsement.

Regenerate ONLY in a commit that changes behaviour on purpose:
    python backend/tests/analyzers/test_class_counter_golden.py --write
"""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
PYTHON_ROOT = PROJECT_ROOT / 'backend' / 'src'
HERE = Path(__file__).resolve().parent
CORPUS = HERE / 'fixtures' / 'class_counter_corpus.txt'
GOLDEN = HERE / 'golden' / 'analyze_classes.json'

# The dispatch arms of analyze_classes as of 1.2.1, alias by alias, in source order.
ARMS = [
    ['.py'],
    ['.js', '.ts', '.jsx', '.tsx'],
    ['.java'],
    ['.scala', '.sc'],
    ['.cpp', '.cc', '.cxx', '.h', '.hpp'],
    ['.cs'],
    ['.rb'],
    ['.php', '.phtml', '.php3', '.php4', '.php5', '.phps'],
    ['.swift'],
    ['.go'],
    ['.rs'],
    ['.kt', '.kts'],
    ['.m', '.mm'],
    ['.lua'],
    ['.erl', '.hrl'],
    ['.pl', '.pm', '.pod', '.t'],
    ['.vue'],
    ['.c'],
    ['.sol'],
    ['.f', '.f90', '.f95', '.f03', '.f08'],
    ['.gd'],
    ['.dart'],
    ['.ps1', '.psm1'],
    ['.r'],
]
# Arms that exist but can find nothing: shell has no class-like declaration.
EMPTY_ARMS = [['.sh', '.bash']]
# No arm lists these: the else branch (warning, zero classes). '.pyw' and '.mjs'
# are metric-contract extensions the class counter is silent for (V1.2.1_STATUS
# "Found while building the net", item 9).
UNLISTED = ['.xyz', '.pyw', '.mjs']
# The extension is lower-cased before dispatch.
UPPER_CASE = ['.PY', '.Vue']


def _load_class_counter():
    # Loaded by path and never registered in sys.modules (see
    # test_analyzer_extension_coverage.py for why).
    spec = importlib.util.spec_from_file_location(
        '_class_counter_golden', PYTHON_ROOT / 'tools' / 'class_counter_analyzer.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_answers():
    analyzer = _load_class_counter()
    corpus = CORPUS.read_text(encoding='utf-8')
    answers = {}
    with tempfile.TemporaryDirectory() as scratch:
        for extension in [ext for arm in ARMS + EMPTY_ARMS for ext in arm] + UNLISTED + UPPER_CASE:
            target = Path(scratch) / f'sample{extension}'
            target.write_text(corpus, encoding='utf-8', newline='\n')
            result = analyzer.analyze_classes(str(target))
            if 'file' in result:
                result['file'] = Path(result['file']).name
            answers[extension] = result
    return answers


class ClassCounterGoldenTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.analyzer = _load_class_counter()
        cls.answers = build_answers()
        cls.golden = json.loads(GOLDEN.read_text(encoding='utf-8'))

    def test_every_alias_of_every_arm_matches_the_golden(self):
        for arm in ARMS:
            for extension in arm:
                with self.subTest(extension=extension):
                    self.assertEqual(self.golden[extension], self.answers[extension])

    def test_aliases_of_one_arm_answer_alike(self):
        for arm in ARMS:
            first = dict(self.answers[arm[0]], file=None)
            for extension in arm[1:]:
                with self.subTest(extension=extension):
                    self.assertEqual(first, dict(self.answers[extension], file=None))

    def test_unlisted_and_upper_case_extensions_match_the_golden(self):
        for extension in UNLISTED + UPPER_CASE:
            with self.subTest(extension=extension):
                self.assertEqual(self.golden[extension], self.answers[extension])

    def test_the_golden_holds_exactly_the_extensions_built(self):
        self.assertEqual(sorted(self.golden), sorted(self.answers))

    def test_every_arm_finds_something_in_the_corpus(self):
        # A vacuity guard: an arm answering zero here would pin nothing.
        for arm in ARMS:
            with self.subTest(arm=arm[0]):
                self.assertGreater(self.answers[arm[0]]['classCount'], 0)

    def test_empty_arms_answer_zero_without_a_warning(self):
        for arm in EMPTY_ARMS:
            for extension in arm:
                with self.subTest(extension=extension):
                    self.assertEqual(self.answers[extension]['classCount'], 0)
                    self.assertNotIn('warning', self.answers[extension])
                    self.assertEqual(self.golden[extension], self.answers[extension])

    def test_unreadable_paths_return_only_an_error(self):
        with tempfile.TemporaryDirectory() as scratch:
            missing = Path(scratch) / 'missing.py'
            not_utf8 = Path(scratch) / 'latin1.py'
            not_utf8.write_bytes(b'class Caf\xe9:\n    pass\n')
            for target in (missing, not_utf8):
                with self.subTest(target=target.name):
                    result = self.analyzer.analyze_classes(str(target))
                    self.assertEqual(['error'], list(result))
                    self.assertTrue(result['error'].startswith('Error reading file: '))


if __name__ == '__main__':
    if '--write' in sys.argv:
        GOLDEN.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN.write_text(json.dumps(build_answers(), indent=1) + '\n', encoding='utf-8', newline='\n')
        print(f'wrote {GOLDEN.relative_to(PROJECT_ROOT)}')
    else:
        unittest.main()
