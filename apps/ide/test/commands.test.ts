import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { commandLabel, createCommandRegistry, type CommandDefinition } from '../src/renderer/commands/commandRegistry.ts';
import { fuzzyMatch, highlightRuns } from '../src/renderer/commands/fuzzy.ts';
import { formatKeybinding, matchesKeybinding, parseKeybinding, type KeyEventLike } from '../src/renderer/commands/keybindings.ts';
import { paletteView, parseLinePosition, type PaletteContext } from '../src/renderer/commands/paletteModel.ts';
import { MENU_KEYBINDINGS, workbenchCommands, type WorkbenchCommandTargets } from '../src/renderer/commands/workbenchCommands.ts';
import { IDE_COMMANDS } from '../src/shared/api.ts';

const noop = (): void => undefined;

describe('command registry', () => {
    it('rejects a duplicate ID, like the extension does', () => {
        const registry = createCommandRegistry();
        registry.register({ id: 'file.save', title: 'Save', run: noop });
        assert.throws(() => registry.register({ id: 'file.save', title: 'Save again', run: noop }), /Duplicate command ID "file.save"/);
    });

    it('rejects malformed IDs and empty titles', () => {
        const registry = createCommandRegistry();
        assert.throws(() => registry.register({ id: 'save', title: 'Save', run: noop }), /Invalid command ID/);
        assert.throws(() => registry.register({ id: 'File.save', title: 'Save', run: noop }), /Invalid command ID/);
        assert.throws(() => registry.register({ id: 'file.save', title: '  ', run: noop }), /no title/);
    });

    it('runs enabled commands, refuses disabled or unknown ones, and remembers the recent ones', () => {
        const registry = createCommandRegistry();
        const ran: string[] = [];
        let enabled = false;
        registry.register({ id: 'a.one', title: 'One', run: () => { ran.push('one'); } });
        registry.register({ id: 'a.two', title: 'Two', enabled: () => enabled, run: () => { ran.push('two'); } });
        assert.equal(registry.execute('a.two'), false);
        assert.equal(registry.execute('a.missing'), false);
        enabled = true;
        assert.equal(registry.execute('a.two'), true);
        assert.equal(registry.execute('a.one'), true);
        assert.deepEqual(ran, ['two', 'one']);
        assert.deepEqual(registry.recent(), ['a.one', 'a.two']);
        registry.register({ id: 'a.palette', title: 'Palette', recordRecent: false, run: noop });
        registry.execute('a.palette');
        assert.deepEqual(registry.recent(), ['a.one', 'a.two']);
    });

    it('reports a throwing or rejecting command instead of propagating it', async () => {
        const errors: string[] = [];
        const registry = createCommandRegistry((id) => errors.push(id));
        registry.register({ id: 'a.sync', title: 'Sync', run: () => { throw new Error('boom'); } });
        registry.register({ id: 'a.async', title: 'Async', run: () => Promise.reject(new Error('boom')) });
        assert.equal(registry.execute('a.sync'), true);
        assert.equal(registry.execute('a.async'), true);
        await new Promise((resolve) => setImmediate(resolve));
        assert.deepEqual(errors, ['a.sync', 'a.async']);
    });

    it('unregisters, so a feature can remove its commands', () => {
        const registry = createCommandRegistry();
        const dispose = registry.register({ id: 'agents.newChat', title: 'New Chat', run: noop });
        dispose();
        assert.equal(registry.get('agents.newChat'), undefined);
        registry.register({ id: 'agents.newChat', title: 'New Chat', run: noop });
    });

    it('labels a command with its category', () => {
        assert.equal(commandLabel({ title: 'Save All', category: 'File' }), 'File: Save All');
        assert.equal(commandLabel({ title: 'Save All' }), 'Save All');
    });
});

