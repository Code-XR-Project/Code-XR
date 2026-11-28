/**
 * Phase 1 of the Agent Flow builder: folds the trace events, in time order,
 * into steps, turns and actors (the main agent, then each sub-agent as it
 * first appears), plus the per-turn metric deltas a host measured.
 */
import {
    MAIN_ACTOR_ID,
    type AgentFlowActor,
    type AgentFlowMetricDelta,
    type AgentFlowStep,
    type AgentFlowTurn,
    type AgentTraceEvent,
} from './agentFlowModels';
import { relativeToRoot } from './agentFlowPaths';

export interface MutableStep extends AgentFlowStep {
    paths: string[];
    createdPaths: string[];
    deletedPaths: string[];
}

type StepEvent = Extract<AgentTraceEvent, { type: 'step' }>;

export interface FoldedTrace {
    steps: MutableStep[];
    turns: AgentFlowTurn[];
    actors: AgentFlowActor[];
    turnDeltas: Map<number, Map<string, AgentFlowMetricDelta>>;
    /** Locations left out because they lie outside the analysed root. */
    outside: number;
}

interface FoldState extends FoldedTrace {
    root: string;
    stepById: Map<string, MutableStep>;
    actorById: Map<string, AgentFlowActor>;
}

function openTurn(state: FoldState, at: number, prompt: string): AgentFlowTurn {
    const turn: AgentFlowTurn = {
        index: state.turns.length, prompt, startedAt: at, endedAt: null, stepStart: -1, stepEnd: -1,
        reads: 0, writes: 0, searches: 0, executes: 0, filesTouched: 0, delta: null,
    };
    state.turns.push(turn);
    return turn;
}

function currentTurn(state: FoldState, at: number): AgentFlowTurn {
    const last = state.turns[state.turns.length - 1];
    return last && last.endedAt === null ? last : openTurn(state, at, '');
}

function resolvePaths(state: FoldState, locations: ReadonlyArray<{ path: string }> | undefined): string[] {
    const out: string[] = [];
    for (const location of locations ?? []) {
        const rel = relativeToRoot(state.root, location.path);
        if (rel === null) { state.outside += 1; continue; }
        if (!out.includes(rel)) { out.push(rel); }
    }
    return out;
}

function asLocations(paths: string[] | undefined): Array<{ path: string }> | undefined {
    return paths?.map((path) => ({ path }));
}

function actorFor(state: FoldState, id: string | undefined, label?: string): AgentFlowActor {
    const key = id || MAIN_ACTOR_ID;
    let actor = state.actorById.get(key);
    if (!actor) {
        actor = {
            index: state.actors.length, id: key, label: label || `Sub-agent ${state.actors.length}`, kind: 'subagent',
            parent: 0, spawnStep: null, firstSeq: -1, lastSeq: -1, steps: 0,
        };
        state.actors.push(actor);
        state.actorById.set(key, actor);
    } else if (label && actor.kind === 'subagent' && /^Sub-agent \d+$/.test(actor.label)) {
        actor.label = label;
    }
    return actor;
}

/** Ties the sub-agent a delegate step spawns to that step; returns its index. */
function linkSpawn(state: FoldState, spawns: { id: string; label?: string }, parent: number, seq: number): number {
    const spawned = actorFor(state, spawns.id, spawns.label);
    spawned.parent = parent;
    spawned.spawnStep = seq;
    return spawned.index;
}

function foldTurnStart(state: FoldState, at: number, prompt: string | undefined): void {
    const last = state.turns[state.turns.length - 1];
    if (last && last.endedAt === null) { last.endedAt = at; }
    openTurn(state, at, prompt ?? '');
}

function foldTurnEnd(state: FoldState, at: number, stopReason: string | undefined): void {
    const last = state.turns[state.turns.length - 1];
    if (last && last.endedAt === null) {
        last.endedAt = at;
        if (stopReason) { last.stopReason = stopReason; }
    }
}

function foldMetricDelta(state: FoldState, files: Extract<AgentTraceEvent, { type: 'metric-delta' }>['files']): void {
    const target = state.turns.length > 0 ? state.turns[state.turns.length - 1].index : 0;
    const map = state.turnDeltas.get(target) ?? new Map<string, AgentFlowMetricDelta>();
    for (const file of files) {
        const rel = relativeToRoot(state.root, file.path);
        if (!rel) { continue; }
        map.set(rel, { codeLines: file.codeLines ?? 0, complexity: file.complexity ?? 0 });
    }
    state.turnDeltas.set(target, map);
}

