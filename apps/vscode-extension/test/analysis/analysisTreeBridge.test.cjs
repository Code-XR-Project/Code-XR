const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readConcatenated } = require('../helpers/sourceText.cjs');

const projectRoot = path.resolve(__dirname, '..', '..');
const baseInterfacesSource = fs.readFileSync(path.join(projectRoot, 'src', 'views', 'common', 'baseInterfaces.ts'), 'utf8');
// The provider and the section literals it registers (split out in W5-16).
const modularTreeSource = readConcatenated(['src/views/ModularTreeDataProvider.ts', 'src/views/sectionDefinitions.ts']);

test('modular tree base interfaces use the neutral analysis bridge properties', () => {
    assert.match(baseInterfacesSource, /analysisItemType\?:/);
    assert.match(baseInterfacesSource, /originalAnalysisItem\?: any;/);
    assert.equal(baseInterfacesSource.includes('codeAnalysisItemType'), false);
    assert.equal(baseInterfacesSource.includes('originalCodeAnalysisItem'), false);
});

test('modular tree provider routes analysis items through AnalysisSectionProvider without legacy bridge fields', () => {
    // Canary: the haystack still holds the provider and its section definitions.
    assert.match(modularTreeSource, /createSectionDefinitions\(context, \{/);
    assert.match(modularTreeSource, /AnalysisSectionProvider/);
    assert.match(modularTreeSource, /analysisItemType/);
    assert.match(modularTreeSource, /originalAnalysisItem/);
    assert.equal(modularTreeSource.includes('codeAnalysisItemType'), false);
    assert.equal(modularTreeSource.includes('originalCodeAnalysisItem'), false);
    assert.equal(modularTreeSource.includes('../analysis/views'), false);
});