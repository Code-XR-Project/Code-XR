import importlib.util
import tempfile
import unittest
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[3]
PYTHON_ROOT = PROJECT_ROOT / 'backend' / 'src'
for extra_path in [PYTHON_ROOT, PYTHON_ROOT / 'utils', PYTHON_ROOT / 'tools']:
    if str(extra_path) not in sys.path:
        sys.path.insert(0, str(extra_path))

ENGINE_PATH = PYTHON_ROOT / 'utils' / 'file_analysis_engine.py'
UTILS_PATH = PYTHON_ROOT / 'utils' / 'babia_path_utils.py'


build_file_snapshot = None
build_file_payload = None
normalize_path_for_babia = None
build_tree_path = None


def _load_module(name, module_path):
    spec = importlib.util.spec_from_file_location(name, module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def setUpModule():
    global build_file_snapshot, build_file_payload, normalize_path_for_babia, build_tree_path
    engine_module = _load_module('file_analysis_engine', ENGINE_PATH)
    util_module = _load_module('babia_path_utils', UTILS_PATH)
    build_file_snapshot = engine_module.build_file_snapshot
    build_file_payload = engine_module.build_file_payload
    normalize_path_for_babia = util_module.normalize_path_for_babia
    build_tree_path = util_module.build_tree_path



class EmptyFileHandlingTests(unittest.TestCase):
    def test_empty_file_returns_zeroed_snapshot_and_empty_payload(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.ts', delete=False) as handle:
            file_path = handle.name

        try:
            snapshot = build_file_snapshot(file_path)
            payload = build_file_payload(file_path, snapshot)
            self.assertEqual(snapshot['totalLines'], 0)
            self.assertEqual(snapshot['functionCount'], 0)
            self.assertEqual(snapshot['maxFunctionNestingDepth'], 0)
            self.assertIn('modifiedAtMs', snapshot)
            self.assertIn('modifiedAtIso', snapshot)
            self.assertIsInstance(snapshot['modifiedAtMs'], int)
            self.assertEqual(payload, [])
        finally:
            Path(file_path).unlink(missing_ok=True)

    def test_non_empty_file_returns_function_payload_with_normalized_path_and_tree_path(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.ts', delete=False) as handle:
            handle.write('const value = 1;\nfunction renderScene(input) {\n  return input + value;\n}\n')
            file_path = handle.name

        try:
            snapshot = build_file_snapshot(file_path)
            payload = build_file_payload(file_path, snapshot)
            self.assertEqual(len(payload), 1)
            self.assertEqual(payload[0]['functionName'], 'renderScene')
            self.assertEqual(payload[0]['lineStart'], 2)
            self.assertEqual(payload[0]['lineEnd'], 4)
            self.assertEqual(payload[0]['complexityBand'], 'normal')
            self.assertEqual(payload[0]['filePath'], normalize_path_for_babia(file_path))
            self.assertEqual(payload[0]['treePath'], build_tree_path(Path(file_path).name, 'renderScene'))
            self.assertEqual(payload[0]['modifiedAtMs'], snapshot['modifiedAtMs'])
            self.assertEqual(payload[0]['modifiedAtIso'], snapshot['modifiedAtIso'])
        finally:
            Path(file_path).unlink(missing_ok=True)


if __name__ == '__main__':
    unittest.main()

