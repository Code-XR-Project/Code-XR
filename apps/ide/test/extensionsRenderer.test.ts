import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { InstalledExtension, ResolvedTheme } from '../src/shared/extensions.ts';
import { normalizeHex, ruleToken, toMonacoTheme, workbenchVariables } from '../src/renderer/extensions/themeModel.ts';
import { detectLanguage, mergeLanguages, safeRegExp, snippetsFor, toLanguageConfiguration } from '../src/renderer/extensions/languageModel.ts';
import { compactCount, installedStateLabel, matchesInstalled, rowAction } from '../src/renderer/extensions/extensionsModel.ts';

const THEME: ResolvedTheme = {
    id: 'ext:acme.kit/Kit',
    label: 'Kit',
    uiTheme: 'vs-dark',
    colors: { 'editor.background': '#1e1e1e', 'editor.foreground': '#ddd', 'sideBar.background': '#252526', 'statusBar.background': '#007acc', 'activityBar.background': 'not-a-colour', focusBorder: '#0078d4AA' },
    tokenColors: [
        { scope: ['comment'], foreground: '#6a9955', fontStyle: 'italic' },
        { scope: ['keyword.control', 'keyword'], foreground: '#C586C0' },
        { scope: ['source.js meta.function entity.name.function'], foreground: '#dcdcaa' },
        { scope: ['-comment', 'a | b'], foreground: '#ffffff' },
        { scope: ['constant.numeric'], foreground: '#b5cea8' },
        { scope: ['string'] },
    ],
    semanticHighlighting: false,
};

describe('colour themes from extensions (#257)', () => {
    it('normalises hex colours', () => {
        assert.equal(normalizeHex('#ABC'), '#aabbcc');
        assert.equal(normalizeHex('#abcd'), '#aabbccdd');
        assert.equal(normalizeHex('#0078d4AA'), '#0078d4aa');
        assert.equal(normalizeHex('red'), null);
        assert.equal(normalizeHex(undefined), null);
    });

    it('takes the innermost scope of a selector and skips exclusions', () => {
        assert.equal(ruleToken('source.js meta.function entity.name.function'), 'entity.name.function');
        assert.equal(ruleToken('-comment'), null);
        assert.equal(ruleToken(''), null);
    });

    it('builds a Monaco theme with default colours, TextMate rules and Monarch aliases', () => {
        const theme = toMonacoTheme(THEME);
        assert.equal(theme.base, 'vs-dark');
        assert.equal(theme.inherit, true);
        assert.deepEqual(theme.rules.find((rule) => rule.token === ''), { token: '', foreground: 'dddddd', background: '1e1e1e' });
        assert.deepEqual(theme.rules.find((rule) => rule.token === 'comment'), { token: 'comment', foreground: '6a9955', fontStyle: 'italic' });
        assert.ok(theme.rules.some((rule) => rule.token === 'keyword.control' && rule.foreground === 'c586c0'));
        assert.ok(theme.rules.some((rule) => rule.token === 'number' && rule.foreground === 'b5cea8'), 'constant.numeric also colours Monarch numbers');
        assert.ok(theme.rules.some((rule) => rule.token === 'function' && rule.foreground === 'dcdcaa'));
        assert.equal(theme.rules.some((rule) => rule.token === 'string'), false, 'a rule with no settings is dropped');
        assert.equal(theme.colors['activityBar.background'], undefined, 'invalid colours are dropped');
        assert.equal(theme.colors['editor.foreground'], '#dddddd');
    });

    it('maps theme colours onto the workbench tokens and --vscode-* variables', () => {
        const vars = workbenchVariables(THEME);
        assert.equal(vars['--editor'], '#1e1e1e');
        assert.equal(vars['--panel'], '#252526');
        assert.equal(vars['--chrome'], '#252526', 'falls through an invalid activityBar colour to the side bar');
        assert.equal(vars['--status'], '#007acc');
        assert.equal(vars['--accent'], '#0078d4aa');
        assert.equal(vars['--vscode-editor-background'], '#1e1e1e');
        assert.equal(vars['--vscode-activityBar-background'], undefined);
    });
});

