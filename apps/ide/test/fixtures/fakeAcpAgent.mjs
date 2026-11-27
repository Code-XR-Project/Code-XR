// A minimal ACP agent over stdio for agentSessions.test.ts: it answers
// initialize, session/new and session/prompt (echoing the prompt's text as a
// message chunk), so the test exercises the real spawn + ndJsonStream path.
import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream } from '@agentclientprotocol/sdk';

let client = null;
const app = agent({ name: 'fixture' })
    .onConnect((connection) => {
        client = connection.client;
    })
    .onRequest(methods.agent.initialize, () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }))
    .onRequest(methods.agent.session.new, () => ({ sessionId: `pid-${process.pid}` }))
    .onRequest(methods.agent.session.prompt, async ({ params }) => {
        const text = params.prompt.map((block) => (block.type === 'text' ? block.text : '')).join('');
        await client.notify(methods.client.session.update, { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo:${text}` } } });
        return { stopReason: 'end_turn' };
    });
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
