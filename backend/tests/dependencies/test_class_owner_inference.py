"""Characterization of ``_infer_class_owner`` (W5-49), written before its refactor.

It pins today's answers, including the ones that look wrong, so the split into one
helper per algorithm cannot change them:

* a qualified name that contains a class name wins before any line walk, in every language;
* Python and GDScript walk indentation: the closest earlier class whose body is still
  open at the function line owns it, and comment, decorator and blank lines never close
  a body;
* every other language counts braces from the class line THROUGH the function line,
  so a top-level function whose own ``{`` sits on its declaration line becomes a method
  of the class above it (quirk, kept);
* the first open class answers, even when its name is missing from ``class_ids``: the
  walk then returns None instead of trying an outer class (quirk, kept).
"""
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
UTILS = ROOT / "backend" / "src" / "utils"
if str(UTILS) not in sys.path:
    sys.path.insert(0, str(UTILS))

from dependency_analysis_engine import _infer_class_owner, analyze_file_dependencies


def owner(source, line_start, language, qualified="f", class_ids=None):
    """Run the inference over ``source`` with every ``class``/``struct`` line registered."""
    lines = source.split("\n")
    classes = []
    for number, line in enumerate(lines, start=1):
        words = line.replace("{", " ").replace(":", " ").split()
        for keyword in ("class", "struct"):
            if keyword in words:
                classes.append({"name": words[words.index(keyword) + 1], "line": number})
    if class_ids is None:
        class_ids = {item["name"].lower(): "id:" + item["name"] for item in classes}
    return _infer_class_owner(classes, class_ids, lines, line_start, qualified, language)


PYTHON = "\n".join([
    "class Outer:",            # 1
    "    def a(self):",        # 2
    "        pass",            # 3
    "    class Inner:",        # 4
    "        def b(self):",    # 5
    "            pass",        # 6
    "    def c(self):",        # 7
    "        pass",            # 8
    "",                        # 9
    "# comment at column 0",   # 10
    "@decorator",              # 11
    "    def d(self):",        # 12
    "        pass",            # 13
    "x = 1",                   # 14
    "    def e():",            # 15
    "def top():",              # 16
    "    pass",                # 17
])

BRACES = "\n".join([
    "class Shape {",           # 1
    "  area() {",              # 2
    "    return 0;",           # 3
    "  }",                     # 4
    "}",                       # 5
    "function after() {",      # 6
    "  return 1;",             # 7
    "}",                       # 8
    "function bare()",         # 9
    "struct Point {",          # 10
    "  int x; struct Inner {", # 11
    "    void m() {}",         # 12
    "  };",                    # 13
    "  void n() {}",           # 14
    "};",                      # 15
])


class QualifiedNameTests(unittest.TestCase):
    def test_qualified_name_containing_a_class_name_wins_in_any_language(self):
        self.assertEqual("id:Shape", owner(BRACES, 9, "JavaScript", qualified="Shape::bare"))
        self.assertEqual("id:Outer", owner(PYTHON, 16, "Python", qualified="Outer.top"))

    def test_the_match_is_a_lowercase_substring_test_in_class_ids_order(self):
        class_ids = {"shape": "id:Shape", "point": "id:Point"}
        self.assertEqual("id:Shape", owner(BRACES, 1, "C++", qualified="PointShape.x", class_ids=class_ids))
        self.assertEqual("id:Point", owner(BRACES, 1, "C++", qualified="APPOINTMENT", class_ids=class_ids))


class IndentationTests(unittest.TestCase):
    def test_methods_belong_to_the_closest_open_class(self):
        self.assertEqual("id:Outer", owner(PYTHON, 2, "Python"))
        self.assertEqual("id:Inner", owner(PYTHON, 5, "Python"))
        self.assertEqual("id:Outer", owner(PYTHON, 7, "Python"))
        self.assertEqual("id:Outer", owner(PYTHON, 7, "GDScript"))

    def test_comment_decorator_and_blank_lines_do_not_close_a_body(self):
        self.assertEqual("id:Outer", owner(PYTHON, 12, "Python"))

    def test_a_column_zero_statement_closes_every_body(self):
        self.assertIsNone(owner(PYTHON, 15, "Python"))

    def test_a_function_not_indented_past_the_class_is_not_a_method(self):
        self.assertIsNone(owner(PYTHON, 16, "Python"))
        self.assertIsNone(owner(PYTHON, 1, "Python"))

    def test_a_function_line_past_the_end_of_the_source_reads_as_column_zero(self):
        self.assertIsNone(owner(PYTHON, 99, "Python"))

    def test_an_open_class_missing_from_class_ids_answers_none(self):
        class_ids = {"outer": "id:Outer"}
        self.assertIsNone(owner(PYTHON, 5, "Python", class_ids=class_ids))

    def test_classes_with_unusable_lines_are_skipped(self):
        lines = PYTHON.split("\n")
        classes = [
            {"name": "Outer", "line": 1},
            {"name": "Ghost", "line": 0},
            {"name": "Ghost", "line": None},
            {"name": "Later", "line": 7},
        ]
        class_ids = {"outer": "id:Outer", "ghost": "id:Ghost", "later": "id:Later"}
        self.assertEqual("id:Outer", _infer_class_owner(classes, class_ids, lines, 3, "f", "Python"))
        self.assertIsNone(_infer_class_owner(
            [{"name": "Far", "line": 50}], {"far": "id:Far"}, lines, 60, "f", "Python",
        ))


class BraceTests(unittest.TestCase):
    def test_methods_inside_an_open_brace_belong_to_the_class(self):
        self.assertEqual("id:Shape", owner(BRACES, 2, "JavaScript"))
        self.assertEqual("id:Inner", owner(BRACES, 12, "C++"))
        self.assertEqual("id:Point", owner(BRACES, 14, "C++"))

    def test_quirk_a_top_level_function_opening_its_brace_becomes_a_method(self):
        # Lines 1..6 hold three "{" and two "}": the function's own brace tips the count.
        self.assertEqual("id:Shape", owner(BRACES, 6, "JavaScript"))

    def test_a_top_level_function_without_a_brace_on_its_line_is_not_a_method(self):
        self.assertIsNone(owner(BRACES, 9, "JavaScript"))

    def test_any_language_other_than_python_and_gdscript_counts_braces(self):
        self.assertEqual("id:Shape", owner(BRACES, 6, "Ruby"))
        self.assertEqual("id:Shape", owner(BRACES, 6, ""))


class FileModeQuirkTests(unittest.TestCase):
    def test_file_mode_reports_the_brace_quirk_as_a_method(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "shapes.js"
            target.write_text(
                "class Shape {\n"
                "  area() {\n"
                "    return 0;\n"
                "  }\n"
                "}\n"
                "function after() {\n"
                "  return 1;\n"
                "}\n",
                encoding="utf-8",
            )
            result = analyze_file_dependencies(str(target), project_root=temporary)
            by_label = {node["label"]: node for node in result["nodes"] if node.get("kind") == "symbol"}
            self.assertEqual("class", by_label["Shape"]["symbolKind"])
            self.assertEqual("method", by_label["after"]["symbolKind"])
            self.assertEqual(by_label["Shape"]["id"], by_label["after"]["ownerId"])


if __name__ == "__main__":
    unittest.main()
