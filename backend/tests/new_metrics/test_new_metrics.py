"""Cognitive complexity, Halstead and the maintainability index (epic #219: #220, #221, #222).

The cognitive values are SonarSource's own worked examples (G. Ann Campbell,
"Cognitive Complexity", 2017) and their equivalents in each parser family;
the Halstead counts are done by hand on a tiny function.
"""

import math
import sys
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[2] / 'src' / 'tools'
if str(TOOLS) not in sys.path:
    sys.path.insert(0, str(TOOLS))

from code_metrics import LANGUAGES, analyze_source  # noqa: E402
from code_metrics.halstead import maintainability_index  # noqa: E402


def functions(language, source):
    return {func.name: func for func in analyze_source(source, LANGUAGES[language])[0]}


def cognitive(language, source):
    return {name: func.cognitive_complexity for name, func in functions(language, source).items()}


JAVA_WHITE_PAPER = '''
class S {
  int sumOfPrimes(int max) {
    int total = 0;
    OUT: for (int i = 1; i <= max; ++i) {
      for (int j = 2; j < i; ++j) {
        if (i % j == 0) {
          continue OUT;
        }
      }
      total += i;
    }
    return total;
  }
  String getWords(int number) {
    switch (number) {
      case 1: return "one";
      case 2: return "a couple";
      default: return "lots";
    }
  }
  void nesting() {
    try {
      if (condition1) {
        for (int i = 0; i < 10; i++) {
          while (condition2) { x(); }
        }
      }
    } catch (ExcepType1 | ExcepType2 e) {
      if (condition2) { y(); }
    }
  }
  void operators() {
    if (a && b && c || d || e && f) { z(); }
  }
  void chain(int a) {
    if (a > 1) { x(); } else if (a > 2) { y(); } else { z(); }
  }
  void straight(int a) { int b = a + 1; }
  void doWhile(int a) { do { a--; } while (a > 0); }
}
'''


class CognitiveComplexityTests(unittest.TestCase):
    def test_white_paper_examples(self):
        values = cognitive('Java', JAVA_WHITE_PAPER)
        self.assertEqual(values['S::sumOfPrimes'], 7)   # for +1, for +2, if +3, labelled continue +1
        self.assertEqual(values['S::getWords'], 1)      # a switch counts once, its cases not at all
        self.assertEqual(values['S::nesting'], 9)       # try does not nest; catch does
        self.assertEqual(values['S::operators'], 4)     # if +1, three sequences of like operators
        self.assertEqual(values['S::chain'], 3)         # if +1, else if +1, else +1
        self.assertEqual(values['S::straight'], 0)
        self.assertEqual(values['S::doWhile'], 1)       # the loop once, not again at its `while`

    def test_indentation_family(self):
        values = cognitive('Python', '''
def sum_of_primes(mx):
    total = 0
    for i in range(1, mx):
        for j in range(2, i):
            if i % j == 0:
                break
        total += i
    return total

def nesting():
    try:
        if c1:
            for i in range(10):
                while c2:
                    pass
    except (E1, E2):
        if c2:
            pass
    finally:
        pass

def words(n):
    match n:
        case 1:
            return "one"
        case _:
            return "lots"

def ternary(a, b):
    x = a if b else None
    if a and b or c:
        return x
    elif b:
        return 1
    else:
        return 2
''')
        self.assertEqual(values, {'sum_of_primes': 6, 'nesting': 9, 'words': 1, 'ternary': 6})

    def test_end_family(self):
        ruby = cognitive('Ruby', '''
def f(a)
  begin
    if a
      a.each do |x|
        puts x unless x.nil?
      end
    elsif a == 2
      1
    else
      2
    end
  rescue StandardError
    3
  end
end
''')
        # if +1, unless +2 (inside the if), elsif +1, else +1, rescue +1 (begin does not nest)
        self.assertEqual(ruby['f'], 6)
        lua = cognitive('Lua', '''
function f(a)
  repeat
    if a and b then
      x()
    elseif c then
      y()
    end
  until a
end
''')
        self.assertEqual(lua['f'], 5)   # repeat +1 (not again at until), if +2, and +1, elseif +1

    def test_brace_variants(self):
        go = cognitive('Go', '''package m
func f(a int) int {
	for i := 0; i < a; i++ {
		if i > 2 && a > 1 {
			switch i {
			case 1:
				return 1
			}
		} else {
			return 3
		}
	}
	return 0
}
''')
        self.assertEqual(go['f'], 8)   # for +1, if +2, && +1, switch +3, else +1
        kotlin = cognitive('Kotlin', '''
fun f(a: Int): Int {
    when (a) {
        1 -> return 1
        else -> {
            if (a > 2) return 2
        }
    }
    do { x() } while (a > 0)
    return 0
}
''')
        self.assertEqual(kotlin['f'], 4)   # when +1, if +2 (inside when), do +1
        js = cognitive('JavaScript', 'function f(a) { return a ? (b ?? c) : d; }\n')
        self.assertEqual(js['f'], 1)        # the conditional counts, null-coalescing does not

    def test_fortran_and_erlang(self):
        fortran = cognitive('Fortran', '''subroutine s(a)
  integer :: a, i
  do i = 1, a
    if (a > 1 .and. i > 2) then
      print *, i
    else if (a > 2) then
      print *, a
    end if
  end do
  select case (a)
  case (1)
    print *, 1
  case default
    print *, 2
  end select
end subroutine s
''')
        self.assertEqual(fortran['s'], 6)   # do +1, if +2, .and. +1, else if +1, select +1
        erlang = cognitive('Erlang', '''-module(s).
f(A) ->
    case A of
        1 -> if A > 0 andalso A < 2 -> ok; true -> no end;
        _ -> no
    end.
''')
        self.assertEqual(erlang['f'], 4)    # case +1, if +2, andalso +1


