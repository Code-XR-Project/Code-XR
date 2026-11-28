import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowScreenShareRequest, MAX_SHARE_CHOICES, shareAudioFor, shareChoices } from '../src/main/analysis/sceneScreenShare.ts';

// COLLAB-IDE-1 (#366): the scene pane's Share button asks which screen or window.

test('screens come first, then windows; unnamed and duplicate sources are dropped; Cancel is last', () => {
    const choices = shareChoices([
        { id: 'window:1', name: 'Editor' },
        { id: 'screen:0', name: 'Entire screen' },
        { id: 'window:2', name: '' },
        { id: 'window:1', name: 'Editor' },
        { id: 'window:3', name: 'Browser' },
    ]);
    assert.deepEqual(choices.buttons, ['Screen 1: Entire screen', 'Editor', 'Browser', 'Cancel']);
    assert.deepEqual(choices.sources.map((source) => source.id), ['screen:0', 'window:1', 'window:3']);
    assert.equal(choices.cancelId, 3);
});

test('at most a dialog-sized list is offered', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({ id: `window:${index}`, name: `Window ${index}` }));
    const choices = shareChoices(many);
    assert.equal(choices.sources.length, MAX_SHARE_CHOICES);
    assert.equal(choices.buttons.length, MAX_SHARE_CHOICES + 1);
});

test('only the scene\'s own origin may capture, and system audio only on Windows', () => {
    assert.equal(allowScreenShareRequest('http://127.0.0.1:3000', 'http://127.0.0.1:3000/index.html'), true);
    assert.equal(allowScreenShareRequest('http://127.0.0.1:3000', 'http://127.0.0.1:4000/'), false);
    assert.equal(allowScreenShareRequest('http://127.0.0.1:3000', 'https://evil.example/'), false);
    assert.equal(allowScreenShareRequest(null, 'http://127.0.0.1:3000/'), false);
    assert.equal(allowScreenShareRequest('http://127.0.0.1:3000', 'not a url'), false);
    assert.equal(shareAudioFor('win32'), 'loopback');
    assert.equal(shareAudioFor('darwin'), undefined);
    assert.equal(shareAudioFor('linux'), undefined);
});
