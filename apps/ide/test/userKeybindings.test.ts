import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    canonicalKeybinding, cleanUserKeybindings, formatKeybindingsFile, isChord, isValidKeybinding, keysChanged, menuAccelerator,
    MENU_KEYBINDINGS, parseKeybindingsFile, resolveKeybindings, withCommandKey, withCommandReset, withoutCommandRules, type UserKeybinding,
} from '../src/shared/keybindings.ts';
import { memoryStorage } from '../src/main/settings/settingsService.ts';
import { KeybindingsService } from '../src/main/settings/keybindingsService.ts';
import { createCommandRegistry } from '../src/renderer/commands/commandRegistry.ts';
import { formatKeybinding, matchesKeybinding, parseKeybinding, strokeFromEvent, type KeyEventLike } from '../src/renderer/commands/keybindings.ts';
import { conflictsOf, createKeyRecorder, keybindingRows, menuAccelerators } from '../src/renderer/settings/keybindingsModel.ts';
import { workbenchCommands, type WorkbenchCommandTargets } from '../src/renderer/commands/workbenchCommands.ts';

function key(code: string, keyName: string, mods: Partial<KeyEventLike> = {}): KeyEventLike {
    return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, key: keyName, code, ...mods };
}

describe('keybinding validation (#18, part 3)', () => {
    it('compares keys by what they press on the platform', () => {
        assert.equal(canonicalKeybinding('CmdOrCtrl+Shift+P', 'linux'), 'ctrl+shift+P');
        assert.equal(canonicalKeybinding('shift+ctrl+p', 'linux'), 'ctrl+shift+P');
        assert.equal(canonicalKeybinding('CmdOrCtrl+Shift+P', 'darwin'), 'cmd+shift+P');
        assert.equal(canonicalKeybinding('Command+Option+S', 'darwin'), 'cmd+alt+S');
        assert.equal(canonicalKeybinding('Ctrl+K  Z', 'win32'), 'ctrl+K Z');
        assert.equal(canonicalKeybinding('Ctrl+Esc', 'linux'), canonicalKeybinding('Ctrl+Escape', 'linux'));
        assert.equal(canonicalKeybinding('Ctrl++', 'linux'), 'ctrl++');
    });

    it('refuses what an accelerator cannot say', () => {
        for (const bad of ['', 'Ctrl+', 'Hyper+K', 'Ctrl+Foo', 'Ctrl+K Z X', 'F25', 'Ctrl+é']) {
            assert.equal(isValidKeybinding(bad), false, bad);
        }
        for (const good of ['F1', 'Ctrl+`', 'CmdOrCtrl+K Enter', 'Alt+Up', 'Ctrl+PageDown', 'Shift+Delete']) {
            assert.equal(isValidKeybinding(good), true, good);
        }
        assert.equal(isChord('Ctrl+K Z'), true);
        assert.equal(isChord('Ctrl+K'), false);
    });

    it('reads a file with comments and keeps the good rules', () => {
        const text = `[
            // mine
            { "key": "ctrl+shift+s", "command": "file.saveAll" },
            { "command": "-view.toggleZenMode" },
            { "key": "Hyper+X", "command": "file.save" },
            { "key": "F2", "command": "not a command" },
            { "command": "file.save" },
            "nope",
        ]`;
        const { entries, errors } = parseKeybindingsFile(text);
        assert.deepEqual(entries, [
            { key: 'ctrl+shift+s', command: 'file.saveAll' },
            { command: '-view.toggleZenMode' },
        ]);
        assert.equal(errors.length, 4);
        assert.deepEqual(parseKeybindingsFile(null), { entries: [], errors: [] });
        assert.match(parseKeybindingsFile('{ nope').errors[0] ?? '', /not valid JSON/);
        assert.match(cleanUserKeybindings({}).errors[0] ?? '', /array/);
    });

    it('writes the file back in the same shape', () => {
        const entries: UserKeybinding[] = [{ key: 'F2', command: 'file.save' }, { command: '-file.saveAll' }];
        assert.deepEqual(parseKeybindingsFile(formatKeybindingsFile(entries)).entries, entries);
    });
});

