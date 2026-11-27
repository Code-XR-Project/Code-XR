import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { channelForScope, isOutputChannel, MAX_LINE_LENGTH, OUTPUT_CHANNELS, OutputBuffer, outputLines, plainCoreText, redactSecrets } from '../src/shared/output.ts';

describe('output channels (#174)', () => {
    it('lists five channels and recognises them', () => {
        assert.deepEqual(OUTPUT_CHANNELS.map((channel) => channel.id), ['ide', 'core', 'python', 'servers', 'lsp', 'debug']);
        assert.equal(isOutputChannel('python'), true);
        assert.equal(isOutputChannel('terminal'), false);
        assert.equal(isOutputChannel(3), false);
    });

    it('routes a core scope to its area', () => {
        assert.equal(channelForScope('PYTHON_ENV'), 'python');
        assert.equal(channelForScope('VENV_MANAGER'), 'python');
        assert.equal(channelForScope('EXECUTE_PYTHON'), 'python');
        assert.equal(channelForScope('LIVE_PANEL_PARSER'), 'core');
        assert.equal(channelForScope('IMPORT_REPORT'), 'core');
        assert.equal(channelForScope('COLLABORATION_ROOM_SERVER'), 'servers');
        assert.equal(channelForScope('SERVER'), 'servers');
        assert.equal(channelForScope('SSE'), 'servers');
        assert.equal(channelForScope('CLOUDFLARED'), 'servers');
        assert.equal(channelForScope('REMOTE_ACCESS'), 'servers');
        assert.equal(channelForScope('ANALYSIS'), 'core');
        assert.equal(channelForScope('XR_DEEP'), 'core');
    });
});

describe('secret redaction (#174)', () => {
    const cases: Array<[string, string]> = [
        ['cloudflared tunnel run --token abcDEF123456', 'cloudflared tunnel run --token <redacted>'],
        ['--password=hunter2 next', '--password=<redacted> next'],
        ['api_key=abc123def; rest', 'api_key=<redacted>; rest'],
        ['{"token": "abc.def.ghi"}', '{"token": "<redacted>"}'],
        ['Authorization: Bearer abcdefghijklmnop', 'Authorization: Bearer <redacted>'],
        ['key sk-ant-api03-abcdefghijklmnopqrstuv end', 'key <redacted> end'],
        ['push with ghp_abcdefghijklmnopqrstuvwxyz0123', 'push with <redacted>'],
        ['AWS AKIAABCDEFGHIJKLMNOP done', 'AWS <redacted> done'],
        ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig', 'jwt <redacted>'],
        ['fetch https://user:s3cret@example.com/repo', 'fetch https://user:<redacted>@example.com/repo'],
    ];
    for (const [input, expected] of cases) {
        it(`redacts ${input.slice(0, 24)}`, () => {
            assert.equal(redactSecrets(input), expected);
        });
    }

    it('leaves ordinary lines alone', () => {
        const line = '[2026-11-26T10:00:00Z] [INFO] [SERVER] Server running on port 8443 (https://localhost:8443/)';
        assert.equal(redactSecrets(line), line);
        assert.equal(redactSecrets('Collecting lizard==1.17.10'), 'Collecting lizard==1.17.10');
    });
});

describe('output lines and buffer (#174)', () => {
    it('splits any line ending, redacts and cuts long lines', () => {
        assert.deepEqual(outputLines('a\r\nb\rc\n'), ['a', 'b', 'c']);
        assert.deepEqual(outputLines('--token abc'), ['--token <redacted>']);
        const [long] = outputLines('x'.repeat(MAX_LINE_LENGTH + 10));
        assert.ok(long?.startsWith('x'.repeat(MAX_LINE_LENGTH)));
        assert.ok(long?.endsWith('(10 more characters)'));
    });

    it('keeps at most its limit, dropping the oldest', () => {
        const buffer = new OutputBuffer(3);
        buffer.append(['1', '2']);
        buffer.append(['3', '4', '5']);
        assert.deepEqual(buffer.snapshot(), ['3', '4', '5']);
        assert.equal(buffer.size, 3);
        buffer.clear();
        assert.equal(buffer.size, 0);
    });
});

describe('core messages in the IDE (#173)', () => {
    it('drops the VS Code icon syntax and keeps the words', () => {
        assert.equal(plainCoreText('$(check) CodeXR re-analysis updated 1 file(s)'), 'CodeXR re-analysis updated 1 file(s)');
        assert.equal(plainCoreText('$(sync~spin) Analysing $(file-code) a.py'), 'Analysing a.py');
        assert.equal(plainCoreText('Costs $5 (one run)'), 'Costs $5 (one run)');
    });
});