function appendUnique(target: string[], values: string[]): void {
    for (const value of values) {
        if (!target.includes(value)) { target.push(value); }
    }
}

/** A second event with the same id updates the step instead of adding one. */
function updateStep(state: FoldState, existing: MutableStep, event: StepEvent): void {
    if (event.status) { existing.status = event.status; }
    if (event.title) { existing.title = event.title; }
    if (event.exitCode !== undefined) { existing.exitCode = event.exitCode; }
    if (event.command) { existing.command = event.command; }
    if (event.added !== undefined) { existing.added = event.added; }
    if (event.removed !== undefined) { existing.removed = event.removed; }
    // An update that only now names its files (search hits, a diff) adds them.
    appendUnique(existing.paths, resolvePaths(state, event.locations));
    appendUnique(existing.createdPaths, resolvePaths(state, asLocations(event.created)));
    if (event.spawns && existing.spawns === undefined) {
        existing.spawns = linkSpawn(state, event.spawns, existing.actor, existing.seq);
    }
}

/** The optional fields of a new step, copied only when the event carries them. */
function applyStepExtras(step: MutableStep, event: StepEvent, actor: AgentFlowActor): void {
    const line = event.locations?.find((loc) => loc.line !== undefined)?.line;
    if (line !== undefined) { step.line = line; }
    if (event.command) { step.command = event.command; }
    if (event.exitCode !== undefined) { step.exitCode = event.exitCode; }
    if (event.subagent || actor.index > 0) { step.subagent = true; }
}

function addStep(state: FoldState, event: StepEvent): void {
    const turn = currentTurn(state, event.at);
    const actor = actorFor(state, event.actor, event.actorLabel);
    const step: MutableStep = {
        actor: actor.index,
        seq: state.steps.length,
        turn: turn.index,
        at: event.at,
        kind: event.kind,
        tool: event.tool ?? event.kind,
        title: event.title ?? event.tool ?? event.kind,
        status: event.status ?? 'running',
        files: [],
        paths: resolvePaths(state, event.locations),
        createdPaths: resolvePaths(state, asLocations(event.created)),
        deletedPaths: resolvePaths(state, asLocations(event.deleted)),
    };
    applyStepExtras(step, event, actor);
    if (event.spawns) { step.spawns = linkSpawn(state, event.spawns, actor.index, step.seq); }
    if (actor.firstSeq < 0) { actor.firstSeq = step.seq; }
    actor.lastSeq = step.seq;
    actor.steps += 1;
    if (event.added !== undefined) { step.added = event.added; }
    if (event.removed !== undefined) { step.removed = event.removed; }
    state.steps.push(step);
    state.stepById.set(event.id, step);
    if (turn.stepStart < 0) { turn.stepStart = step.seq; }
    turn.stepEnd = step.seq;
}

function foldEvent(state: FoldState, event: AgentTraceEvent): void {
    switch (event.type) {
        case 'turn-start': foldTurnStart(state, event.at, event.prompt); return;
        case 'turn-end': foldTurnEnd(state, event.at, event.stopReason); return;
        case 'metric-delta': foldMetricDelta(state, event.files); return;
        default: break;
    }
    const existing = state.stepById.get(event.id);
    if (existing) {
        updateStep(state, existing, event);
    } else {
        addStep(state, event);
    }
}

export function foldTraceEvents(root: string, agentLabel: string, events: ReadonlyArray<AgentTraceEvent>): FoldedTrace {
    const main: AgentFlowActor = {
        index: 0, id: MAIN_ACTOR_ID, label: agentLabel || 'Agent', kind: 'main',
        parent: null, spawnStep: null, firstSeq: -1, lastSeq: -1, steps: 0,
    };
    const state: FoldState = {
        root,
        steps: [],
        turns: [],
        actors: [main],
        turnDeltas: new Map(),
        outside: 0,
        stepById: new Map(),
        actorById: new Map([[MAIN_ACTOR_ID, main]]),
    };
    // Sub-agents are read from files of their own and land out of order: fold
    // in time order (stable, so events of one moment keep their source order).
    const ordered = events
        .map((event, order) => ({ event, order }))
        .sort((a, b) => a.event.at - b.event.at || a.order - b.order)
        .map((entry) => entry.event);
    for (const event of ordered) { foldEvent(state, event); }
    return state;
}
