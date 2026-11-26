import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { countSymbols, outlineFromFunctions, outlineKindOfTypeScript, sortOutline, symbolPathAt, type OutlineSymbol } from '../src/shared/outline.ts';

const fn = (name: string, lineStart: number, lineEnd: number) => ({ name, lineStart, lineEnd });
const shape = (symbols: readonly OutlineSymbol[]): unknown =>
    symbols.map((s) => (s.children.length > 0 ? [`${s.kind} ${s.name} ${s.startLine}-${s.endLine}`, shape(s.children)] : `${s.kind} ${s.name} ${s.startLine}-${s.endLine}`));

// The functions mode's answer for these files, as Lizard names them.
const PYTHON = [
    'class Shape:',
    '    def __init__(self, w):',
    '        self.w = w',
    '',
    '    def area(self):',
    '        def inner():',
    '            return 1',
    '        return inner()',
    '',
    'def top(a, b):',
    '    return a + b',
].join('\n');

const JAVA = [
    'public class A {',
    '    private String s = "}";',
    '    public A(int x) { this.x = x; }',
    '    public int get() { return x; } // }',
    '    static class B {',
    '        void run() {}',
    '    }',
    '}',
].join('\n');

describe('the outline from the analysis (#172)', () => {
    it('nests Python methods in their class by indentation, and nested functions in theirs', () => {
        const outline = outlineFromFunctions([fn('__init__', 2, 3), fn('area', 5, 8), fn('area.inner', 6, 7), fn('top', 10, 11)], PYTHON, 'python');
        assert.deepEqual(shape(outline), [
            ['class Shape 1-8', ['method __init__ 2-3', ['method area 5-8', ['function inner 6-7']]]],
            'function top 10-11',
        ]);
    });

    it('finds Java classes by their braces, skipping braces in strings and comments', () => {
        const outline = outlineFromFunctions([fn('A::A', 3, 3), fn('A::get', 4, 4), fn('B::run', 6, 6)], JAVA, 'java');
        assert.deepEqual(shape(outline), [
            ['class A 1-8', ['constructor A 3-3', 'method get 4-4', ['class B 5-7', ['method run 6-6']]]],
        ]);
    });

    it('groups functions qualified with a class that is not in the file (C++ out-of-class definitions)', () => {
        const text = 'int Shape::area() {\n  return 1;\n}\nint Shape::side() {\n  return 2;\n}\nint main() { return 0; }';
        const outline = outlineFromFunctions([fn('Shape::area', 1, 3), fn('Shape::side', 4, 6), fn('main', 7, 7)], text, 'cpp');
        assert.deepEqual(shape(outline), [['class Shape 1-6', ['method area 1-3', 'method side 4-6']], 'function main 7-7']);
    });

    it('leaves out declarations that hold no measured function, and a forward declaration', () => {
        const text = 'class Empty {\n}\nclass Later;\nvoid go() {\n}';
        assert.deepEqual(shape(outlineFromFunctions([fn('go', 4, 5)], text, 'cpp')), ['function go 4-5']);
    });

    it('gives an empty outline for a file with no functions', () => {
        assert.deepEqual(outlineFromFunctions([], 'x = 1', 'python'), []);
    });
});

describe('outline helpers', () => {
    const outline = outlineFromFunctions([fn('__init__', 2, 3), fn('area', 5, 8), fn('area.inner', 6, 7), fn('top', 10, 11)], PYTHON, 'python');

    it('finds the chain of symbols around a line', () => {
        assert.deepEqual(symbolPathAt(outline, 7).map((s) => s.name), ['Shape', 'area', 'inner']);
        assert.deepEqual(symbolPathAt(outline, 4).map((s) => s.name), ['Shape']);
        assert.deepEqual(symbolPathAt(outline, 9), []);
    });

    it('sorts by name at every level, or back by position', () => {
        const byName = sortOutline(outline, 'name');
        assert.deepEqual(byName.map((s) => s.name), ['Shape', 'top']);
        assert.deepEqual(byName[0]?.children.map((s) => s.name), ['__init__', 'area']);
        assert.deepEqual(sortOutline(byName, 'position'), sortOutline(outline, 'position'));
        assert.equal(countSymbols(outline), 5);
    });

    it("maps TypeScript's element kinds", () => {
        assert.equal(outlineKindOfTypeScript('class'), 'class');
        assert.equal(outlineKindOfTypeScript('getter'), 'method');
        assert.equal(outlineKindOfTypeScript('const'), 'constant');
        assert.equal(outlineKindOfTypeScript('toString'), 'other');
    });
});
