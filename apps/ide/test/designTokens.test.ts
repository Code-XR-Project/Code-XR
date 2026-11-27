// Visual polish V1: the renderer's stylesheets take colours, type sizes,
// radii and shadows from the design tokens declared at the top of styles.css.
// A raw value anywhere else is how the workbench drifted into eleven font
// sizes and nine radii; this test keeps it from drifting back.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const RENDERER = join(import.meta.dirname, '..', 'src', 'renderer');

function cssFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
            return name === 'public' ? [] : cssFiles(path);
        }
        return name.endsWith('.css') ? [path] : [];
    });
}

/** The token blocks: `:root { ... }`, also inside the light-theme media query. */
function withoutTokenBlocks(css: string): string {
    return css.replace(/:root\s*\{[^}]*\}/g, (block) => '\n'.repeat(block.split('\n').length - 1));
}

function withoutComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, (comment) => '\n'.repeat(comment.split('\n').length - 1));
}

interface Hit { file: string; line: number; text: string }

function scan(pattern: RegExp, allow: (line: string) => boolean = () => false): Hit[] {
    const hits: Hit[] = [];
    for (const file of cssFiles(RENDERER)) {
        const lines = withoutTokenBlocks(withoutComments(readFileSync(file, 'utf8'))).split('\n');
        lines.forEach((text, index) => {
            if (pattern.test(text) && !allow(text)) {
                hits.push({ file: relative(RENDERER, file), line: index + 1, text: text.trim() });
            }
        });
    }
    return hits;
}

const report = (hits: Hit[]): string => hits.map((hit) => `${hit.file}:${hit.line}  ${hit.text}`).join('\n');

describe('design tokens (visual polish V1)', () => {
    it('finds the stylesheets', () => {
        assert.ok(cssFiles(RENDERER).length >= 6);
    });

    it('declares every token it relies on, in both themes where it changes', () => {
        const css = readFileSync(join(RENDERER, 'styles.css'), 'utf8');
        for (const token of ['--fs-xs', '--fs-sm', '--fs-md', '--radius', '--radius-pill', '--shadow-md', '--font-mono', '--control-h', '--button-bg', '--on-accent', '--ok', '--line-strong']) {
            assert.match(css, new RegExp(`${token}:`), `${token} is not declared`);
        }
        const light = css.slice(css.indexOf('@media (prefers-color-scheme: light)'));
        for (const token of ['--ok', '--button-bg', '--line-strong', '--shadow-md', '--on-warn']) {
            assert.match(light, new RegExp(`${token}:`), `${token} has no light-theme value`);
        }
    });

    it('uses no hex colour outside the token blocks', () => {
        assert.deepEqual(scan(/#[0-9a-f]{3,8}\b/i), [], report(scan(/#[0-9a-f]{3,8}\b/i)));
    });

    it('uses no px font size outside the type scale (icon glyphs excepted)', () => {
        const hits = scan(/font(-size)?:\s*\d+(\.\d+)?px/, (line) => /glyph/.test(line));
        assert.deepEqual(hits, [], report(hits));
    });

    it('uses no px border radius outside the radius scale', () => {
        const hits = scan(/border-radius:\s*\d+(\.\d+)?px/);
        assert.deepEqual(hits, [], report(hits));
    });

    it('draws shadows only from the elevation tokens', () => {
        const hits = scan(/box-shadow:[^;]*rgba?\(/);
        assert.deepEqual(hits, [], report(hits));
    });

    it('writes the monospace stack once', () => {
        const hits = scan(/Consolas|Menlo/);
        assert.deepEqual(hits, [], report(hits));
    });
});
