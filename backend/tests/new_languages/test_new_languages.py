"""Rust, Dart, Shell, PowerShell and R work like every other language (epic #219: #224-#227).

Two promises are checked for each language, on its ``manual_test`` fixture:

1. **Every analyzer field is filled.** The XR and the LivePanel payloads are
   identical, carry every field of the XR schema, and every numeric field holds
   a real number. Over the file, each function-level metric is non-zero
   somewhere (a column of zeros would mean the language silently skipped it),
   and the file-level counters (comments, classes where the language has them)
   are measured, not defaulted.
2. **The values are the right ones.** Every function's line span, NLOC, CCN,
   parameters, nesting depth and cognitive complexity is pinned to a value
   counted by hand from the fixture (the comments next to each row say what
   was counted). No Lizard golden can serve as oracle for these languages: the
   differential corpus leaves them out (``POST_LIZARD_EXTENSIONS``).

Plus focused cases for the constructs each language needed its own rule for.
"""

import contextlib
import io
import math
import sys
import unittest
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[2]
for extra in ('src', 'src/utils', 'src/tools', 'src/XR', 'src/livePanels'):
    path = str(BACKEND_ROOT / extra)
    if path not in sys.path:
        sys.path.insert(0, path)

from code_metrics import LANGUAGES, analyze_source, language_for_extension  # noqa: E402
from code_metrics_analyzer import analyze_file  # noqa: E402
from livePanel_file_analysis_coordinator import analyze_file_comprehensive  # noqa: E402
from metric_language_contract import get_metric_language  # noqa: E402
from xr_field_schema import get_xr_schema  # noqa: E402
from xr_file_analysis_coordinator import analyze_file_for_xr  # noqa: E402

MANUAL_TEST = BACKEND_ROOT / 'manual_test'

# fixture -> (language, has classes, {name: (lineStart, lineEnd, NLOC, CCN, parameters, nesting, cognitive)})
EXPECTED = {
    'rust_metrics.rs': ('Rust', True, {
        'Point::new': (7, 9, 3, 1, 2, 0, 0),
        # if (+1) && (+1) else-if (+1); `&self` is a receiver, not a parameter
        'Point::classify': (11, 19, 9, 4, 1, 1, 4),
        'Point::fmt': (23, 25, 3, 1, 1, 0, 0),
        # for, 2 match arms + guard, inner match 1 arm (`_` is the default), if + ||, if;
        # the closure `|| total > 10` is not a boolean operator
        'sum_even': (28, 47, 20, 9, 2, 2, 16),
    }),
    'dart_metrics.dart': ('Dart', True, {
        'Counter::Counter.named': (10, 12, 3, 1, 2, 0, 0),
        'Counter::get value': (14, 14, 1, 1, 0, 0, 0),
        'Counter::set value': (16, 19, 4, 2, 1, 1, 1),
        # two ternaries; the third sits inside a string interpolation
        'Counter::describe': (21, 24, 4, 3, 1, 0, 2),
        # for, if, &&, ??, switch-expression arms `0 =>` and `1 || 2 =>` (+ its ||), catch
        'Counter::load': (26, 42, 17, 9, 1, 3, 7),
        'twice': (45, 45, 1, 1, 1, 0, 0),
        'main': (47, 52, 6, 1, 0, 0, 0),
    }),
    'shell_metrics.sh': ('Shell', False, {
        # if, elif, && inside [[ ]]; parameters = highest positional read ($2)
        'greet': (3, 12, 10, 4, 2, 1, 4),
        # for, case arms *.txt and *.md|*.rst (not *), while, ||; reads up to $3
        'process': (14, 29, 14, 6, 3, 2, 6),
    }),
    'powershell_metrics.ps1': ('PowerShell', True, {
        # if, -and, elseif, -or, foreach; parameters from the param() block
        'Get-Greeting': (5, 20, 16, 6, 2, 2, 7),
        # 2 switch arms (default is not one), do-while tail, catch, ??
        'Test-Items': (22, 41, 20, 6, 2, 1, 3),
        'Account::Account': (47, 49, 3, 1, 1, 0, 0),
        'Account::Withdraw': (51, 55, 5, 2, 1, 1, 1),
    }),
    'r_metrics.r': ('R', True, {
        # if, ||, else-if, &&, for, while (braceless)
        'normalize': (4, 14, 11, 7, 3, 2, 7),
        'square': (16, 16, 1, 1, 1, 0, 0),
        # switch: "a" and "c" are alternatives, "b" = falls through, the last is the default; if
        'classify': (18, 31, 14, 4, 1, 2, 4),
        '(anonymous)': (24, 24, 1, 1, 1, 0, 0),
        '%+%': (33, 33, 1, 1, 2, 0, 0),
        'push': (38, 41, 4, 1, 1, 0, 0),
    }),
}
FUNCTION_METRICS = ('lineCount', 'complexity', 'parameters', 'maxNestingDepth', 'cognitiveComplexity',
                    'halsteadVolume', 'halsteadDifficulty', 'halsteadEffort', 'halsteadBugs',
                    'maintainabilityIndex', 'cyclomaticDensity')


