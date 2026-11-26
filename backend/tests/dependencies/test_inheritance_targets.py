"""#110: inheritance and implementation targets are real type names, never junk packages.

Before the fix, the lexical inheritance pattern read the body of a Python
`class X: pass` as a base (`pass`), the constraint of a generic parameter as
the declared base (`string>`, `any`, `object`), a comment's "object with scheme"
as a mixin, and the gap between two quoted strings (`'import' | 'require'`) as
a `require` specifier (`|`). Each became an external package node.
"""
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
UTILS = ROOT / "backend" / "src" / "utils"
if str(UTILS) not in sys.path:
    sys.path.insert(0, str(UTILS))

from dependency_analysis_engine import (  # noqa: E402
    analyze_dependencies,
    analyze_file_dependencies,
    _extract_targets,
)

PROJECT = {
    "py/models.py": (
        "class X: pass\n"
        "class A:\n"
        "    pass\n"
        "class B(A): pass\n"
        "class C(mixins.Base, A, metaclass=Meta, object):\n"
        "    value: int = 0\n"
        "class D(object): x = 1\n"
    ),
    "ts/server.ts": (
        "export type Relation = 'import' | 'require'\n"
        "  | 'inheritance';\n"
        "/** A URI-like object with scheme and path. */\n"
        "export interface Registration<TArgs extends any[] = any[]> {}\n"
        "export interface Adapter<Mode extends string> {}\n"
        "export interface Info<Mode extends string = string> {}\n"
        "export abstract class ServerBase<TConfig extends HttpsServerBaseConfig> {}\n"
        "export class Runner<TRequest extends object, TResult> extends EventEmitter {}\n"
        "export class Nested<T extends Map<string, Set<number>>> implements Disposable {}\n"
        "export class Circle extends Base<number> implements Shape {}\n"
    ),
    "java/Box.java": (
        "public class Box<T extends Comparable<T>> extends Container<T> implements Iterable<T> {}\n"
        "interface Sized<K extends Number> extends Measurable {}\n"
        "final class Plain implements java.io.Serializable {}\n"
    ),
}

JUNK = {"pass", "string", "string>", "any", "object", "scheme", "|", "int", "x",
        "HttpsServerBaseConfig", "HttpsServerBaseConfig>", "Comparable", "Number", "Map"}


def external_labels(result: dict) -> set[str]:
    return {node["label"] for node in result["nodes"] if node.get("external")}


def raw_bases(relative: str, language: str) -> set[str]:
    return {value for kind, value, _ in _extract_targets(PROJECT[relative], language)
            if kind in {"inheritance", "implementation"}}


def relations(result: dict) -> set[tuple[str, str, str]]:
    names = {node["id"]: node.get("relativePath") or node["label"] for node in result["nodes"]}
    return {(names[edge["source"]], names[edge["target"]], edge["kind"]) for edge in result["edges"]}


class InheritanceTargetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        root = Path(cls._tmp.name)
        for relative, content in PROJECT.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")
        cls.root = root
        cls.result = analyze_dependencies(str(root), recursive=True)

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()

    def test_no_junk_external_package(self):
        self.assertFalse(JUNK & external_labels(self.result), external_labels(self.result))

    def test_python_class_lines_yield_no_base(self):
        # Python bases (`class B(A)`) are not extracted yet; the point here is that
        # the class body after the colon is never read as one.
        self.assertFalse(any(source == "py/models.py" for source, _, _ in relations(self.result)))

    def test_typescript_bases_skip_generic_constraints(self):
        edges = relations(self.result)
        for base, kind in (("EventEmitter", "inheritance"), ("Disposable", "implementation"),
                           ("Base", "inheritance"), ("Shape", "implementation")):
            self.assertIn(("ts/server.ts", base, kind), edges)

    def test_java_bases_skip_generic_constraints(self):
        edges = relations(self.result)
        for base, kind in (("Container", "inheritance"), ("Iterable", "implementation"),
                           ("Measurable", "inheritance"), ("java", "implementation")):
            self.assertIn(("java/Box.java", base, kind), edges)

    def test_raw_targets_are_exactly_the_declared_bases(self):
        self.assertEqual(raw_bases("py/models.py", "Python"), set())
        self.assertEqual(raw_bases("ts/server.ts", "TypeScript"), {"EventEmitter", "Disposable", "Base", "Shape"})
        self.assertEqual(raw_bases("java/Box.java", "Java"),
                         {"Container", "Iterable", "Measurable", "java.io.Serializable"})

    def test_file_scope_uses_the_same_rules(self):
        for relative in PROJECT:
            result = analyze_file_dependencies(str(self.root / relative), str(self.root))
            self.assertFalse(JUNK & external_labels(result), (relative, external_labels(result)))

    def test_colon_bases_still_read_where_the_language_has_them(self):
        def bases(text: str, language: str) -> set[str]:
            return {value for kind, value, _ in _extract_targets(text, language)
                    if kind in {"inheritance", "implementation"}}

        self.assertEqual(bases("class Dog : public virtual Animal {};\n", "C++"), {"Animal"})
        self.assertEqual(bases("class Vec : public std::vector<int> {};\n", "C++"), {"std::vector"})
        self.assertEqual(bases("public class Repo<T> : IRepo where T : class {}\n", "C#"), {"IRepo"})
        self.assertEqual(bases("class Dog: Animal {}\n", "Swift"), {"Animal"})
        self.assertEqual(bases("class Dog(val name: String) : Animal()\n", "Kotlin"), {"Animal"})
        self.assertEqual(bases("@interface MetricBox : NSObject\n", "Objective-C"), {"NSObject"})
        self.assertEqual(bases("class X: pass\n", "Python"), set())
        self.assertEqual(bases("class Player:\n\tvar hp = 3\n", "GDScript"), set())

    def test_require_needs_a_real_specifier(self):
        requires = {value for kind, value, _ in _extract_targets(PROJECT["ts/server.ts"], "TypeScript")
                    if kind == "require"}
        self.assertEqual(requires, set())
        self.assertEqual(
            [value for kind, value, _ in _extract_targets("const fs = require('fs');\nrequire 'json'\n", "")
             if kind == "require"],
            ["fs", "json"],
        )


if __name__ == "__main__":
    unittest.main()