describe('fuzzy matching', () => {
    it('matches characters in order, case-insensitively, ignoring spaces in the query', () => {
        assert.ok(fuzzyMatch('sv al', 'File: Save All'));
        assert.ok(fuzzyMatch('SAVE', 'File: Save All'));
        assert.equal(fuzzyMatch('fsa', 'File: Save All')?.positions.length, 3);
        assert.equal(fuzzyMatch('xyz', 'File: Save All'), null);
    });

    it('prefers word starts and runs of consecutive characters', () => {
        const path = fuzzyMatch('edgrp', 'src/renderer/editor/editorGroup.ts');
        assert.ok(path);
        // "Group" is matched at its word start (the capital G), not inside another word.
        assert.equal('src/renderer/editor/editorGroup.ts'[path.positions[2] ?? -1], 'G');
        const start = fuzzyMatch('term', 'Terminal: Create New Terminal');
        const middle = fuzzyMatch('term', 'View: Toggle Determination');
        assert.ok(start && middle && start.score > middle.score);
    });

    it('does not jump to a word start that would leave the rest of the query unmatched', () => {
        // The "s" of "Save" is a word start, but taking it leaves no "f" after it.
        assert.ok(fuzzyMatch('sf', 'users Save f'));
        assert.ok(fuzzyMatch('ab', 'xa Ab'));
    });

    it('splits a label into matched and unmatched runs', () => {
        assert.deepEqual(highlightRuns('Save', [0, 1]), [{ text: 'Sa', matched: true }, { text: 've', matched: false }]);
        assert.deepEqual(highlightRuns('ab', []), [{ text: 'ab', matched: false }]);
    });
});

describe('keybindings', () => {
    const key = (code: string, mods: Partial<KeyEventLike> = {}, keyText = ''): KeyEventLike => ({
        ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: keyText, code, ...mods,
    });

    it('maps CmdOrCtrl to Cmd on macOS and to Ctrl elsewhere', () => {
        assert.deepEqual(parseKeybinding('CmdOrCtrl+Shift+P', 'darwin'), { ctrl: false, meta: true, alt: false, shift: true, key: 'P' });
        assert.deepEqual(parseKeybinding('CmdOrCtrl+Shift+P', 'win32'), { ctrl: true, meta: false, alt: false, shift: true, key: 'P' });
        assert.equal(parseKeybinding('Ctrl++', 'linux').key, '+');
        assert.throws(() => parseKeybinding('Hyper+P', 'linux'), /Unknown modifier/);
    });

    it('matches by physical key, so Shift and keyboard layouts do not change the key', () => {
        const palette = parseKeybinding('CmdOrCtrl+Shift+P', 'linux');
        assert.ok(matchesKeybinding(key('KeyP', { ctrlKey: true, shiftKey: true }, 'P'), palette));
        assert.ok(!matchesKeybinding(key('KeyP', { ctrlKey: true }, 'p'), palette));
        assert.ok(matchesKeybinding(key('F1', {}, 'F1'), parseKeybinding('F1', 'linux')));
        assert.ok(matchesKeybinding(key('Backquote', { ctrlKey: true }, '`'), parseKeybinding('Ctrl+`', 'linux')));
        assert.ok(!matchesKeybinding(key('KeyE', { metaKey: true, shiftKey: true }), parseKeybinding('CmdOrCtrl+Shift+E', 'linux')));
        assert.ok(matchesKeybinding(key('KeyE', { metaKey: true, shiftKey: true }), parseKeybinding('CmdOrCtrl+Shift+E', 'darwin')));
    });

    it('writes keybindings the way each platform reads them', () => {
        assert.equal(formatKeybinding('CmdOrCtrl+Shift+P', 'linux'), 'Ctrl+Shift+P');
        assert.equal(formatKeybinding('CmdOrCtrl+Shift+P', 'darwin'), 'Shift+Cmd+P');
        assert.equal(formatKeybinding('CmdOrCtrl+Alt+S', 'win32'), 'Ctrl+Alt+S');
        assert.equal(formatKeybinding('F1', 'linux'), 'F1');
        assert.equal(formatKeybinding('Ctrl+PageDown', 'linux'), 'Ctrl+PageDown');
    });
});