def _quiet(call, *args):
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        return call(*args)


class EveryFieldIsFilledTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.file_fields = get_xr_schema('file')['fields']

    def test_each_new_language_has_a_fixture_recognised_by_the_contract(self):
        for fixture, (language, _, _) in EXPECTED.items():
            with self.subTest(fixture=fixture):
                self.assertTrue((MANUAL_TEST / fixture).is_file())
                self.assertEqual(get_metric_language(fixture), language)
                self.assertEqual(language_for_extension(Path(fixture).suffix).name, language)

    def test_xr_and_livepanel_rows_carry_every_schema_field_with_real_values(self):
        for fixture, (language, has_classes, expected) in EXPECTED.items():
            with self.subTest(fixture=fixture):
                path = str(MANUAL_TEST / fixture)
                xr_rows = _quiet(analyze_file_for_xr, path)
                self.assertEqual(xr_rows, _quiet(analyze_file_comprehensive, path))
                self.assertEqual(len(xr_rows), len(analyze_file(path)['functions']))
                for row in xr_rows:
                    self.assertEqual(row['language'], language)
                    self.assertEqual(row['status'], 'success')
                    for field in self.file_fields:
                        value = row.get(field['id'])
                        self.assertIsNotNone(value, f"{row['functionName']}: {field['id']} is missing")
                        if field['valueType'] == 'numeric':
                            self.assertIsInstance(value, (int, float), field['id'])
                            self.assertTrue(math.isfinite(value), field['id'])
                for metric in FUNCTION_METRICS:
                    self.assertTrue(any(row[metric] > 0 for row in xr_rows), f'{metric} is zero for every function')
                first = xr_rows[0]
                self.assertGreater(first['commentLines'], 0)
                self.assertGreater(first['codeLines'], 0)
                self.assertGreater(first['blankLines'], 0)
                self.assertEqual(first['functionCount'], len(xr_rows))
                self.assertGreater(first['maxCognitiveComplexity'], 0)
                self.assertGreater(first['totalHalsteadVolume'], 0)
                self.assertGreater(first['minMaintainabilityIndex'], 0)
                if has_classes:
                    self.assertGreater(first['classCount'], 0)
                else:
                    self.assertEqual(first['classCount'], 0)     # shell has nothing class-like

    def test_every_function_matches_its_hand_count(self):
        for fixture, (_, _, expected) in EXPECTED.items():
            result = analyze_file(str(MANUAL_TEST / fixture))
            self.assertEqual(result['status'], 'success')
            actual = {}
            for record in result['functions']:
                actual.setdefault(record['name'], (
                    record['lineStart'], record['lineEnd'], record['lineCount'], record['complexity'],
                    record['parameters'], record['maxNestingDepth'], record['cognitiveComplexity']))
            with self.subTest(fixture=fixture):
                self.assertEqual(actual, expected)
                for record in result['functions']:
                    self.assertGreater(record['halsteadVolume'], 0)
                    self.assertGreater(record['maintainabilityIndex'], 0)
                    self.assertLessEqual(record['maintainabilityIndex'], 100)


def functions(language, source):
    return {func.name: func.to_record() for func in analyze_source(source, LANGUAGES[language])[0]}


