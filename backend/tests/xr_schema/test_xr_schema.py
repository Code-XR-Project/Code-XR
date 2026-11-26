import importlib.util
import tempfile
import unittest
from pathlib import Path
import sys

PROJECT_ROOT = Path(__file__).resolve().parents[3]
PYTHON_ROOT = PROJECT_ROOT / 'backend' / 'src'
for extra_path in [PYTHON_ROOT, PYTHON_ROOT / 'utils', PYTHON_ROOT / 'livePanels', PYTHON_ROOT / 'XR']:
    if str(extra_path) not in sys.path:
        sys.path.insert(0, str(extra_path))

from xr_field_schema import FILE_METRIC_FIELD_IDS, FUNCTION_METRIC_FIELD_IDS  # noqa: E402

MAIN_MODULE_PATH = PYTHON_ROOT / 'main.py'
XR_DIRECTORY_MODULE_PATH = PYTHON_ROOT / 'XR' / 'xr_directory_analysis_coordinator.py'
FILE_COORDINATOR_PATH = PYTHON_ROOT / 'livePanels' / 'livePanel_file_analysis_coordinator.py'
XR_FILE_COORDINATOR_PATH = PYTHON_ROOT / 'XR' / 'xr_file_analysis_coordinator.py'


execute_schema_request = None
analyze_directory_xr = None
analyze_file_comprehensive = None
analyze_file_for_xr = None


def _load_module(name, module_path):
    spec = importlib.util.spec_from_file_location(name, module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def setUpModule():
    global execute_schema_request, analyze_directory_xr, analyze_file_comprehensive, analyze_file_for_xr
    execute_schema_request = _load_module('analysis_main', MAIN_MODULE_PATH).execute_schema_request
    analyze_directory_xr = _load_module('xr_directory_analysis_coordinator', XR_DIRECTORY_MODULE_PATH).analyze_directory_xr
    analyze_file_comprehensive = _load_module('livepanel_file_analysis_coordinator', FILE_COORDINATOR_PATH).analyze_file_comprehensive
    analyze_file_for_xr = _load_module('xr_file_analysis_coordinator', XR_FILE_COORDINATOR_PATH).analyze_file_for_xr



class XRSchemaContractTests(unittest.TestCase):
    def test_main_schema_mode_returns_expected_contract_sizes(self):
        file_schema = execute_schema_request('file')
        directory_schema = execute_schema_request('directory')

        self.assertEqual(file_schema['schemaVersion'], 1)
        self.assertEqual(file_schema['analysisMode'], 'xr')
        self.assertEqual(file_schema['targetType'], 'file')
        # 13 original fields + 6 per-function metrics of epic #219 (all numeric).
        self.assertEqual(len(file_schema['fields']), 19)
        self.assertEqual(sum(1 for field in file_schema['fields'] if field['valueType'] == 'numeric'), 14)

        self.assertEqual(directory_schema['schemaVersion'], 1)
        self.assertEqual(directory_schema['analysisMode'], 'xr')
        self.assertEqual(directory_schema['targetType'], 'directory')
        # 25 original fields + 6 file aggregates of epic #219 (all numeric).
        self.assertEqual(len(directory_schema['fields']), 31)
        self.assertEqual(sum(1 for field in directory_schema['fields'] if field['valueType'] == 'numeric'), 27)

    def test_new_metric_fields_are_appended_without_touching_the_old_ones(self):
        file_ids = [field['id'] for field in execute_schema_request('file')['fields']]
        directory_ids = [field['id'] for field in execute_schema_request('directory')['fields']]
        self.assertEqual(
            [field_id for field_id in file_ids if field_id not in FUNCTION_METRIC_FIELD_IDS],
            ['functionName', 'lineStart', 'lineEnd', 'lineCount', 'spanLines', 'complexity', 'complexityBand',
             'parameters', 'maxNestingDepth', 'cyclomaticDensity', 'filePath', 'fileName', 'treePath'],
        )
        self.assertEqual(len([i for i in directory_ids if i not in FILE_METRIC_FIELD_IDS]), 25)
        for field_id in FUNCTION_METRIC_FIELD_IDS:
            self.assertIn(field_id, file_ids)
        for field_id in FILE_METRIC_FIELD_IDS:
            self.assertIn(field_id, directory_ids)

    def test_file_livepanel_and_xr_payloads_match(self):
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False) as handle:
            handle.write(
                'def sample(value, flag):\n'
                '    if flag:\n'
                '        for item in value:\n'
                '            return item\n'
                '    return value\n'
            )
            file_path = handle.name

        try:
            livepanel_payload = analyze_file_comprehensive(file_path)
            xr_payload = analyze_file_for_xr(file_path)
            self.assertEqual(livepanel_payload, xr_payload)
            self.assertEqual(len(livepanel_payload), 1)
            self.assertEqual(livepanel_payload[0]['functionName'], 'sample')
            self.assertEqual(livepanel_payload[0]['maxNestingDepth'], 2)
            self.assertEqual(livepanel_payload[0]['parameters'], 2)
            self.assertIn('treePath', livepanel_payload[0])
            self.assertIn('modifiedAtMs', livepanel_payload[0])
            self.assertIn('modifiedAtIso', livepanel_payload[0])
            # Every field the schema offers to a chart axis is in the data row.
            for field in execute_schema_request('file')['fields']:
                self.assertIn(field['id'], livepanel_payload[0])
            self.assertEqual(livepanel_payload[0]['cognitiveComplexity'], 3)     # if +1, nested for +2
            self.assertGreater(livepanel_payload[0]['halsteadVolume'], 0)
            self.assertTrue(0 < livepanel_payload[0]['maintainabilityIndex'] <= 100)
        finally:
            Path(file_path).unlink(missing_ok=True)

    def test_directory_xr_payload_is_flat_file_array(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            file_path = Path(temp_dir) / 'sample.py'
            file_path.write_text('def sample(value, flag):\n    return value\n', encoding='utf-8')

            payload = analyze_directory_xr(temp_dir, is_deep=False)
            self.assertEqual(len(payload), 1)
            self.assertEqual(payload[0]['relativePath'], 'sample.py')
            self.assertIn('maxFunctionNestingDepth', payload[0])
            self.assertIn('averageFunctionParameters', payload[0])
            self.assertIn('modifiedAtMs', payload[0])
            self.assertIn('modifiedAtIso', payload[0])
            for field in execute_schema_request('directory')['fields']:
                self.assertIn(field['id'], payload[0])
            self.assertEqual(payload[0]['maxCognitiveComplexity'], 0)
            self.assertGreater(payload[0]['totalHalsteadVolume'], 0)


if __name__ == '__main__':
    unittest.main()
