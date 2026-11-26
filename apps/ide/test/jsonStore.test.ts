import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonKeyValueStore } from '../src/main/core/jsonStore.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-store-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

describe('JsonKeyValueStore', () => {
    it('returns defaults for missing keys and persists updates', async () => {
        const file = path.join(base, 'a', 'state.json');
        const store = new JsonKeyValueStore(file);
        assert.equal(store.get('missing'), undefined);
        assert.equal(store.get('missing', 7), 7);
        await store.update('flag', true);
        await store.update('nested', { list: [1, 2] });
        assert.equal(store.get('flag'), true);
        const again = new JsonKeyValueStore(file);
        assert.deepEqual(again.get('nested'), { list: [1, 2] });
        assert.deepEqual([...again.keys()].sort(), ['flag', 'nested']);
    });

    it('removes a key set to undefined and keeps values from later mutation', async () => {
        const file = path.join(base, 'b.json');
        const store = new JsonKeyValueStore(file);
        const value = { n: 1 };
        await store.update('v', value);
        value.n = 2;
        assert.deepEqual(store.get('v'), { n: 1 });
        await store.update('v', undefined);
        assert.equal(new JsonKeyValueStore(file).get('v'), undefined);
    });

    it('starts empty from a broken or non-object file, and serialises concurrent writes', async () => {
        const broken = path.join(base, 'broken.json');
        fs.writeFileSync(broken, '{oops');
        assert.deepEqual(new JsonKeyValueStore(broken).keys(), []);
        fs.writeFileSync(broken, '[1,2]');
        const store = new JsonKeyValueStore(broken);
        assert.deepEqual(store.keys(), []);
        await Promise.all(Array.from({ length: 20 }, (_, i) => store.update(`k${i}`, i)));
        assert.equal(new JsonKeyValueStore(broken).keys().length, 20);
        assert.deepEqual(fs.readdirSync(base).filter((name) => name.endsWith('.tmp')), []);
    });
});
