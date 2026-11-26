import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentChatEvent, ChatMessageView } from '../src/shared/agents.ts';
import { JsonKeyValueStore } from '../src/main/core/jsonStore.ts';
import { KeyVault, type SecretCipher } from '../src/main/agents/keyVault.ts';
import { ProviderRegistry } from '../src/main/agents/providerRegistry.ts';
import { AgentProfiles } from '../src/main/agents/agentProfiles.ts';
import { ChatSessions } from '../src/main/agents/chatSessions.ts';
import { AgentChat } from '../src/main/agents/agentChat.ts';
import { ToolCatalog } from '../src/main/agents/tools/toolCatalog.ts';
import { monthKey, priceFor, UsageLedger } from '../src/main/agents/usageLedger.ts';
import { addUsage, formatUsage, usd } from '../src/shared/usageFormat.ts';
import type { FetchLike } from '../src/main/agents/providers/types.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-usage-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const cipher: SecretCipher = {
    isAvailable: () => true,
    backend: () => 'gnome_libsecret',
    encrypt: (plain) => Buffer.from(plain, 'utf8'),
    decrypt: (data) => data.toString('utf8'),
};

let counter = 0;
const ledgerAt = (date = new Date(2026, 10, 26, 12)): UsageLedger => {
    counter += 1;
    return new UsageLedger(new JsonKeyValueStore(path.join(base, `usage-${counter}.json`)), () => date);
};

