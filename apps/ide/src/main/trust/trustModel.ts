import path from 'node:path';
import type { WorkspaceTrustState } from '../../shared/api.ts';

/**
 * #177: workspace trust, the pure half. A decision is an absolute folder and
 * whether it is trusted. A folder is trusted when it, or any folder above
 * it, was trusted; restricted when it was put in Restricted Mode itself (that
 * decision wins over a trusted parent, so one checkout of a trusted tree can
 * still be opened restricted); unknown otherwise, which the IDE treats as
 * restricted until the person answers. Paths compare case-insensitively on
 * Windows and macOS, whose default file systems do.
 */
export interface TrustDecision {
    readonly path: string;
    readonly trusted: boolean;
}

export const MAX_TRUST_DECISIONS = 500;

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
    return platform === 'win32' ? path.win32 : path.posix;
}

function key(folder: string, platform: NodeJS.Platform): string {
    const resolved = pathApi(platform).resolve(folder);
    return platform === 'win32' || platform === 'darwin' ? resolved.toLowerCase() : resolved;
}

/** True when `child` is `parent` or inside it. */
export function isSameOrInside(parent: string, child: string, platform: NodeJS.Platform): boolean {
    const api = pathApi(platform);
    const relative = api.relative(key(parent, platform), key(child, platform));
    return relative === '' || (!relative.startsWith('..') && !api.isAbsolute(relative));
}

export function trustOf(folder: string, decisions: readonly TrustDecision[], platform: NodeJS.Platform): WorkspaceTrustState {
    const own = decisions.find((decision) => key(decision.path, platform) === key(folder, platform));
    if (own && !own.trusted) {
        return 'restricted';
    }
    return decisions.some((decision) => decision.trusted && isSameOrInside(decision.path, folder, platform)) ? 'trusted' : 'unknown';
}

/** The folder that makes `folder` trusted (itself or the closest parent), for "Trusted through ...". */
export function trustedThrough(folder: string, decisions: readonly TrustDecision[], platform: NodeJS.Platform): string | null {
    const candidates = decisions.filter((decision) => decision.trusted && isSameOrInside(decision.path, folder, platform));
    candidates.sort((a, b) => key(b.path, platform).length - key(a.path, platform).length);
    return candidates[0]?.path ?? null;
}

/** Records a decision for `folder`, replacing an earlier one for the same folder; the newest come first. */
export function withDecision(decisions: readonly TrustDecision[], folder: string, trusted: boolean, platform: NodeJS.Platform): TrustDecision[] {
    const resolved = pathApi(platform).resolve(folder);
    const rest = decisions.filter((decision) => key(decision.path, platform) !== key(resolved, platform));
    return [{ path: resolved, trusted }, ...rest].slice(0, MAX_TRUST_DECISIONS);
}

/** Reads stored decisions; anything malformed is dropped. */
export function parseDecisions(value: unknown): TrustDecision[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value.flatMap((entry: unknown) => {
        const candidate = entry as { path?: unknown; trusted?: unknown } | null;
        return candidate && typeof candidate.path === 'string' && candidate.path.length > 0 && candidate.path.length < 4096 && typeof candidate.trusted === 'boolean'
            ? [{ path: candidate.path, trusted: candidate.trusted }]
            : [];
    }).slice(0, MAX_TRUST_DECISIONS);
}