describe('resolving keybindings (#18, part 3)', () => {
    const defaults = new Map<string, readonly string[]>([
        ['file.save', ['CmdOrCtrl+S']],
        ['file.saveAll', ['CmdOrCtrl+Alt+S']],
        ['workbench.commandPalette', ['CmdOrCtrl+Shift+P', 'F1']],
        ['view.toggleZenMode', ['CmdOrCtrl+K Z']],
    ]);

    it('removes one built-in key, or all of them', () => {
        const result = resolveKeybindings(defaults, [{ key: 'F1', command: '-workbench.commandPalette' }, { command: '-view.toggleZenMode' }], 'linux');
        assert.deepEqual(result.get('workbench.commandPalette'), ['CmdOrCtrl+Shift+P']);
        assert.deepEqual(result.get('view.toggleZenMode'), []);
        assert.deepEqual(result.get('file.save'), ['CmdOrCtrl+S']);
    });

    it('takes an added key away from the command that had it', () => {
        const result = resolveKeybindings(defaults, [{ key: 'ctrl+s', command: 'file.saveAll' }], 'linux');
        assert.deepEqual(result.get('file.save'), []);
        assert.deepEqual(result.get('file.saveAll'), ['CmdOrCtrl+Alt+S', 'ctrl+s']);
        // On macOS CmdOrCtrl is Cmd, so Ctrl+S is another key and Save keeps its own.
        assert.deepEqual(resolveKeybindings(defaults, [{ key: 'ctrl+s', command: 'file.saveAll' }], 'darwin').get('file.save'), ['CmdOrCtrl+S']);
    });

    it('lets a later rule win and keeps rules for commands not registered yet', () => {
        const result = resolveKeybindings(defaults, [
            { key: 'F5', command: 'file.save' },
            { key: 'F5', command: 'file.saveAll' },
            { key: 'F6', command: 'agents.newChat' },
        ], 'linux');
        assert.deepEqual(result.get('file.save'), ['CmdOrCtrl+S']);
        assert.deepEqual(result.get('file.saveAll'), ['CmdOrCtrl+Alt+S', 'F5']);
        assert.deepEqual(result.get('agents.newChat'), ['F6']);
    });

    it('gives the menu the first single-stroke key', () => {
        assert.equal(menuAccelerator(['CmdOrCtrl+K S', 'F7']), 'F7');
        assert.equal(menuAccelerator(['CmdOrCtrl+K S']), undefined);
        assert.equal(menuAccelerator([]), undefined);
    });

    it('edits the rules of one command', () => {
        const entries: UserKeybinding[] = [{ key: 'F2', command: 'file.save' }, { key: 'F3', command: 'file.saveAll' }];
        assert.deepEqual(withCommandKey(entries, 'file.save', 'F9'), [
            { key: 'F3', command: 'file.saveAll' }, { command: '-file.save' }, { key: 'F9', command: 'file.save' },
        ]);
        assert.deepEqual(withCommandKey(entries, 'file.save', null), [{ key: 'F3', command: 'file.saveAll' }, { command: '-file.save' }]);
        assert.deepEqual(withoutCommandRules(withCommandKey(entries, 'file.save', 'F9'), 'file.save'), [{ key: 'F3', command: 'file.saveAll' }]);
        // Resetting Save takes Ctrl+S back from the rule that gave it to Save All.
        const stolen: UserKeybinding[] = [{ key: 'ctrl+s', command: 'file.saveAll' }, { key: 'F3', command: 'file.saveAll' }, { command: '-file.save' }];
        assert.deepEqual(withCommandReset(stolen, 'file.save', ['CmdOrCtrl+S'], 'linux'), [{ key: 'F3', command: 'file.saveAll' }]);
        assert.equal(withCommandReset(stolen, 'file.save', ['CmdOrCtrl+S'], 'darwin').length, 2);
        assert.equal(keysChanged(['A'], ['A']), false);
        assert.equal(keysChanged(['A'], ['B']), true);
    });
});

describe('the registry with user keybindings (#18, part 3)', () => {
    const targets = new Proxy({}, { get: () => () => true }) as WorkbenchCommandTargets;
    function registry(platform = 'linux'): ReturnType<typeof createCommandRegistry> {
        const created = createCommandRegistry(undefined, platform);
        for (const command of workbenchCommands(targets)) {
            created.register(command);
        }
        return created;
    }

    it('applies the rules on top of the built-in keys', () => {
        const commands = registry();
        assert.deepEqual(commands.keybindings('workbench.commandPalette'), ['CmdOrCtrl+Shift+P', 'F1']);
        commands.setUserKeybindings([{ key: 'CmdOrCtrl+B', command: 'editor.closeAll' }]);
        assert.deepEqual(commands.keybindings('view.toggleSideBar'), []);
        assert.deepEqual(commands.keybindings('editor.closeAll'), ['CmdOrCtrl+K W', 'CmdOrCtrl+B']);
        assert.deepEqual(commands.defaultKeybindings('view.toggleSideBar'), ['CmdOrCtrl+B']);
        assert.deepEqual(commands.keybindings('no.such'), []);
    });

    it('tells the menu which keys it owns, or none while recording', () => {
        const commands = registry();
        commands.setUserKeybindings([
            { command: '-file.save' },
            { key: 'CmdOrCtrl+K P', command: 'workbench.commandPalette' },
            { key: 'F8', command: 'terminal.toggle' },
        ]);
        const menu = menuAccelerators(commands);
        assert.deepEqual(Object.keys(menu).sort(), Object.keys(MENU_KEYBINDINGS).sort());
        assert.equal(menu['file.save'], null);
        assert.equal(menu['workbench.commandPalette'], 'CmdOrCtrl+Shift+P');
        assert.equal(menu['terminal.toggle'], 'Ctrl+`');
        assert.equal(menu['file.saveAll'], 'CmdOrCtrl+Alt+S');
        assert.ok(Object.values(menuAccelerators(commands, true)).every((value) => value === null));
    });

    it('lists rows by label, filtered by name or key, and finds conflicts', () => {
        const commands = registry();
        const format = (binding: string): string => formatKeybinding(binding, 'linux');
        const rows = keybindingRows(commands, 'ctrl+s', format);
        assert.ok(rows.some((row) => row.id === 'file.save'));
        assert.ok(rows.every((row, index) => index === 0 || rows[index - 1]!.label.localeCompare(row.label) <= 0));
        assert.deepEqual(keybindingRows(commands, 'zen', format).map((row) => row.labels), [['Ctrl+K Z']]);
        commands.setUserKeybindings([{ command: '-view.toggleZenMode' }]);
        const zen = keybindingRows(commands, 'zen mode', format)[0];
        assert.equal(zen?.modified, true);
        assert.deepEqual(zen?.keys, []);
        assert.deepEqual(conflictsOf(commands, 'file.saveAll', 'ctrl+s', 'linux').map((command) => command.id), ['file.save']);
        assert.deepEqual(conflictsOf(commands, 'file.save', 'ctrl+s', 'linux'), []);
    });
});

