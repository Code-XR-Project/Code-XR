import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isQuickTunnelUrl, sameShareState, SerialQueue, startShareOnce, STOPPED, toSceneShareState } from '../src/main/analysis/sceneShare.ts';

describe('isQuickTunnelUrl', () => {
    it('accepts a Cloudflare quick tunnel', () => {
        assert.equal(isQuickTunnelUrl('https://calm-river-42.trycloudflare.com'), true);
        assert.equal(isQuickTunnelUrl('https://calm-river-42.trycloudflare.com/join?invite=abc'), true);
    });

    for (const value of [
        'http://calm-river-42.trycloudflare.com',
        'https://trycloudflare.com',
        'https://a.b.trycloudflare.com',
        'https://calm.trycloudflare.com.evil.test',
        'https://calm.trycloudflare.com:8443',
        'https://user:pw@calm.trycloudflare.com',
        'javascript:alert(1)',
        'not a url',
        42,
        null,
        `https://${'a'.repeat(2100)}.trycloudflare.com`,
    ]) {
        it(`refuses ${String(value).slice(0, 60)}`, () => {
            assert.equal(isQuickTunnelUrl(value), false);
        });
    }
});

describe('toSceneShareState', () => {
    it('reads nothing as stopped', () => {
        assert.deepEqual(toSceneShareState(undefined), STOPPED);
        assert.deepEqual(toSceneShareState({ status: 'weird' }), STOPPED);
    });

    it('passes a shared state with its public origin only', () => {
        assert.deepEqual(
            toSceneShareState({ status: 'shared', publicUrl: 'https://calm-river-42.trycloudflare.com/', invitationUrl: 'https://calm-river-42.trycloudflare.com/join?invite=x', pendingRequests: 1 }),
            { status: 'shared', publicUrl: 'https://calm-river-42.trycloudflare.com' },
        );
    });

    it('drops a shared state whose URL is not a quick tunnel', () => {
        assert.deepEqual(toSceneShareState({ status: 'shared', publicUrl: 'https://example.com' }), STOPPED);
        assert.deepEqual(toSceneShareState({ status: 'shared' }), STOPPED);
    });

    it('keeps a bounded error message', () => {
        assert.deepEqual(toSceneShareState({ status: 'error', error: 'cloudflared exited' }), { status: 'error', error: 'cloudflared exited' });
        assert.equal(toSceneShareState({ status: 'error', error: 'x'.repeat(2000) }).error?.length, 500);
        assert.equal(toSceneShareState({ status: 'error' }).error, 'The remote connection failed.');
    });

    it('passes starting and stopped through', () => {
        assert.deepEqual(toSceneShareState({ status: 'starting', pendingRequests: 0 }), { status: 'starting' });
        assert.deepEqual(toSceneShareState({ status: 'stopped', pendingRequests: 0 }), { status: 'stopped' });
    });
});

describe('sameShareState', () => {
    it('compares the visible fields', () => {
        assert.equal(sameShareState({ status: 'stopped' }, STOPPED), true);
        assert.equal(sameShareState({ status: 'shared', publicUrl: 'https://a.trycloudflare.com' }, { status: 'shared', publicUrl: 'https://b.trycloudflare.com' }), false);
    });
});

describe('SerialQueue', () => {
    it('runs tasks one after another, even after a failure', async () => {
        const queue = new SerialQueue();
        const events: string[] = [];
        let release: () => void = () => undefined;
        const first = queue.run(async () => {
            events.push('first:start');
            await new Promise<void>((resolve) => { release = resolve; });
            events.push('first:end');
            throw new Error('boom');
        });
        const second = queue.run(async () => {
            events.push('second');
            return 2;
        });
        await Promise.resolve();
        release();
        await assert.rejects(first, /boom/);
        assert.equal(await second, 2);
        assert.deepEqual(events, ['first:start', 'first:end', 'second']);
    });
});

describe('startShareOnce', () => {
    it('enables remote access only while the share starts', async () => {
        const calls: string[] = [];
        const state = await startShareOnce({
            setEnabled: async (enabled) => { calls.push(`enabled:${enabled}`); },
            start: async () => {
                calls.push('start');
                return { status: 'shared', publicUrl: 'https://calm-river-42.trycloudflare.com', pendingRequests: 0 };
            },
        });
        assert.deepEqual(calls, ['enabled:true', 'start', 'enabled:false']);
        assert.deepEqual(state, { status: 'shared', publicUrl: 'https://calm-river-42.trycloudflare.com' });
    });

    it('turns it off again when the share fails', async () => {
        const calls: string[] = [];
        await assert.rejects(startShareOnce({
            setEnabled: async (enabled) => { calls.push(`enabled:${enabled}`); },
            start: async () => { throw new Error('cloudflared exited before publishing the link.'); },
        }), /cloudflared exited/);
        assert.deepEqual(calls, ['enabled:true', 'enabled:false']);
    });

    it('reads a declined download (stopped) as stopped', async () => {
        const state = await startShareOnce({ setEnabled: async () => undefined, start: async () => ({ status: 'stopped', pendingRequests: 0 }) });
        assert.deepEqual(state, STOPPED);
    });
});
