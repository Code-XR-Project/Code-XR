import { randomUUID } from 'node:crypto';
import type { AgentProfile, AgentProfileInput } from '../../shared/agents.ts';
import type { JsonKeyValueStore } from '../core/jsonStore.ts';

const STORE_KEY = 'agents.profiles';

/** The starters every installation begins with (A4); all editable. */
export const STARTER_AGENTS: readonly Omit<AgentProfile, 'id' | 'providerId' | 'model'>[] = [
    {
        name: 'Assistant',
        instructions: 'You are a helpful assistant inside the Code-XR IDE. Answer concisely and use Markdown code blocks for code.',
        tools: [],
    },
    {
        name: 'Code reviewer',
        instructions: 'You review code. Point out bugs, security issues and unclear code first, then smaller improvements. Quote the lines you mean and propose concrete fixes.',
        temperature: 0.2,
        tools: [],
    },
    {
        name: 'Architect',
        instructions: 'You are a software architect. Reason about module boundaries, dependencies, coupling and how a codebase evolves. Give trade-offs, not only recommendations.',
        tools: [],
    },
];

/**
 * The person's agents (A4), in the IDE's JSON store. The first listing seeds
 * the starters, bound to no provider yet: an agent never picks a provider by itself.
 */
export class AgentProfiles {
    private readonly store: JsonKeyValueStore;

    constructor(store: JsonKeyValueStore) {
        this.store = store;
    }

    async list(): Promise<readonly AgentProfile[]> {
        const raw = this.store.get<unknown>(STORE_KEY);
        if (raw === undefined) {
            const seeded = STARTER_AGENTS.map((starter) => ({ ...starter, id: randomUUID(), providerId: '', model: '' }));
            await this.store.update(STORE_KEY, seeded);
            return seeded;
        }
        return Array.isArray(raw) ? raw.filter(isProfile) : [];
    }

    async get(id: string): Promise<AgentProfile | undefined> {
        return (await this.list()).find((profile) => profile.id === id);
    }

    async save(input: unknown, id?: unknown): Promise<AgentProfile> {
        const parsed = parseProfile(input);
        const profiles = [...(await this.list())];
        const index = typeof id === 'string' ? profiles.findIndex((profile) => profile.id === id) : -1;
        if (typeof id === 'string' && index < 0) {
            throw new Error('That agent no longer exists.');
        }
        const profile: AgentProfile = { ...parsed, id: index >= 0 ? (profiles[index]?.id ?? randomUUID()) : randomUUID() };
        if (index >= 0) {
            profiles[index] = profile;
        } else {
            profiles.push(profile);
        }
        await this.store.update(STORE_KEY, profiles);
        return profile;
    }

    async remove(id: unknown): Promise<void> {
        if (typeof id !== 'string') {
            throw new Error('Unknown agent.');
        }
        await this.store.update(STORE_KEY, (await this.list()).filter((profile) => profile.id !== id));
    }

    /** A removed provider leaves its agents unbound (shown as "needs a provider"), never switched. */
    async unbindProvider(providerId: string): Promise<void> {
        const profiles = await this.list();
        if (profiles.some((profile) => profile.providerId === providerId)) {
            await this.store.update(STORE_KEY, profiles.map((profile) => (profile.providerId === providerId ? { ...profile, providerId: '' } : profile)));
        }
    }
}

function isProfile(value: unknown): value is AgentProfile {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const record = value as Record<string, unknown>;
    return typeof record['id'] === 'string' && typeof record['name'] === 'string' && typeof record['providerId'] === 'string'
        && typeof record['model'] === 'string' && typeof record['instructions'] === 'string' && Array.isArray(record['tools']);
}

/** Validates what came over IPC. */
export function parseProfile(input: unknown): AgentProfileInput {
    if (!input || typeof input !== 'object') {
        throw new Error('Invalid agent.');
    }
    const record = input as Record<string, unknown>;
    const text = (key: string, max: number, required = false): string => {
        const value = record[key] ?? '';
        if (typeof value !== 'string' || value.length > max) {
            throw new Error(`Invalid ${key}.`);
        }
        if (required && !value.trim()) {
            throw new Error(`The agent needs a ${key}.`);
        }
        return value.trim();
    };
    const temperature = record['temperature'];
    if (temperature !== undefined && temperature !== null && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
        throw new Error('Temperature must be between 0 and 2.');
    }
    const tools = record['tools'] ?? [];
    if (!Array.isArray(tools) || tools.some((tool) => typeof tool !== 'string')) {
        throw new Error('Invalid tools.');
    }
    return {
        name: text('name', 60, true),
        providerId: text('providerId', 100),
        model: text('model', 200),
        instructions: text('instructions', 20_000),
        ...(typeof temperature === 'number' ? { temperature } : {}),
        tools: tools as string[],
    };
}
