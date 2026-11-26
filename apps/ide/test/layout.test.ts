import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
    ACTIVITY_BAR_WIDTH, clampPanel, clampScene, clampSideBar, DEFAULT_LAYOUT, LIMITS, parseLayout, serializeLayout, STATUS_BAR_HEIGHT,
} from '../src/renderer/layout/layoutModel.ts';
import { CHORD_TIMEOUT_MS, createKeyDispatcher, formatKeybinding, parseChord, type StrokeBinding } from '../src/renderer/commands/keybindings.ts';

const wide = { width: 1600, height: 1000 };

describe('layout limits (#169)', () => {
    it('keeps the side bar between its minimum and half the window', () => {
        assert.equal(clampSideBar(50, wide), LIMITS.sideBarMin);
        assert.equal(clampSideBar(300, wide), 300);
        assert.equal(clampSideBar(5000, wide), 800);
    });

    it('keeps room for the editor row and the status bar above the panel', () => {
        assert.equal(clampPanel(10, wide), LIMITS.panelMin);
        assert.equal(clampPanel(400, wide), 400);
        assert.equal(clampPanel(5000, wide), 800);
        const short = { width: 800, height: 300 };
        assert.equal(clampPanel(5000, short), short.height - STATUS_BAR_HEIGHT - LIMITS.editorMinHeight);
    });

    it('never squeezes the panel under its minimum, even in a tiny window', () => {
        assert.equal(clampPanel(5000, { width: 400, height: 150 }), LIMITS.panelMin);
    });

    it('gives the scene 45% of the window until a width is chosen, and leaves the editor its minimum', () => {
        assert.equal(clampScene(null, wide, 260), 720);
        assert.equal(clampScene(100, wide, 260), LIMITS.sceneMin);
        assert.equal(clampScene(5000, wide, 260), wide.width - ACTIVITY_BAR_WIDTH - 260 - LIMITS.editorMin);
        // With the side bar hidden the scene may take its room.
        assert.equal(clampScene(5000, wide, 0), wide.width - ACTIVITY_BAR_WIDTH - LIMITS.editorMin);
    });
});

describe('saved layout (#169)', () => {
    it('round-trips', () => {
        const layout = { sideBarWidth: 320, sideBarVisible: false, panelHeight: 400, sceneWidth: 700 };
        assert.deepEqual(parseLayout(serializeLayout(layout)), layout);
    });

    it('falls back to the default for nothing, broken JSON or another version', () => {
        assert.deepEqual(parseLayout(null), DEFAULT_LAYOUT);
        assert.deepEqual(parseLayout('{nope'), DEFAULT_LAYOUT);
        assert.deepEqual(parseLayout('[]'), DEFAULT_LAYOUT);
        assert.deepEqual(parseLayout(JSON.stringify({ version: 99, sideBarWidth: 300 })), DEFAULT_LAYOUT);
    });

    it('drops damaged fields one by one', () => {
        const parsed = parseLayout(JSON.stringify({ version: 1, sideBarWidth: -4, sideBarVisible: 'yes', panelHeight: 333.6, sceneWidth: 'wide' }));
        assert.deepEqual(parsed, { ...DEFAULT_LAYOUT, panelHeight: 334 });
    });
});

describe('chords (#169)', () => {
    it('parses and formats two strokes', () => {
        assert.equal(parseChord('CmdOrCtrl+K Z', 'linux').length, 2);
        assert.equal(formatKeybinding('CmdOrCtrl+K Z', 'linux'), 'Ctrl+K Z');
        assert.equal(formatKeybinding('CmdOrCtrl+K Z', 'darwin'), 'Cmd+K Z');
        assert.throws(() => parseChord('Ctrl+K Ctrl+K Z', 'linux'));
    });

    function harness(canStartChord = true) {
        let clock = 0;
        const dispatcher = createKeyDispatcher(() => clock);
        const bindings: StrokeBinding[] = [
            { id: 'view.toggleZenMode', strokes: parseChord('CmdOrCtrl+K Z', 'linux') },
            { id: 'view.other', strokes: parseChord('Ctrl+Shift+Z', 'linux') },
        ];
        const press = (key: string, code: string, mods: { ctrl?: boolean; shift?: boolean } = {}) =>
            dispatcher.dispatch({ key, code, ctrlKey: !!mods.ctrl, metaKey: false, altKey: false, shiftKey: !!mods.shift }, bindings, canStartChord);
        return { press, tick: (ms: number) => { clock += ms; } };
    }

    it('runs on the second stroke and lets the first one through', () => {
        const { press } = harness();
        assert.equal(press('k', 'KeyK', { ctrl: true }), null);
        assert.equal(press('Control', 'ControlLeft', { ctrl: true }), null);
        assert.deepEqual(press('z', 'KeyZ'), { kind: 'chord', id: 'view.toggleZenMode' });
        assert.equal(press('z', 'KeyZ'), null);
    });

    it('drops the chord on another key, after the timeout, or where it may not start', () => {
        const other = harness();
        other.press('k', 'KeyK', { ctrl: true });
        assert.equal(other.press('x', 'KeyX'), null);
        assert.equal(other.press('z', 'KeyZ'), null);
        const late = harness();
        late.press('k', 'KeyK', { ctrl: true });
        late.tick(CHORD_TIMEOUT_MS + 1);
        assert.equal(late.press('z', 'KeyZ'), null);
        const terminal = harness(false);
        terminal.press('k', 'KeyK', { ctrl: true });
        assert.equal(terminal.press('z', 'KeyZ'), null);
    });

    it('still runs single-stroke keys', () => {
        const { press } = harness();
        assert.deepEqual(press('Z', 'KeyZ', { ctrl: true, shift: true }), { kind: 'single', id: 'view.other' });
    });
});
