import type { AgentTool } from './toolTypes.ts';

/**
 * `delegate_task` (A11): a supervisor hands a self-contained task to another
 * of the person's agents. The sub-agent starts from a clean context (only the
 * task), uses its own profile's tools under the same approval rules, and its
 * answer comes back as this tool's result. Several calls in one turn run in
 * parallel, up to the supervisor's `maxParallel`. Sub-agents cannot delegate
 * further, so a run tree is never deeper than one level.
 */
export const delegateTaskTool: AgentTool = {
    name: 'delegate_task',
    title: 'Delegate to another agent',
    description: 'Hands a self-contained task to another agent by name and returns its answer. The other agent sees only the task text, so include every detail it needs. '
        + 'Call it several times in one turn to run sub-agents in parallel; then combine their answers.',
    risk: 'read',
    parameters: {
        type: 'object',
        properties: {
            agent: { type: 'string', description: 'The exact name of one of the person\'s agents, e.g. "Code reviewer".' },
            task: { type: 'string', description: 'What to do, with all the context it needs.' },
        },
        required: ['agent', 'task'],
    },
    preview: (args) => ({ summary: `${String(args['agent'] ?? '?')}: ${String(args['task'] ?? '').slice(0, 80)}` }),
    // AgentChat runs the sub-agent itself (runChild): it owns the loop, the
    // approvals and the run tree. Reaching this means something called the
    // tool outside a chat.
    run: () => Promise.reject(new Error('delegate_task only runs inside a chat.')),
};
