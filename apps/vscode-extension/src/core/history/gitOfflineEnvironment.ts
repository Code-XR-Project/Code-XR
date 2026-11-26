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

/** True when Git failed because a partial clone lacks the object locally. */
export function isPartialCloneMissingObject(message: string): boolean {
    return /could not fetch [0-9a-f]+ from promisor remote|lazy fetching disabled/i.test(message);
}
