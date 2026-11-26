/**
 * The environment every history Git command runs with (S14, EVO-10).
 *
 * In a partial clone (`git clone --filter=blob:none`) Git fetches a missing
 * object from the promisor remote on demand. A comparison, a movie or an
 * export reading old blobs then used the network without the user asking,
 * one object at a time, and could block on a credential prompt. With
 * `GIT_NO_LAZY_FETCH` Git reports the object as missing instead, and
 * `GIT_TERMINAL_PROMPT=0` / `GCM_INTERACTIVE=never` keep any credential
 * helper from waiting for input that will never come.
 */
export function gitOfflineEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    return {
        ...base,
        GIT_NO_LAZY_FETCH: '1',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
    };
}

export const PARTIAL_CLONE_MISSING_MESSAGE =
    'git-object-missing: a file of this revision is not on this computer (partial clone). '
    + 'CodeXR does not download it; run `git fetch` with the objects you need, or use a full clone.';

/** Shown before a comparison when the repository is a partial clone (EVO-10). */
export const PARTIAL_CLONE_NOTICE =
    'This repository is a partial clone: older revisions may be missing files on this computer. '
    + 'CodeXR does not download them, so those revisions cannot be compared. '
    + 'Run `git fetch --refetch` or use a full clone to compare any revision.';

/**
 * True when `git config --get-regexp` output names a promisor remote or the
 * partial-clone extension, the two settings `git clone --filter` writes.
 */
export function isPartialCloneConfig(configOutput: string): boolean {
    return configOutput.split(/\r?\n/).some((line) => {
        const [key, ...rest] = line.trim().split(/\s+/);
        const value = rest.join(' ').toLowerCase();
        if (!key) {
            return false;
        }
        if (/^extensions\.partialclone$/i.test(key)) {
            return value.length > 0;
        }
        return /^remote\..+\.promisor$/i.test(key) && value !== 'false' && value !== '0' && value !== 'no' && value !== 'off';
    });
}

/** True when Git failed because a partial clone lacks the object locally. */
export function isPartialCloneMissingObject(message: string): boolean {
    return /could not fetch [0-9a-f]+ from promisor remote|lazy fetching disabled/i.test(message);
}