/** One OpenAI-style answer with the usage chunk; `cost` as OpenRouter reports it. */
function answer(text: string, usage: { prompt_tokens: number; completion_tokens: number; cost?: number }): Response {
    const body = [
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [], usage })}\n\n`,
        'data: [DONE]\n\n',
    ].join('');
    return new Response(body);
}

describe('usage formatting (A13)', () => {
    it('adds usages without ever mixing estimated and reported costs', () => {
        const total = addUsage(addUsage(undefined, { inputTokens: 10, outputTokens: 2, estimatedCost: 0.5 }), { inputTokens: 5, outputTokens: 1, reportedCost: 0.25 });
        assert.deepEqual(total, { inputTokens: 15, outputTokens: 3, estimatedCost: 0.5, reportedCost: 0.25 });
        assert.deepEqual(addUsage(undefined, { inputTokens: 1, outputTokens: 1 }), { inputTokens: 1, outputTokens: 1 });
        assert.equal(formatUsage(total), '15 in / 3 out tokens · est. $0.50 · reported $0.25');
        assert.equal(formatUsage({ inputTokens: 123_456, outputTokens: 12_345 }), '123k in / 12.3k out tokens');
        assert.equal(usd(0.00042), '$0.0004');
    });
});

describe('UsageLedger (A13)', () => {
    it('prices a model by exact id first, then by the longest prefix', () => {
        const prices = [{ model: 'gpt-*', inputPerMillion: 1, outputPerMillion: 2 }, { model: 'gpt-4o-*', inputPerMillion: 3, outputPerMillion: 4 }, { model: 'gpt-4o-mini', inputPerMillion: 5, outputPerMillion: 6 }];
        assert.equal(priceFor(prices, 'gpt-4o-mini')?.inputPerMillion, 5);
        assert.equal(priceFor(prices, 'gpt-4o-2024')?.inputPerMillion, 3);
        assert.equal(priceFor(prices, 'gpt-3.5')?.inputPerMillion, 1);
        assert.equal(priceFor(prices, 'claude'), undefined);
    });

    it('validates the price table and the budget', async () => {
        const ledger = ledgerAt();
        await assert.rejects(ledger.savePrices([{ model: 'a', inputPerMillion: -1, outputPerMillion: 1 }]), /dollars per million/);
        await assert.rejects(ledger.savePrices([{ model: 'a', inputPerMillion: 1, outputPerMillion: 1 }, { model: 'a', inputPerMillion: 2, outputPerMillion: 2 }]), /twice/);
        await assert.rejects(ledger.saveBudget({ monthlyUsd: 10, warnAt: 0.01, hardStop: true }), /between 10% and 100%/);
        await assert.rejects(ledger.saveBudget({ monthlyUsd: -5, warnAt: 0.8, hardStop: true }), /dollars/);
        assert.deepEqual(ledger.budget(), { monthlyUsd: 0, warnAt: 0.8, hardStop: false });
    });

    it('records calls per agent, provider and model, with estimated and reported costs apart', async () => {
        const ledger = ledgerAt();
        await ledger.savePrices([{ model: 'gpt-test', inputPerMillion: 2, outputPerMillion: 8 }]);
        const first = await ledger.record({ agent: 'Assistant', provider: 'OpenAI', model: 'gpt-test', inputTokens: 1_000_000, outputTokens: 500_000 });
        assert.deepEqual(first, { inputTokens: 1_000_000, outputTokens: 500_000, estimatedCost: 6 });
        await ledger.record({ agent: 'Reviewer', provider: 'OpenRouter', model: 'some/model', inputTokens: 100, outputTokens: 10, reportedCost: 0.5 });
        await ledger.record({ agent: 'Reviewer', provider: 'Ollama', model: 'llama', inputTokens: 100, outputTokens: 10 });
        const summary = ledger.summary();
        assert.equal(summary.month, '2026-11');
        assert.equal(summary.total.calls, 3);
        assert.equal(summary.total.estimatedCost, 6);
        assert.equal(summary.total.reportedCost, 0.5);
        assert.equal(summary.total.unpricedCalls, 1);
        assert.deepEqual(summary.byAgent.map((group) => [group.name, group.calls]), [['Assistant', 1], ['Reviewer', 2]]);
        assert.deepEqual(summary.byProvider.map((group) => group.name), ['OpenAI', 'OpenRouter', 'Ollama']);
        assert.equal(summary.budgetState, 'none');
        // Another month starts from zero.
        const next = new UsageLedger(new JsonKeyValueStore(path.join(base, `usage-${counter}.json`)), () => new Date(2026, 11, 1));
        assert.equal(next.summary().total.calls, 0);
        assert.equal(monthKey(new Date(2026, 0, 5)), 'month:2026-01');
    });

    it('warns, then stops new calls once a hard budget is spent', async () => {
        const ledger = ledgerAt();
        await ledger.saveBudget({ monthlyUsd: 1, warnAt: 0.5, hardStop: true });
        await ledger.record({ agent: 'A', provider: 'P', model: 'm', inputTokens: 1, outputTokens: 1, reportedCost: 0.6 });
        assert.equal(ledger.summary().budgetState, 'warning');
        assert.doesNotThrow(() => ledger.assertWithinBudget());
        await ledger.record({ agent: 'A', provider: 'P', model: 'm', inputTokens: 1, outputTokens: 1, reportedCost: 0.4 });
        const summary = ledger.summary();
        assert.equal(summary.budgetState, 'reached');
        assert.equal(summary.budgetSpend, 1);
        assert.throws(() => ledger.assertWithinBudget(), /monthly budget of \$1\.00 is reached/);
        await ledger.saveBudget({ monthlyUsd: 1, warnAt: 0.5, hardStop: false });
        assert.doesNotThrow(() => ledger.assertWithinBudget(), 'without the hard stop it only warns');
    });
});

describe('AgentChat usage (A13)', () => {
    async function setup(fetchImpl: FetchLike) {
        counter += 1;
        const dir = path.join(base, `chat-${counter}`);
        const providers = new ProviderRegistry(new JsonKeyValueStore(path.join(dir, 'providers.json')), new KeyVault(path.join(dir, 'keys.json'), cipher), fetchImpl);
        const profiles = new AgentProfiles(new JsonKeyValueStore(path.join(dir, 'agents.json')));
        const sessions = new ChatSessions(path.join(dir, 'sessions'));
        const ledger = new UsageLedger(new JsonKeyValueStore(path.join(dir, 'usage.json')));
        const chat = new AgentChat(providers, profiles, sessions, new ToolCatalog([]), ledger);
        const provider = await providers.save({ kind: 'openai', label: 'Gateway', apiKey: 'sk-test-0123456789' });
        const [assistant] = await profiles.list();
        assert.ok(assistant);
        await profiles.save({ ...assistant, providerId: provider.id, model: 'gpt-test', tools: [] }, assistant.id);
        return { chat, ledger, agentId: assistant.id };
    }

    it('keeps provider, model, tokens and both costs on each answer, and records them', async () => {
        const { chat, ledger, agentId } = await setup(() => Promise.resolve(answer('Hi', { prompt_tokens: 2_000, completion_tokens: 100, cost: 0.003 })));
        await ledger.savePrices([{ model: 'gpt-*', inputPerMillion: 1, outputPerMillion: 10 }]);
        const session = await chat.create(null, agentId);
        const events: AgentChatEvent[] = [];
        await chat.send(null, session.id, 'Hello', [], { workspace: null, emit: (event) => events.push(event) });
        const end = events.find((event): event is Extract<AgentChatEvent, { type: 'end' }> => event.type === 'end');
        const message: ChatMessageView | undefined = end?.message;
        assert.equal(message?.provider, 'Gateway');
        assert.equal(message?.model, 'gpt-test');
        assert.deepEqual(message?.usage, { inputTokens: 2_000, outputTokens: 100, estimatedCost: 0.003, reportedCost: 0.003 });
        const stored = await chat.get(null, session.id);
        assert.equal(stored.messages.at(-1)?.provider, 'Gateway', 'the provider is saved with the chat');
        const summary = ledger.summary();
        assert.equal(summary.total.calls, 1);
        assert.deepEqual(summary.byAgent.map((group) => group.name), ['Assistant']);
    });

    it('refuses to call the model once a hard budget is spent', async () => {
        let calls = 0;
        const { chat, ledger, agentId } = await setup(() => {
            calls += 1;
            return Promise.resolve(answer('Hi', { prompt_tokens: 1, completion_tokens: 1, cost: 5 }));
        });
        await ledger.saveBudget({ monthlyUsd: 5, warnAt: 0.8, hardStop: true });
        const session = await chat.create(null, agentId);
        await chat.send(null, session.id, 'First', [], { workspace: null, emit: () => undefined });
        await chat.send(null, session.id, 'Second', [], { workspace: null, emit: () => undefined });
        assert.equal(calls, 1);
        const stored = await chat.get(null, session.id);
        assert.match(stored.messages.at(-1)?.error ?? '', /monthly budget of \$5\.00 is reached/);
    });
});
