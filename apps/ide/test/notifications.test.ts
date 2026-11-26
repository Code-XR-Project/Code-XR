import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { clampPercent } from '../src/renderer/progressPercent.ts';

describe('clampPercent', () => {
    it('keeps a reported percentage between 0 and 100', () => {
        assert.equal(clampPercent(42), 42);
        assert.equal(clampPercent(-5), 0);
        assert.equal(clampPercent(140), 100);
    });

    it('treats a missing or invalid value as unknown (indeterminate bar)', () => {
        assert.equal(clampPercent(undefined), undefined);
        assert.equal(clampPercent(Number.NaN), undefined);
        assert.equal(clampPercent(Number.POSITIVE_INFINITY), undefined);
    });
});
