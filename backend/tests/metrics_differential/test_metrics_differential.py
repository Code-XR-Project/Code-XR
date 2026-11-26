"""Differential test: Code-XR's metrics analyzer against frozen Lizard output.

See ``differential.py`` for the contract and ``docs/lizard-replacement/SPEC.md``
for the divergence IDs. Two comparisons run:

* ``code_metrics_analyzer`` (Code-XR's own analyzer, or the module named by
  ``CODEXR_METRICS_CANDIDATE``) must equal the golden except for the entries
  in ``divergences.json``;
* ``lizard_analyzer`` must equal the golden with NO divergence allowed, which
  proves the golden still describes the pinned Lizard. It is skipped when that
  Lizard is not installed, i.e. everywhere once #145 drops the dependency.
"""

from __future__ import annotations

import importlib
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND_ROOT = HERE.parents[1]
for extra in (BACKEND_ROOT / 'src' / 'tools', BACKEND_ROOT / 'src' / 'utils', HERE):
    if str(extra) not in sys.path:
        sys.path.insert(0, str(extra))

import differential  # noqa: E402
from metric_language_contract import get_supported_metric_extensions  # noqa: E402

LIZARD_CANDIDATE = 'lizard_analyzer'
OWN_CANDIDATE = 'code_metrics_analyzer'


def _candidate_name() -> str:
    return os.environ.get('CODEXR_METRICS_CANDIDATE', '').strip() or OWN_CANDIDATE


def _real_lizard_version() -> str | None:
    try:
        from lizard_ext.version import version
    except ImportError:
        return None
    return version


class CompareContractTest(unittest.TestCase):
    """The comparison itself: these run everywhere, no analyzer needed."""

    golden = {'a.c': {'status': 'success', 'functions': {
        'f@1': {'name': 'f', 'lineStart': 1, 'longName': 'f( int a)', 'lineEnd': 3, 'lineCount': 3,
                'complexity': 2, 'parameters': 1, 'maxNestingDepth': 2}}}}

    def _candidate(self, **changes):
        record = dict(self.golden['a.c']['functions']['f@1'], **changes)
        return {'a.c': {'status': 'success', 'functions': {'f@1': record}}}

    def test_identical_results_pass(self):
        self.assertEqual(differential.compare(self.golden, self._candidate(), []), ([], []))

    def test_unlisted_mismatch_is_reported(self):
        unlisted, _ = differential.compare(self.golden, self._candidate(maxNestingDepth=1), [])
        self.assertEqual([(m['field'], m['lizard'], m['ours']) for m in unlisted], [('maxNestingDepth', 2, 1)])

    def test_listed_mismatch_passes_only_with_the_same_values(self):
        entry = {'file': 'a.c', 'function': 'f@1', 'field': 'maxNestingDepth', 'lizard': 2, 'ours': 1,
                 'reason': 'x', 'spec': 'ND'}
        self.assertEqual(differential.compare(self.golden, self._candidate(maxNestingDepth=1), [entry]), ([], []))
        unlisted, stale = differential.compare(self.golden, self._candidate(maxNestingDepth=3), [entry])
        self.assertEqual(len(unlisted), 1)
        self.assertEqual(stale, [entry])

    def test_divergence_that_no_longer_happens_is_stale(self):
        entry = {'file': 'a.c', 'function': 'f@1', 'field': 'complexity', 'lizard': 2, 'ours': 1,
                 'reason': 'x', 'spec': 'C1'}
        self.assertEqual(differential.compare(self.golden, self._candidate(), [entry]), ([], [entry]))

    def test_missing_and_extra_functions_are_presence_mismatches(self):
        candidate = {'a.c': {'status': 'success', 'functions': {'g@5': {'name': 'g', 'lineStart': 5}}}}
        unlisted, _ = differential.compare(self.golden, candidate, [])
        self.assertEqual(sorted((m['function'], m['lizard'], m['ours']) for m in unlisted),
                         [('f@1', True, False), ('g@5', False, True)])

    def test_function_renamed_or_moved_is_paired_field_by_field(self):
        renamed = {'a.c': {'status': 'success', 'functions': {
            'A::f@1': dict(self.golden['a.c']['functions']['f@1'], name='A::f')}}}
        unlisted, _ = differential.compare(self.golden, renamed, [])
        self.assertEqual([(m['function'], m['field'], m['ours']) for m in unlisted], [('f@1', 'name', 'A::f')])
        moved = {'a.c': {'status': 'success', 'functions': {
            'f@2': dict(self.golden['a.c']['functions']['f@1'], lineStart=2)}}}
        unlisted, _ = differential.compare(self.golden, moved, [])
        self.assertEqual([(m['function'], m['field'], m['ours']) for m in unlisted], [('f@1', 'lineStart', 2)])

    def test_long_name_ignores_whitespace_only(self):
        self.assertEqual(differential.compare(self.golden, self._candidate(longName='f(int a)'), []), ([], []))
        unlisted, _ = differential.compare(self.golden, self._candidate(longName='f(int b)'), [])
        self.assertEqual([m['field'] for m in unlisted], ['longName'])

    def test_wildcard_covers_one_field_of_every_function(self):
        entry = {'file': '*.c', 'function': '*', 'field': 'longName', 'reason': 'names', 'spec': 'NAME-SIG'}
        self.assertEqual(differential.compare(self.golden, self._candidate(longName='f'), [entry]), ([], []))
        unlisted, _ = differential.compare(self.golden, self._candidate(longName='f', complexity=9), [entry])
        self.assertEqual([m['field'] for m in unlisted], ['complexity'])