class HalsteadTests(unittest.TestCase):
    def test_hand_counted_function(self):
        func = functions('C', 'int add(int a, int b) { return a + b; }\n')['add']
        # The function owns its tokens from its name on (the return type is the caller's view):
        #   add ( int a , int b ) { return a + b ; }
        #   operators: (, int, ',', int, {, return, +, ;   -> N1 = 8, n1 = 7 (( int , { return + ;)
        #   operands:  add, a, b, a, b                      -> N2 = 5, n2 = 3 (add a b)
        n1, big_n1, n2, big_n2 = 7, 8, 3, 5
        volume = (big_n1 + big_n2) * math.log2(n1 + n2)
        difficulty = n1 / 2 * big_n2 / n2
        self.assertEqual(func.halstead['vocabulary'], n1 + n2)
        self.assertEqual(func.halstead['length'], big_n1 + big_n2)
        self.assertEqual(func.halstead['volume'], round(volume, 2))
        self.assertEqual(func.halstead['difficulty'], round(difficulty, 2))
        self.assertEqual(func.halstead['effort'], round(difficulty * volume, 2))
        self.assertEqual(func.halstead['bugs'], round(volume / 3000, 4))

    def test_keywords_are_operators_and_names_operands(self):
        func = functions('Python', 'def f(x):\n    return x if x else None\n')['f']
        # operators: return, if, else, (, :   operands: f, x x x x, None
        self.assertEqual(func.halstead['vocabulary'], 5 + 3)

    def test_every_value_is_finite_on_tiny_input(self):
        func = functions('JavaScript', 'function f() {}\n')['f']
        for value in func.halstead.values():
            self.assertTrue(math.isfinite(value))


class MaintainabilityIndexTests(unittest.TestCase):
    def test_formula_and_bounds(self):
        expected = (171 - 5.2 * math.log(100) - 0.23 * 3 - 16.2 * math.log(10)) * 100 / 171
        self.assertEqual(maintainability_index(100, 3, 10), round(expected, 1))
        self.assertEqual(maintainability_index(0, 1, 0), 99.9)           # empty input: V and LOC floored at 1
        self.assertEqual(maintainability_index(10 ** 9, 500, 10 ** 6), 0.0)   # floored at 0

    def test_analyzer_records_carry_every_new_field(self):
        import tempfile
        from code_metrics_analyzer import analyze_file
        with tempfile.NamedTemporaryFile('w', suffix='.py', delete=False, encoding='utf-8') as handle:
            handle.write('def f(a):\n    if a:\n        return 1\n    return 2\n')
        try:
            record = analyze_file(handle.name)['functions'][0]
        finally:
            Path(handle.name).unlink()
        for key in ('name', 'longName', 'lineStart', 'lineEnd', 'lineCount', 'complexity', 'parameters',
                    'maxNestingDepth', 'cyclomaticDensity'):
            self.assertIn(key, record)                    # the original contract is untouched
        self.assertEqual(record['cognitiveComplexity'], 1)
        self.assertGreater(record['halsteadVolume'], 0)
        self.assertGreater(record['halsteadDifficulty'], 0)
        self.assertGreater(record['halsteadEffort'], 0)
        self.assertGreater(record['halsteadBugs'], 0)
        self.assertTrue(0 < record['maintainabilityIndex'] <= 100)


if __name__ == '__main__':
    unittest.main()
