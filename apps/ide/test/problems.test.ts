import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { filterProblems, groupProblems, mergeFileMetrics, metricProblems, parseFunctionMetrics, problemCounts, PROBLEM_SEVERITIES, type Problem } from '../src/shared/problems.ts';

const backendAnswer = [
    {
        relativePath: 'src/engine.py',
        language: 'Python',
        status: 'success',
        functions: [
            { functionName: 'run', qualifiedName: 'run(a, b)', lineStart: 3, lineEnd: 40, lineCount: 35, complexity: 23, parameters: 2, maxNestingDepth: 4 },
            { functionName: 'small', lineStart: 42, lineEnd: 44, lineCount: 3, complexity: 1, parameters: 7 },
        ],
    },
    { relativePath: 'lib\\win.ts', functions: [{ functionName: 'long', lineStart: 1, lineEnd: 90, lineCount: 80, complexity: 4, parameters: 0 }] },
    { relativePath: '../outside.py', functions: [{ functionName: 'x', lineStart: 1, complexity: 99 }] },
    { relativePath: '/etc/abs.py', functions: [] },
    { relativePath: 'C:/abs.py', functions: [] },
    { functions: [] },
    'junk',
    { relativePath: 'odd.js', functions: [{ lineStart: -4, lineEnd: 'x', complexity: 2.7, parameters: Number.NaN }, null] },
];

describe('function metrics from the backend (#173)', () => {
    it('keeps the usable entries, with whole numbers and no path out of the folder', () => {
        const files = parseFunctionMetrics(backendAnswer);
        assert.deepEqual(files.map((file) => file.path), ['src/engine.py', 'lib/win.ts', 'odd.js']);
        assert.deepEqual(files[0]?.functions[0], { name: 'run', lineStart: 3, lineEnd: 40, lineCount: 35, complexity: 23, parameters: 2 });
        assert.deepEqual(files[2]?.functions, [{ name: 'function', lineStart: 1, lineEnd: 1, lineCount: 0, complexity: 2, parameters: 0 }]);
        assert.deepEqual(parseFunctionMetrics({ error: true }), []);
    });

    it('replaces a re-measured file and drops one left without functions', () => {
        const files = parseFunctionMetrics(backendAnswer);
        const fresh = [{ path: 'lib/win.ts', functions: [] }, { path: 'new.ts', functions: [{ name: 'n', lineStart: 1, lineEnd: 2, lineCount: 2, complexity: 1, parameters: 0 }] }];
        assert.deepEqual(mergeFileMetrics(files, fresh).map((file) => file.path), ['new.ts', 'odd.js', 'src/engine.py']);
        assert.deepEqual(mergeFileMetrics(files, [], ['odd.js']).map((file) => file.path), ['lib/win.ts', 'src/engine.py']);
    });
});

describe('metric thresholds (#173)', () => {
    const files = parseFunctionMetrics(backendAnswer);

    it('warns on each limit a function passes, on its first line', () => {
        const problems = metricProblems(files, { complexity: 15, lines: 50, parameters: 5 });
        assert.deepEqual(problems.map((problem) => [problem.path, problem.code, problem.startLine]), [
            ['src/engine.py', 'complexity', 3],
            ['src/engine.py', 'parameters', 42],
            ['lib/win.ts', 'function-length', 1],
        ]);
        assert.equal(problems[0]?.message, "'run' has a cyclomatic complexity of 23 (limit 15).");
        assert.ok(problems.every((problem) => problem.severity === 'warning' && problem.origin === 'metrics' && problem.source === 'Code-XR'));
    });

    it('turns a check off at 0 and recomputes for new limits', () => {
        assert.deepEqual(metricProblems(files, { complexity: 0, lines: 0, parameters: 0 }), []);
        assert.equal(metricProblems(files, { complexity: 23, lines: 0, parameters: 0 }).length, 0);
        assert.equal(metricProblems(files, { complexity: 1, lines: 0, parameters: 0 }).length, 3);
    });
});

describe('the problem list (#173)', () => {
    const problem = (path: string, severity: Problem['severity'], line: number, message: string, origin: Problem['origin'] = 'editor'): Problem => ({
        path, severity, message, source: origin === 'editor' ? 'typescript' : 'Code-XR', origin, startLine: line, startColumn: 1, endLine: line, endColumn: 4,
    });
    const problems = [
        problem('src/b.ts', 'warning', 9, 'Unused variable'),
        problem('src/b.ts', 'error', 20, 'Cannot find name'),
        problem('src/b.ts', 'error', 2, 'Missing semicolon'),
        problem('a.py', 'warning', 1, "'run' has a cyclomatic complexity of 23", 'metrics'),
        problem('a.py', 'info', 5, 'Prefer const'),
    ];
    const everything = { text: '', severities: new Set(PROBLEM_SEVERITIES), origin: 'all' as const };

    it('groups by file, errors first then by line', () => {
        const groups = groupProblems(problems);
        assert.deepEqual(groups.map((group) => group.path), ['a.py', 'src/b.ts']);
        assert.deepEqual(groups[1]?.problems.map((p) => p.startLine), [2, 20, 9]);
        assert.deepEqual(problemCounts(problems), { error: 2, warning: 2, info: 1 });
    });

    it('filters by words, exclusions, severity and source', () => {
        assert.equal(filterProblems(problems, everything).length, 5);
        assert.deepEqual(filterProblems(problems, { ...everything, text: 'cannot B.TS' }).map((p) => p.message), ['Cannot find name']);
        assert.equal(filterProblems(problems, { ...everything, text: '!src/' }).length, 2);
        assert.equal(filterProblems(problems, { ...everything, text: 'code-xr' }).length, 1);
        assert.equal(filterProblems(problems, { ...everything, severities: new Set(['error'] as const) }).length, 2);
        assert.deepEqual(filterProblems(problems, { ...everything, origin: 'metrics' }).map((p) => p.path), ['a.py']);
    });
});