class RustRulesTests(unittest.TestCase):
    def test_impl_blocks_name_the_type_after_for_and_skip_generics(self):
        source = 'impl<T: Clone> fmt::Debug for Stack<T> {\n    fn fmt(&self) -> u8 { 1 }\n}\n'
        self.assertEqual(list(functions('Rust', source)), ['Stack::fmt'])

    def test_closure_bars_and_double_references_are_not_boolean_operators(self):
        source = 'fn f(v: &[u8]) -> bool {\n    let g = || true;\n    v.iter().any(|&&x| x > 1) && g()\n}\n'
        record = functions('Rust', source)['f']
        self.assertEqual(record['cyclomatic_complexity'], 2)        # only the final &&
        self.assertEqual(record['cognitive_complexity'], 1)

    def test_lifetimes_raw_strings_and_nested_comments_do_not_break_the_lexer(self):
        source = ('fn f<\'a>(s: &\'a str) -> &\'a str {\n    /* outer /* inner */ still */\n'
                  '    let r = r#"if { "#;\n    if s.is_empty() { r } else { s }\n}\n')
        record = functions('Rust', source)['f']
        self.assertEqual((record['cyclomatic_complexity'], record['parameter_count'], record['nloc']), (2, 1, 4))

    def test_loop_has_no_condition_and_a_match_guard_is_not_nesting(self):
        source = 'fn f(x: Option<u8>) {\n    loop {\n        match x {\n            Some(v) if v > 1 => {}\n' \
                 '            _ => break,\n        }\n    }\n}\n'
        record = functions('Rust', source)['f']
        self.assertEqual((record['cyclomatic_complexity'], record['max_nesting_depth']), (3, 2))


class ShellRulesTests(unittest.TestCase):
    def test_keywords_count_only_at_the_start_of_a_command(self):
        source = 'f() {\n  echo if for while done\n  if true; then echo fi; fi\n}\n'
        self.assertEqual(functions('Shell', source)['f']['cyclomatic_complexity'], 2)

    def test_parameter_expansions_and_here_documents_are_not_code(self):
        source = 'f() {\n  n=${#1}\n  cat <<EOF\nif [ x ]; then\nEOF\n  echo "${2:-x}" # $9\n}\n'
        record = functions('Shell', source)['f']
        self.assertEqual((record['cyclomatic_complexity'], record['parameter_count'], record['end_line']), (1, 2, 7))

    def test_function_keyword_forms(self):
        source = 'function a {\n  :\n}\nfunction b() {\n  :\n}\nc() (\n  :\n)\n'
        self.assertEqual(sorted(functions('Shell', source)), ['a', 'b', 'c'])


class PowerShellRulesTests(unittest.TestCase):
    def test_keywords_are_case_insensitive_and_names_keep_their_case(self):
        source = 'Function Get-Thing {\n    Param($A, $B)\n    IF ($A -AND $B) { 1 } ElseIf ($A) { 2 }\n}\n'
        record = functions('PowerShell', source)['Get-Thing']
        self.assertEqual((record['cyclomatic_complexity'], record['parameter_count']), (4, 2))

    def test_here_strings_and_block_comments_hide_code(self):
        source = 'function f {\n    <# if ($x) { } #>\n    $s = @"\nif ($y) { }\n"@\n}\n'
        self.assertEqual(functions('PowerShell', source)['f']['cyclomatic_complexity'], 1)


class RTests(unittest.TestCase):
    def test_assignment_arrows_name_functions_and_anonymous_ones_are_separate(self):
        source = 'f <- function(x) {\n  lapply(x, function(v) v + 1)\n}\ng <<- \\(y) y\n'
        self.assertEqual(sorted(functions('R', source)), ['(anonymous)', 'f', 'g'])

    def test_vectorised_operators_are_not_decisions(self):
        source = 'f <- function(x) {\n  x[x > 1 & x < 5 | x == 0]\n}\n'
        self.assertEqual(functions('R', source)['f']['cyclomatic_complexity'], 1)


class DartRulesTests(unittest.TestCase):
    def test_nullable_types_are_not_ternaries_and_closures_stay_in_their_function(self):
        source = 'int? f(int? a) {\n  return [1].map((e) => e + (a ?? 0)).first;\n}\n'
        self.assertEqual(list(functions('Dart', source)), ['f'])
        self.assertEqual(functions('Dart', source)['f']['cyclomatic_complexity'], 2)   # the ??


if __name__ == '__main__':
    unittest.main()
