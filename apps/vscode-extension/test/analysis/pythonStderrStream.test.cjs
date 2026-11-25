const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// The pure stderr classifier ExecutePython uses (ROADMAP W4-L04). The end-to-end
// report sequence is pinned in pythonStderrProgress.test.cjs; this pins the
// log lines and the null cases, line by line.
const { classifyStderrLine } = require(path.join(__dirname, '..', '..', 'out', 'code_analysis', 'engine', 'utils', 'pythonStderrStream.js'));

test('a full progress line logs four lines and reports the basename with an increment of 100/total', () => {
    const line = JSON.stringify({ progress: {
        current: 1, total: 4, percentage: 25, fileName: 'src/pkg/a.py',
        message: 'Analyzing', operation: 'lizard', estimatedTime: '3s',
    } });

    assert.deepEqual(classifyStderrLine(`  ${line}  `), {
        logLines: [
            'PROGRESS [1/4] (25%) - Analyzing',
            'Current file: src/pkg/a.py',
            'Operation: lizard',
            'Estimated time remaining: 3s',
        ],
        report: { message: '1/4 (25%) - a.py', increment: 25 },
    });
});

test('a progress line with defaults, or with no total, logs but does not report', () => {
    assert.deepEqual(classifyStderrLine('{"progress":{"total":0}}'), {
        logLines: ['PROGRESS [0/0] (0%) - Processing', 'Current file: Processing file...'],
    });
    assert.deepEqual(classifyStderrLine('{"progress":{"current":2,"total":5,"file":"b.py"}}').report, {
        message: '2/5 (0%) - b.py',
        increment: 0,
    });
});

test('the other JSON keys: info reports, debug/warning/error only log, in that precedence', () => {
    assert.deepEqual(classifyStderrLine('{"info":"Loading"}'), { logLines: ['INFO: Loading'], report: { message: 'Loading' } });
    assert.deepEqual(classifyStderrLine('{"debug":"d","info":"i"}'), { logLines: ['DEBUG: d'] });
    assert.deepEqual(classifyStderrLine('{"warning":"w"}'), { logLines: ['WARNING: w'] });
    assert.deepEqual(classifyStderrLine('{"error":"e"}'), { logLines: ['ERROR: e'] });
});

test('null cases: blank lines, JSON scalars and objects with no known key produce nothing', () => {
    for (const line of ['', '   ', '42', '"text"', '[]', '{}', '{"other":1}', '{"info":""}']) {
        assert.equal(classifyStderrLine(line), null, JSON.stringify(line));
    }
});

test('free text: progress words report the trimmed line, anything else only logs it; `null` is text', () => {
    assert.deepEqual(classifyStderrLine('  Analyzing x '), { logLines: ['Analyzing x'], report: { message: 'Analyzing x' } });
    assert.deepEqual(classifyStderrLine('done 50%'), { logLines: ['done 50%'], report: { message: 'done 50%' } });
    assert.deepEqual(classifyStderrLine('Traceback ERROR'), { logLines: ['Traceback ERROR'] });
    assert.deepEqual(classifyStderrLine('null'), { logLines: ['null'] });
    assert.deepEqual(classifyStderrLine('{not json'), { logLines: ['{not json'] });
});
