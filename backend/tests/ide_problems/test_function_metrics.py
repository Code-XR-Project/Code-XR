"""The functions mode of main.py (#173): per-function metrics for the IDE's Problems panel."""

import tempfile
import unittest
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[3]
PYTHON_ROOT = PROJECT_ROOT / 'backend' / 'src'
for extra_path in [PYTHON_ROOT, PYTHON_ROOT / 'utils', PYTHON_ROOT / 'tools', Path(__file__).resolve().parents[1]]:
    if str(extra_path) not in sys.path:
        sys.path.insert(0, str(extra_path))

from function_metrics import analyze_function_metrics  # noqa: E402


class FunctionMetricsTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.TemporaryDirectory()
        base = Path(self.root.name)
        (base / 'src' / 'deep').mkdir(parents=True)
        (base / 'src' / 'deep' / 'engine.py').write_text(
            'def engine_main(a, b, c, d):\n'
            '    if a and b:\n'
            '        for x in c:\n'
            '            return x\n'
            '    return d\n'
            '\n'
            '\n'
            'def engine_late(value):\n'
            '    return value\n',
            encoding='utf-8',
        )
        (base / 'app.ts').write_text('function app() {}\n', encoding='utf-8')
        (base / 'notes.txt').write_text('not code\n', encoding='utf-8')

    def tearDown(self):
        self.root.cleanup()

    def test_directory_lists_each_analysable_file_with_its_functions(self):
        entries = analyze_function_metrics(self.root.name, 'directory', recursive=True)
        by_path = {entry['relativePath']: entry for entry in entries}
        self.assertEqual(sorted(by_path), ['app.ts', 'src/deep/engine.py'])
        engine = by_path['src/deep/engine.py']
        self.assertEqual(engine['language'], 'Python')
        self.assertEqual(engine['status'], 'success')
        # Sorted by line, trimmed to the fields the IDE reads.
        self.assertEqual([function['functionName'] for function in engine['functions']], ['engine_main', 'engine_late'])
        self.assertEqual(engine['functions'][0], {
            'functionName': 'engine_main', 'qualifiedName': 'engine_main(a, b, c, d)', 'lineStart': 1, 'lineEnd': 5,
            'lineCount': 5, 'complexity': 4, 'parameters': 4, 'maxNestingDepth': 2,
        })

    def test_shallow_directory_skips_subfolders(self):
        entries = analyze_function_metrics(self.root.name, 'directory', recursive=False)
        self.assertEqual([entry['relativePath'] for entry in entries], ['app.ts'])

    def test_file_path_is_relative_to_the_project_root(self):
        target = str(Path(self.root.name) / 'src' / 'deep' / 'engine.py')
        [entry] = analyze_function_metrics(target, 'file', project_root=self.root.name)
        self.assertEqual(entry['relativePath'], 'src/deep/engine.py')
        [alone] = analyze_function_metrics(target, 'file')
        self.assertEqual(alone['relativePath'], 'engine.py')


if __name__ == '__main__':
    unittest.main()
