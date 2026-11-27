const test = require('node:test');
const assert = require('node:assert/strict');
const { parseParserDownload, PARSER_DOWNLOAD_TIMEOUT_MS } = require('../../out/core/python-env/parserDownload.js');

test('parseParserDownload reads the summary line', () => {
    const out = 'some warning\n{"cacheDir": "/v/codexr-tree-sitter", "requested": ["python", "rust"], "downloaded": ["python"], "missing": ["rust"]}\n';
    assert.deepEqual(parseParserDownload(out), { requested: ['python', 'rust'], downloaded: ['python'], missing: ['rust'] });
});

test('parseParserDownload keeps the error and accepts CRLF', () => {
    const out = '{"requested": ["go"], "downloaded": [], "missing": ["go"], "error": "offline"}\r\n';
    assert.deepEqual(parseParserDownload(out), { requested: ['go'], downloaded: [], missing: ['go'], error: 'offline' });
});

test('parseParserDownload rejects output without a valid summary', () => {
    assert.equal(parseParserDownload(''), undefined);
    assert.equal(parseParserDownload('{not json'), undefined);
    assert.equal(parseParserDownload('{"requested": "python"}'), undefined);
});

test('the parser download gets more time than an ordinary command', () => {
    assert.ok(PARSER_DOWNLOAD_TIMEOUT_MS > 60000);
});
