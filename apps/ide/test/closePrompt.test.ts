import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { closePrompt } from '../src/main/closePrompt.ts';

describe('close prompt', () => {
    it('names how many files are unsaved', () => {
        assert.match(closePrompt(1).options.message, /changes to 1 file before/);
        assert.match(closePrompt(3).options.message, /changes to 3 files before/);
    });

    it('maps every button to a choice, saving by default and cancelling on Escape', () => {
        const { options, choices } = closePrompt(2);
        assert.equal(options.buttons.length, choices.length);
        assert.equal(choices[options.defaultId], 'save');
        assert.equal(choices[options.cancelId], 'cancel');
        assert.deepEqual([...choices].sort(), ['cancel', 'discard', 'save']);
    });
});