class GoldenCoverageTest(unittest.TestCase):

    def test_golden_covers_exactly_the_corpus(self):
        golden = differential.load_json(differential.GOLDEN_PATH)
        corpus = differential.corpus_files(get_supported_metric_extensions())
        self.assertEqual(sorted(golden['files']), corpus,
                         'corpus changed: run regenerate_lizard_golden.py with the pinned lizard')

    def test_every_contract_extension_has_a_corpus_file(self):
        covered = {Path(path).suffix.lower() for path in differential.corpus_files(get_supported_metric_extensions())}
        missing = set(get_supported_metric_extensions()) - covered
        self.assertEqual(missing, set(), 'every contract extension needs at least one corpus file')

    def test_divergences_are_justified(self):
        for entry in differential.load_json(differential.DIVERGENCES_PATH):
            for key in ('file', 'function', 'field', 'reason', 'spec'):
                self.assertTrue(entry.get(key), f'divergence without {key}: {entry}')


class DifferentialTest(unittest.TestCase):

    def _run(self, name: str, divergences: list) -> None:
        golden = differential.load_json(differential.GOLDEN_PATH)
        analyzer = importlib.import_module(name)
        candidate = {
            relative: differential.normalize(analyzer.analyze_file(str(BACKEND_ROOT / relative)))
            for relative in golden['files']
        }
        unlisted, stale = differential.compare(golden['files'], candidate, divergences)

        def describe(items):
            return '\n'.join(f"  {i['file']} {i['function']} {i['field']}: "
                             f"lizard={i.get('lizard')!r} ours={i.get('ours')!r}" for i in items)

        self.assertEqual(unlisted, [], f'{name}: mismatches not in divergences.json:\n{describe(unlisted)}')
        self.assertEqual(stale, [], f'{name}: divergences that no longer happen:\n{describe(stale)}')

    def test_own_analyzer_matches_lizard_except_listed_divergences(self):
        name = _candidate_name()
        divergences = [] if name == LIZARD_CANDIDATE else differential.load_json(differential.DIVERGENCES_PATH)
        if name == LIZARD_CANDIDATE:
            self._skip_without_pinned_lizard()
        self._run(name, divergences)

    def test_golden_still_describes_the_pinned_lizard(self):
        self._skip_without_pinned_lizard()
        self._run(LIZARD_CANDIDATE, [])

    def _skip_without_pinned_lizard(self) -> None:
        version = differential.load_json(differential.GOLDEN_PATH)['lizardVersion']
        if _real_lizard_version() != version:
            self.skipTest(f'lizard {version} not installed')
