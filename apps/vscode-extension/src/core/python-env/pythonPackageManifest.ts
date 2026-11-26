export interface CodeXRPythonPackage {
    distribution: string;
    importName: string;
    version: string;
    purpose: string;
    verificationArgs: string[];
}

export const CODEXR_PYTHON_PACKAGES: readonly CodeXRPythonPackage[] = [
    {
        distribution: 'lizard',
        importName: 'lizard',
        version: '1.17.31',
        purpose: 'code complexity analysis',
        verificationArgs: ['-m', 'lizard', '--version'],
    },
    {
        distribution: 'tree-sitter-language-pack',
        importName: 'tree_sitter_language_pack',
        version: '1.8.1',
        purpose: 'structured multi-language dependency parsing',
        // Import only: since 1.x, get_parser() downloads the grammar from GitHub on
        // first use, so checking that way made a network call nobody agreed to
        // (and, offline, failed and triggered a reinstall).
        verificationArgs: ['-c', 'import tree_sitter_language_pack; print("ok")'],
    },
] as const;

export function getPinnedPythonRequirement(pkg: CodeXRPythonPackage): string {
    return `${pkg.distribution}==${pkg.version}`;
}
