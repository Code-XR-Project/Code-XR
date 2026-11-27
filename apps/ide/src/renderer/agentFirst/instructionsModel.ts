/**
 * Project instructions for agents (AF11, #276): the files each agent reads on
 * its own at the start of a chat, so the person writes the project's rules
 * once and every agent follows them. No DOM.
 *
 * AGENTS.md is the shared format (read by Codex, Gemini CLI with its
 * `contextFileName` setting, and most other agents). Claude Code reads
 * CLAUDE.md, which can import AGENTS.md with an `@AGENTS.md` line, so one
 * file serves both.
 */

export interface InstructionFileKind {
    /** Workspace path, `/`-separated. */
    readonly path: string;
    readonly label: string;
    /** Which agents read it. */
    readonly readBy: string;
    /** The starting text when the person creates it from the panel. */
    readonly template: string;
}

export const AGENTS_TEMPLATE = `# AGENTS.md

Instructions for AI coding agents working on this project.

## Project
- What it is and who uses it.

## Commands
- Install:
- Build:
- Test:

## Conventions
- Code style and naming.
- Where new code goes.

## Rules
- Run the tests before saying a change is done.
- Never commit secrets.
`;

export const INSTRUCTION_FILES: readonly InstructionFileKind[] = [
    { path: 'AGENTS.md', label: 'AGENTS.md', readBy: 'Codex, Gemini CLI and most agents', template: AGENTS_TEMPLATE },
    { path: 'CLAUDE.md', label: 'CLAUDE.md', readBy: 'Claude Code', template: '# CLAUDE.md\n\n@AGENTS.md\n' },
    { path: 'GEMINI.md', label: 'GEMINI.md', readBy: 'Gemini CLI', template: '# GEMINI.md\n\nFollow the instructions in AGENTS.md.\n' },
    { path: '.github/copilot-instructions.md', label: 'Copilot instructions', readBy: 'GitHub Copilot', template: '# Copilot instructions\n\nFollow the instructions in AGENTS.md.\n' },
];

export interface InstructionEntry extends InstructionFileKind {
    readonly exists: boolean;
}

/** The known instruction files with whether the project has each (paths compared case-insensitively). */
export function instructionEntries(files: readonly string[]): InstructionEntry[] {
    const present = new Set(files.map((file) => file.replace(/\\/g, '/').toLowerCase()));
    return INSTRUCTION_FILES.map((kind) => ({ ...kind, exists: present.has(kind.path.toLowerCase()) }));
}

/** Other rule files found in the project (Cursor rules, nested AGENTS.md...), shown read-only. */
export function otherRuleFiles(files: readonly string[], limit = 20): string[] {
    const known = new Set(INSTRUCTION_FILES.map((kind) => kind.path.toLowerCase()));
    return files
        .map((file) => file.replace(/\\/g, '/'))
        .filter((file) => !known.has(file.toLowerCase()))
        .filter((file) => /(^|\/)(agents|claude|gemini)\.md$/i.test(file) || /^\.cursor\/rules\/.+\.mdc?$/i.test(file) || /^\.cursorrules$/i.test(file) || /^\.windsurfrules$/i.test(file) || /^\.github\/instructions\/.+\.md$/i.test(file))
        .sort()
        .slice(0, limit);
}

/** The parent folder and name of a workspace path, for `createEntry`. */
export function splitWorkspacePath(path: string): { readonly parent: string; readonly name: string } {
    const index = path.lastIndexOf('/');
    return index < 0 ? { parent: '', name: path } : { parent: path.slice(0, index), name: path.slice(index + 1) };
}