describe('languages from extensions (#258)', () => {
    const lang = (id: string, extra: Partial<{ extensions: string[]; filenames: string[]; filenamePatterns: string[]; firstLine: string; configuration: unknown }> = {}) => ({
        id, extensionId: 'acme.kit', aliases: [], extensions: [], filenames: [], filenamePatterns: [], firstLine: null, mimetypes: [], configuration: null, ...extra,
    });

    it('merges the entries of one language id', () => {
        const merged = mergeLanguages([lang('toml', { extensions: ['.toml'] }), lang('toml', { extensions: ['.toml', '.tml'], filenames: ['Cargo.lock'], configuration: { a: 1 } })]);
        assert.equal(merged.length, 1);
        assert.deepEqual(merged[0]?.entry.extensions, ['.toml', '.tml']);
        assert.deepEqual(merged[0]?.configuration, { a: 1 });
    });

    it('detects a file\'s language by name, longest extension, then pattern', () => {
        const entries = [{ id: 'yaml', extensions: ['.yml'] }, { id: 'docker-compose', extensions: ['.compose.yml'] }, { id: 'make', filenames: ['Makefile'] }, { id: 'env', filenamePatterns: ['.env.*'] }];
        assert.equal(detectLanguage('a.yml', entries), 'yaml');
        assert.equal(detectLanguage('x.compose.yml', entries), 'docker-compose');
        assert.equal(detectLanguage('makefile', entries), 'make');
        assert.equal(detectLanguage('.env.local', entries), 'env');
        assert.equal(detectLanguage('a.txt', entries), null);
    });

    it('turns language-configuration.json patterns into RegExps and drops invalid ones', () => {
        assert.equal(safeRegExp('('), null);
        assert.equal(safeRegExp({ pattern: '^\\s*#region', flags: 'i' })?.flags, 'i');
        const config = toLanguageConfiguration({
            comments: { lineComment: '#', blockComment: ['/*', '*/'] },
            brackets: [['{', '}'], ['bad']],
            autoClosingPairs: [['(', ')'], { open: '"', close: '"', notIn: ['string'] }],
            surroundingPairs: [['[', ']']],
            wordPattern: '[a-z]+',
            folding: { markers: { start: '^#region', end: '^#endregion' }, offSide: true },
            indentationRules: { increaseIndentPattern: ':\\s*$', decreaseIndentPattern: '^\\s*else' },
            onEnterRules: [{ beforeText: '^\\s*//', action: { indent: 'none', appendText: '// ' } }, { beforeText: '(', action: { indent: 'indent' } }],
        }, { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 });
        assert.deepEqual(config.comments, { lineComment: '#', blockComment: ['/*', '*/'] });
        assert.deepEqual(config.brackets, [['{', '}']]);
        assert.deepEqual(config.autoClosingPairs, [{ open: '(', close: ')' }, { open: '"', close: '"', notIn: ['string'] }]);
        assert.ok(config.wordPattern instanceof RegExp);
        assert.equal((config.folding as { offSide: boolean }).offSide, true);
        const rules = config.onEnterRules as { action: { indentAction: number; appendText?: string } }[];
        assert.equal(rules.length, 1, 'the rule whose pattern does not compile is dropped');
        assert.deepEqual(rules[0]?.action, { indentAction: 0, appendText: '// ' });
    });

    it('picks the snippets of a language plus the global ones', () => {
        const snippets = [{ extensionId: 'e', language: 'kit', name: 'a', prefixes: ['a'], body: 'a', description: '' }, { extensionId: 'e', language: '*', name: 'b', prefixes: ['b'], body: 'b', description: '' }, { extensionId: 'e', language: 'other', name: 'c', prefixes: ['c'], body: 'c', description: '' }];
        assert.deepEqual(snippetsFor(snippets, 'kit').map((s) => s.name), ['a', 'b']);
    });
});

describe('Extensions view model (#255)', () => {
    const installed = (extra: Partial<InstalledExtension> = {}): InstalledExtension => ({
        id: 'acme.demo', publisher: 'acme', name: 'demo', version: '1.2.0', displayName: 'Demo', description: 'Does demos', categories: ['Themes'], license: 'MIT', repository: null, icon: null,
        hasCode: true, state: 'enabled', activation: 'inactive', engine: '^1.80.0', engineWarning: false, source: 'open-vsx', installedAt: 0,
        contributes: { themes: [], iconThemes: [], languages: [], grammars: 0, snippets: 0, commands: [], views: [], settings: 0, keybindings: 0, localizations: [] }, supportsUntrusted: false, ...extra,
    });
    const gallery = { id: 'acme.demo', namespace: 'acme', name: 'demo', version: '1.3.0', displayName: 'Demo', description: '', iconUrl: null, downloadCount: 0, averageRating: null, verified: false, timestamp: null };

    it('formats download counts', () => {
        assert.equal(compactCount(999), '999');
        assert.equal(compactCount(45_300), '45.3K');
        assert.equal(compactCount(1_000), '1K');
        assert.equal(compactCount(12_345_678), '12.3M');
        assert.equal(compactCount(250_000_000), '250M');
    });

    it('labels the state of an installed extension', () => {
        assert.equal(installedStateLabel(installed({ state: 'disabled' })), 'Disabled');
        assert.equal(installedStateLabel(installed({ state: 'restricted' })), 'Disabled in Restricted Mode');
        assert.equal(installedStateLabel(installed({ activation: 'active' })), 'Active');
        assert.equal(installedStateLabel(installed({ activation: 'failed' })), 'Failed to activate');
        assert.match(installedStateLabel(installed({ engineWarning: true })), /asks for VS Code/);
    });

    it('offers install, update or nothing', () => {
        assert.equal(rowAction(gallery, undefined, false).kind, 'install');
        assert.equal(rowAction(gallery, installed(), false).kind, 'update');
        assert.equal(rowAction(gallery, installed({ version: '1.3.0' }), false).kind, 'installed');
        assert.equal(rowAction(gallery, undefined, true).kind, 'busy');
    });

    it('filters the installed list', () => {
        assert.equal(matchesInstalled(installed(), 'DEMO'), true);
        assert.equal(matchesInstalled(installed(), 'themes'), true);
        assert.equal(matchesInstalled(installed(), 'python'), false);
        assert.equal(matchesInstalled(installed(), ' '), true);
    });
});
