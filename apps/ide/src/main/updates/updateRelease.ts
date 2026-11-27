/**
 * #20: which GitHub release is an update for the running IDE. Pure, so it is
 * unit-tested; `updateCheck.ts` fetches the list and asks the person.
 */
export const RELEASES_API = 'https://api.github.com/repos/Code-XR-Project/Code-XR/releases?per_page=30';
const RELEASE_PAGE_PREFIX = 'https://github.com/Code-XR-Project/Code-XR/releases/';
const TAG = /^ide-v(\d+)\.(\d+)\.(\d+)$/;

export interface AvailableUpdate {
    readonly version: string;
    readonly url: string;
}

function parseVersion(version: string): readonly number[] | null {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function newer(a: readonly number[], b: readonly number[]): boolean {
    for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0)) {
            return (a[i] ?? 0) > (b[i] ?? 0);
        }
    }
    return false;
}

/**
 * The newest published IDE release (`ide-vX.Y.Z`, not a draft or a
 * pre-release) above `current`, or null. Only a release page of this
 * repository is ever offered as the link to open.
 */
export function pickUpdate(releases: unknown, current: string): AvailableUpdate | null {
    const mine = parseVersion(current);
    if (!mine || !Array.isArray(releases)) {
        return null;
    }
    let best: { version: readonly number[]; update: AvailableUpdate } | null = null;
    for (const release of releases as unknown[]) {
        if (!release || typeof release !== 'object') {
            continue;
        }
        const { tag_name: tag, html_url: url, draft, prerelease } = release as Record<string, unknown>;
        const match = typeof tag === 'string' ? TAG.exec(tag) : null;
        if (!match || draft === true || prerelease === true || typeof url !== 'string' || !url.startsWith(RELEASE_PAGE_PREFIX)) {
            continue;
        }
        const version = [Number(match[1]), Number(match[2]), Number(match[3])];
        if (newer(version, mine) && (!best || newer(version, best.version))) {
            best = { version, update: { version: version.join('.'), url } };
        }
    }
    return best?.update ?? null;
}