describe('recording keys (#18, part 3)', () => {
    it('turns a key press into a portable accelerator', () => {
        assert.equal(strokeFromEvent(key('KeyK', 'k', { ctrlKey: true, shiftKey: true }), 'linux'), 'CmdOrCtrl+Shift+K');
        assert.equal(strokeFromEvent(key('KeyK', 'k', { metaKey: true }), 'darwin'), 'CmdOrCtrl+K');
        assert.equal(strokeFromEvent(key('KeyK', 'k', { ctrlKey: true }), 'darwin'), 'Ctrl+K');
        assert.equal(strokeFromEvent(key('ArrowUp', 'ArrowUp', { altKey: true }), 'win32'), 'Alt+Up');
        assert.equal(strokeFromEvent(key('F5', 'F5'), 'linux'), 'F5');
        assert.equal(strokeFromEvent(key('Backquote', '`', { ctrlKey: true }), 'linux'), 'CmdOrCtrl+`');
        assert.equal(strokeFromEvent(key('ShiftLeft', 'Shift', { shiftKey: true }), 'linux'), null);
        assert.equal(strokeFromEvent(key('IntlBackslash', '<'), 'linux'), '<');
        assert.equal(strokeFromEvent(key('KeyA', 'ä', { altKey: true }), 'linux'), 'Alt+A');
    });

    it('recorded keys match the presses that made them', () => {
        for (const [event, platform] of [
            [key('ArrowUp', 'ArrowUp', { altKey: true }), 'linux'],
            [key('Space', ' ', { ctrlKey: true }), 'linux'],
            [key('Delete', 'Delete', { shiftKey: true }), 'win32'],
            [key('KeyP', 'p', { metaKey: true, shiftKey: true }), 'darwin'],
        ] as const) {
            const stroke = strokeFromEvent(event, platform);
            assert.ok(stroke && isValidKeybinding(stroke), String(stroke));
            assert.equal(matchesKeybinding(event, parseKeybinding(stroke, platform)), true, stroke);
        }
        assert.equal(parseKeybinding('Ctrl+Esc', 'linux').key, 'ESCAPE');
    });

    it('keeps up to two strokes and starts over on a third', () => {
        const recorder = createKeyRecorder();
        assert.equal(recorder.value(), null);
        recorder.press('CmdOrCtrl+K');
        recorder.press('Z');
        assert.equal(recorder.value(), 'CmdOrCtrl+K Z');
        recorder.press('F2');
        assert.equal(recorder.value(), 'F2');
        recorder.clear();
        assert.equal(recorder.value(), null);
    });
});

describe('KeybindingsService (#18, part 3)', () => {
    it('stores valid rules and refuses a malformed change whole', async () => {
        const storage = memoryStorage();
        const service = new KeybindingsService(storage, '/home/me/.config/keybindings.json');
        assert.deepEqual(await service.snapshot(), { entries: [], errors: [], file: '/home/me/.config/keybindings.json' });
        await service.update([{ key: 'F2', command: 'file.save' }]);
        assert.deepEqual((await service.snapshot()).entries, [{ key: 'F2', command: 'file.save' }]);
        await assert.rejects(service.update([{ key: 'F3', command: 'file.saveAll' }, { key: 'Hyper+X', command: 'file.save' }]), /valid "key"/);
        assert.deepEqual((await service.snapshot()).entries, [{ key: 'F2', command: 'file.save' }]);
        await storage.write('[{ "key": "Nope+X", "command": "file.save" }]');
        assert.equal((await service.snapshot()).errors.length, 1);
    });
});
