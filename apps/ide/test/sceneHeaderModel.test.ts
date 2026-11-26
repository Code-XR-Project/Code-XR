import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analysedFilesLabel, analysisKindLabel, displayAddress, INITIAL_SHARE_VIEW, ipcErrorMessage, reduceShare, shareControls, type ShareAction, type ShareView } from '../src/renderer/sceneHeaderModel.ts';

const PUBLIC = 'https://calm-river-42.trycloudflare.com';

function run(...actions: ShareAction[]): ShareView {
    return actions.reduce(reduceShare, INITIAL_SHARE_VIEW);
}

describe('scene header labels', () => {
    it('names the analysis kind', () => {
        assert.equal(analysisKindLabel('xr-deep'), 'XR · deep');
    });

    it('shows a root URL as its origin', () => {
        assert.equal(displayAddress('http://127.0.0.1:3000/'), 'http://127.0.0.1:3000');
        assert.equal(displayAddress('http://localhost:3001'), 'http://localhost:3001');
        assert.equal(displayAddress('http://[::1]:3443/'), 'http://[::1]:3443');
    });

    it('keeps a path and shows anything unparseable as given', () => {
        assert.equal(displayAddress('http://127.0.0.1:3000/scene/index.html'), 'http://127.0.0.1:3000/scene/index.html');
        assert.equal(displayAddress('not a url'), 'not a url');
    });

    it('strips the IPC prefix from a rejected call', () => {
        assert.equal(ipcErrorMessage(new Error("Error invoking remote method 'codexr:analysis:share-scene': Error: This window shows no running analysis.")), 'This window shows no running analysis.');
        assert.equal(ipcErrorMessage('plain'), 'plain');
    });
});

describe('reduceShare / shareControls', () => {
    it('starts stopped with the share button', () => {
        const controls = shareControls(INITIAL_SHARE_VIEW);
        assert.equal(controls.shareVisible, true);
        assert.equal(controls.shareDisabled, false);
        assert.equal(controls.shareLabel, 'Share through Cloudflare');
        assert.equal(controls.stopVisible, false);
        assert.equal(controls.publicUrl, null);
        assert.equal(controls.error, null);
    });

    it('is busy while the tunnel starts, and ignores a second click', () => {
        const view = run({ type: 'share' });
        assert.deepEqual(view, { status: 'starting', busy: true });
        assert.equal(reduceShare(view, { type: 'share' }), view);
        const controls = shareControls(view);
        assert.equal(controls.shareDisabled, true);
        assert.equal(controls.shareLabel, 'Starting tunnel…');
    });

    it('shows the public URL and Stop sharing once shared', () => {
        const controls = shareControls(run({ type: 'share' }, { type: 'update', share: { status: 'shared', publicUrl: PUBLIC } }));
        assert.equal(controls.shareVisible, false);
        assert.equal(controls.stopVisible, true);
        assert.equal(controls.stopDisabled, false);
        assert.equal(controls.publicUrl, PUBLIC);
    });

    it('waits on Stop sharing, then goes back to stopped', () => {
        const stopping = run({ type: 'update', share: { status: 'shared', publicUrl: PUBLIC } }, { type: 'stop' });
        assert.equal(shareControls(stopping).stopDisabled, true);
        assert.equal(shareControls(stopping).publicUrl, PUBLIC);
        const stopped = reduceShare(stopping, { type: 'update', share: { status: 'stopped' } });
        assert.deepEqual(stopped, { status: 'stopped', publicUrl: undefined, error: undefined, busy: false });
    });

    it('shows a failure and lets the person try again', () => {
        const view = run({ type: 'share' }, { type: 'failed', message: 'cloudflared exited' });
        const controls = shareControls(view);
        assert.equal(controls.error, 'cloudflared exited');
        assert.equal(controls.shareVisible, true);
        assert.equal(controls.shareDisabled, false);
    });

    it('takes the state of a newly opened scene as it is', () => {
        const view = run({ type: 'share' }, { type: 'reset', share: { status: 'shared', publicUrl: PUBLIC } });
        assert.equal(view.busy, false);
        assert.equal(shareControls(view).publicUrl, PUBLIC);
    });

    it('never shows a shared row without an address', () => {
        assert.equal(shareControls(run({ type: 'update', share: { status: 'shared' } })).stopVisible, false);
    });
});

describe('analysedFilesLabel (#203)', () => {
    it('counts the files the analysis took, and says nothing while unknown', () => {
        assert.equal(analysedFilesLabel(870), '870 files');
        assert.equal(analysedFilesLabel(1), '1 file');
        assert.equal(analysedFilesLabel(0), '0 files');
        assert.equal(analysedFilesLabel(12345), '12,345 files');
        assert.equal(analysedFilesLabel(undefined), '');
        assert.equal(analysedFilesLabel(-1), '');
    });
});

