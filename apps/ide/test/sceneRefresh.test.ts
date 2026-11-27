import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { followRefreshes, refreshState, waitUntilSettled, type RefreshPort, type RefreshView } from '../src/main/analysis/sceneRefresh.ts';

/** AF8/AF9: reading the core's refresh coordinator for an open scene. */

function view(overrides: Partial<RefreshView> = {}): RefreshView {
    return { mode: 'single', status: 'ready', sourceRevision: 0, appliedRevision: { single: 0 }, modeRevision: { single: 0 }, ...overrides };
}

/** A fake session: `set` changes the view and notifies, like the coordinator's emitState. */
function fakePort(initial: RefreshView): RefreshPort & { set(next: RefreshView): void; listeners(): number } {
    let current = initial;
    const listeners = new Set<() => void>();
    return {
        view: () => current,
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        set(next) {
            current = next;
            for (const listener of [...listeners]) {
                listener();
            }
        },
        listeners: () => listeners.size,
    };
}

describe('scene refresh state', () => {
    it('is settled once the classic view applied every source revision', () => {
        assert.equal(refreshState(view()), 'settled');
        assert.equal(refreshState(view({ sourceRevision: 2, appliedRevision: { single: 1 }, status: 'updating' })), 'pending');
        assert.equal(refreshState(view({ sourceRevision: 2, appliedRevision: { single: 2 }, status: 'updating' })), 'pending');
        assert.equal(refreshState(view({ sourceRevision: 2, appliedRevision: { single: 2 } })), 'settled');
        assert.equal(refreshState(view({ sourceRevision: 2, appliedRevision: { single: 1 }, status: 'error' })), 'settled');
    });

    it('is paused while the scene shows another mode', () => {
        assert.equal(refreshState(view({ mode: 'dependency-graph', sourceRevision: 3 })), 'paused');
        assert.equal(refreshState(view({ mode: 'selection' })), 'paused');
    });

    it('waits for a pending refresh, then stops listening', async () => {
        const port = fakePort(view({ sourceRevision: 1, status: 'updating' }));
        const settled = waitUntilSettled(port, 5_000);
        assert.equal(port.listeners(), 1);
        port.set(view({ sourceRevision: 2, appliedRevision: { single: 1 }, status: 'updating' }));
        port.set(view({ sourceRevision: 2, appliedRevision: { single: 2 }, modeRevision: { single: 2 } }));
        assert.equal(await settled, 'settled');
        assert.equal(port.listeners(), 0);
    });

    it('answers at once when nothing is pending, and times out otherwise', async () => {
        assert.equal(await waitUntilSettled(fakePort(view()), 5_000), 'settled');
        const stuck = fakePort(view({ sourceRevision: 1, status: 'updating' }));
        assert.equal(await waitUntilSettled(stuck, 20), 'timeout');
        assert.equal(stuck.listeners(), 0);
    });

    it('reports each finished refresh once', () => {
        const port = fakePort(view({ modeRevision: { single: 3 } }));
        const seen: number[] = [];
        const stop = followRefreshes(port, (revision) => seen.push(revision));
        port.set(view({ modeRevision: { single: 3 }, status: 'updating', sourceRevision: 1 }));
        port.set(view({ modeRevision: { single: 4 }, sourceRevision: 1, appliedRevision: { single: 1 } }));
        port.set(view({ modeRevision: { single: 4 }, mode: 'dependency-graph' }));
        port.set(view({ modeRevision: { single: 6 } }));
        stop();
        port.set(view({ modeRevision: { single: 7 } }));
        assert.deepEqual(seen, [4, 6]);
    });
});