describe('palette model', () => {
    const commands: CommandDefinition[] = [
        { id: 'file.save', category: 'File', title: 'Save', keybinding: 'CmdOrCtrl+S', run: noop },
        { id: 'file.saveAll', category: 'File', title: 'Save All', run: noop },
        { id: 'terminal.new', category: 'Terminal', title: 'Create New Terminal', run: noop },
        { id: 'codexr.closeScene', category: 'Code-XR', title: 'Close the XR Scene', run: noop },
    ];
    const context = (overrides: Partial<PaletteContext> = {}): PaletteContext => ({
        commands,
        isEnabled: (id) => id !== 'codexr.closeScene',
        recent: [],
        formatKey: (binding) => formatKeybinding(binding, 'linux'),
        lineCount: 200,
        ...overrides,
    });

    it('lists enabled commands only, recently used first, with their keys', () => {
        const view = paletteView('>', context({ recent: ['terminal.new'] }));
        assert.deepEqual(view.entries.map((entry) => entry.id), ['terminal.new', 'file.save', 'file.saveAll']);
        assert.equal(view.entries[0]?.group, 'recently used');
        assert.equal(view.entries[1]?.group, 'other commands');
        assert.equal(view.entries[1]?.keybinding, 'Ctrl+S');
    });

    it('filters and ranks by the fuzzy score, highlighting the label', () => {
        const view = paletteView('>sav al', context());
        assert.equal(view.entries[0]?.id, 'file.saveAll');
        assert.ok((view.entries[0]?.highlights.length ?? 0) > 0);
        assert.deepEqual(paletteView('>zzz', context()).entries, []);
        assert.equal(paletteView('>zzz', context()).empty, 'No matching commands');
        assert.deepEqual(paletteView('>', context()).action(paletteView('>', context()).entries[0]!), { kind: 'command', id: 'file.save' });
    });

    it('goes to a line, clamped to the file, with an optional column', () => {
        const view = paletteView(':120:4', context());
        assert.deepEqual(view.action(view.entries[0]!), { kind: 'line', line: 120, column: 4 });
        const clamped = paletteView(':9999', context());
        assert.deepEqual(clamped.action(clamped.entries[0]!), { kind: 'line', line: 200 });
        assert.equal(paletteView(':abc', context()).entries.length, 0);
        assert.match(paletteView(':5', context({ lineCount: null })).empty, /Open a file first/);
    });

    it('parses line positions', () => {
        assert.deepEqual(parseLinePosition('12'), { line: 12 });
        assert.deepEqual(parseLinePosition(' 12 , 3 '), { line: 12, column: 3 });
        assert.equal(parseLinePosition('0'), null);
        assert.equal(parseLinePosition('12:'), null);
    });

    it('shows the prefixes as hints when the field has none', () => {
        const view = paletteView('', context());
        assert.deepEqual(view.entries.map((entry) => entry.fill), ['>', ':']);
        assert.ok(view.entries.every((entry) => !entry.runnable));
    });
});

describe('workbench commands', () => {
    const targets = new Proxy({}, { get: () => () => true }) as WorkbenchCommandTargets;

    it('register without duplicates and cover every menu command', () => {
        const registry = createCommandRegistry();
        for (const command of workbenchCommands(targets)) {
            registry.register(command);
        }
        for (const id of IDE_COMMANDS) {
            assert.ok(registry.get(id), `menu command ${id} has no registry entry`);
        }
    });

    it('show the same accelerators the application menu registers', () => {
        const menu = readFileSync(new URL('../src/main/menu.ts', import.meta.url), 'utf8');
        const pairs = [...menu.matchAll(/accelerator: '([^']+)',[^{}]*?sendCommand\(win, '([^']+)'\)/g)]
            .map((match) => [match[2], match[1]] as const);
        assert.ok(pairs.length >= 9, 'the menu items were not found; did the menu format change?');
        assert.deepEqual(Object.fromEntries(pairs), MENU_KEYBINDINGS);
    });
});
