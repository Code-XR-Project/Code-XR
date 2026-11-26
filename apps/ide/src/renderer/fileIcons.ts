/**
 * File and folder icons (#138): which icon of the bundled set a name gets.
 * Pure (no DOM), so it is unit-tested and the status bar can reuse it later.
 *
 * The icons are SVGs from `material-icon-theme` (MIT, see
 * THIRD_PARTY_NOTICES.md), copied into `public/file-icons/` by
 * `scripts/syncFileIcons.mjs`: only the icons named in the tables below are
 * bundled, and a unit test keeps the folder and the tables in step. The
 * mappings follow the theme's own manifest, except where the Code-XR metric
 * contract (`backend/src/utils/metric_language_contract.py`) gives an
 * extension another language: `.pl` is Perl there, Prolog in the theme.
 *
 * Lookups are a few Map reads per name, so a folder of thousands of entries
 * renders no slower than with one fixed icon.
 */

export type IconKind = 'file' | 'directory';

/** Icon for any file the tables do not know. */
export const DEFAULT_FILE_ICON = 'file';
export const DEFAULT_FOLDER_ICON = 'folder';
export const DEFAULT_FOLDER_OPEN_ICON = 'folder-open';

const group = (icon: string, keys: readonly string[]): Array<[string, string]> => keys.map((key) => [key, icon]);

/**
 * By extension, without the leading dot, lower case. Compound extensions
 * (`d.ts`, `test.ts`) are listed as such and win over the last segment.
 */
const EXTENSIONS: ReadonlyMap<string, string> = new Map([
    // The languages of the metric contract, in its order.
    ...group('python', ['py', 'pyw', 'pyi']),
    ...group('ruby', ['rb', 'rbw']),
    ...group('java', ['java']),
    ...group('c', ['c']),
    ...group('h', ['h']),
    ...group('cpp', ['cpp', 'cxx', 'cc', 'c++']),
    ...group('hpp', ['hpp', 'hxx', 'hh', 'h++']),
    ...group('csharp', ['cs']),
    ...group('erlang', ['erl', 'hrl']),
    ...group('fortran', ['f90', 'f95', 'f03', 'f08', 'f']),
    ...group('godot', ['gd']),
    ...group('go', ['go']),
    ...group('javascript', ['js', 'mjs', 'cjs']),
    ...group('kotlin', ['kt', 'kts']),
    ...group('lua', ['lua']),
    ...group('objective-c', ['m']),
    ...group('objective-cpp', ['mm']),
    ...group('php', ['php', 'phtml', 'php3', 'php4', 'php5']),
    ...group('perl', ['pl', 'pm']),
    ...group('scala', ['scala', 'sc']),
    ...group('solidity', ['sol']),
    ...group('swift', ['swift']),
    ...group('typescript', ['ts', 'mts', 'cts']),
    ...group('react_ts', ['tsx']),
    // The set has no TTCN-3 icon; it is a protocol-testing language, so it
    // borrows the protocol-definition one rather than the generic file.
    ...group('proto', ['ttcn', 'ttcn3', 'proto']),
    ...group('vue', ['vue']),
    ...group('zig', ['zig']),
    ...group('html', ['html', 'htm', 'xhtml']),
    // Other languages and their variants.
    ...group('react', ['jsx']),
    ...group('typescript-def', ['d.ts', 'd.mts', 'd.cts']),
    ...group('test-ts', ['test.ts', 'spec.ts', 'test.mts', 'spec.mts']),
    ...group('test-js', ['test.js', 'spec.js', 'test.mjs', 'spec.mjs', 'test.cjs', 'spec.cjs']),
    ...group('test-jsx', ['test.tsx', 'spec.tsx', 'test.jsx', 'spec.jsx']),
    ...group('rust', ['rs']),
    ...group('dart', ['dart']),
    ...group('r', ['r']),
    ...group('database', ['sql', 'sqlite', 'db']),
    ...group('jupyter', ['ipynb']),
    ...group('webassembly', ['wasm']),
    ...group('graphql', ['graphql', 'gql']),
    ...group('console', ['sh', 'bash', 'zsh', 'fish', 'bat', 'cmd']),
    ...group('powershell', ['ps1', 'psm1', 'psd1']),
    ...group('css', ['css']),
    ...group('sass', ['scss', 'sass']),
    ...group('less', ['less']),
    // Data and configuration.
    ...group('json', ['json', 'jsonc', 'json5', 'jsonl', 'ndjson', 'tsbuildinfo']),
    ...group('yaml', ['yml', 'yaml']),
    ...group('toml', ['toml']),
    ...group('xml', ['xml', 'xsd', 'xsl', 'plist']),
    ...group('settings', ['ini', 'cfg', 'conf', 'properties']),
    ...group('tune', ['env']),
    ...group('lock', ['lock']),
    ...group('table', ['csv', 'tsv', 'xls', 'xlsx']),
    ...group('log', ['log']),
    ...group('vscode', ['vsix', 'code-workspace']),
    ...group('diff', ['diff']),
    ...group('git', ['patch']),
    ...group('key', ['key', 'pem']),
    ...group('certificate', ['crt', 'cert']),
    // Documents.
    ...group('markdown', ['md', 'markdown', 'rst']),
    ...group('document', ['txt']),
    ...group('pdf', ['pdf']),
    ...group('tex', ['tex']),
    ...group('word', ['doc', 'docx']),
    ...group('powerpoint', ['ppt', 'pptx']),
    // Media and binaries.
    ...group('image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico', 'bmp']),
    ...group('svg', ['svg']),
    ...group('video', ['mp4', 'webm', 'mov', 'mkv', 'avi']),
    ...group('audio', ['mp3', 'wav', 'flac', 'ogg', 'm4a']),
    ...group('font', ['woff', 'woff2', 'ttf', 'otf', 'eot']),
    ...group('zip', ['zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar']),
    ...group('3d', ['gltf', 'glb', 'obj', 'fbx', 'stl']),
    ...group('exe', ['exe']),
    ...group('dll', ['dll', 'so', 'dylib']),
    ...group('jar', ['jar']),
    ...group('javaclass', ['class']),
]);

/** By whole file name, lower case. Checked before the extension. */
const FILE_NAMES: ReadonlyMap<string, string> = new Map([
    ...group('nodejs', ['package.json', 'package-lock.json', '.nvmrc', '.node-version']),
    ...group('npm', ['.npmrc', '.npmignore']),
    ...group('yarn', ['yarn.lock', '.yarnrc', '.yarnrc.yml']),
    ...group('pnpm', ['pnpm-lock.yaml', 'pnpm-workspace.yaml']),
    ...group('tsconfig', ['tsconfig.json']),
    ...group('jsconfig', ['jsconfig.json']),
    ...group('docker', ['dockerfile', 'containerfile', '.dockerignore', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']),
    ...group('git', ['.gitignore', '.gitattributes', '.gitmodules', '.gitkeep', '.mailmap']),
    ...group('license', ['license', 'license.md', 'license.txt', 'licence', 'licence.md', 'copying', 'copying.md']),
    ...group('readme', ['readme', 'readme.md', 'readme.txt']),
    ...group('changelog', ['changelog', 'changelog.md', 'changes.md', 'history.md']),
    ...group('contributing', ['contributing.md']),
    ...group('makefile', ['makefile', 'gnumakefile']),
    ...group('cmake', ['cmakelists.txt']),
    ...group('python-misc', ['requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'pipfile', 'pipfile.lock', 'setup.py', 'setup.cfg', '.python-version']),
    ...group('ruff', ['ruff.toml', '.ruff.toml']),
    ...group('editorconfig', ['.editorconfig']),
    ...group('vite', ['vite.config.js', 'vite.config.mjs', 'vite.config.cjs', 'vite.config.ts', 'vite.config.mts']),
    ...group('eslint', ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintignore']),
    ...group('prettier', ['.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierignore', 'prettier.config.js']),
    ...group('webpack', ['webpack.config.js', 'webpack.config.cjs', 'webpack.config.mjs', 'webpack.config.ts']),
    ...group('go-mod', ['go.mod', 'go.sum']),
    ...group('maven', ['pom.xml']),
    ...group('gradle', ['build.gradle', 'settings.gradle', 'build.gradle.kts', 'settings.gradle.kts']),
    ...group('gemfile', ['gemfile', 'gemfile.lock']),
    ...group('tune', ['.env', '.env.local', '.env.example', '.env.development', '.env.production']),
]);

/** By folder name, lower case: the closed icon; the open one adds `-open`. */
const FOLDER_NAMES: ReadonlyMap<string, string> = new Map([
    ...group('folder-src', ['src', 'source', 'sources']),
    ...group('folder-lib', ['lib', 'libs', 'vendor']),
    ...group('folder-test', ['test', 'tests', '__tests__', 'spec', 'specs', 'e2e']),
    ...group('folder-github', ['.github']),
    ...group('folder-node', ['node_modules']),
    ...group('folder-git', ['.git']),
    ...group('folder-vscode', ['.vscode']),
    ...group('folder-claude', ['.claude']),
    ...group('folder-docs', ['docs', 'doc']),
    ...group('folder-dist', ['dist', 'out', 'build', 'bin']),
    ...group('folder-scripts', ['scripts']),
    ...group('folder-resource', ['assets', 'resources', 'res']),
    ...group('folder-images', ['images', 'img', 'icons']),
    ...group('folder-video', ['media']),
    ...group('folder-public', ['public']),
    ...group('folder-config', ['config', 'configs', '.config']),
    ...group('folder-components', ['components']),
    ...group('folder-template', ['templates', 'template']),
    ...group('folder-examples', ['examples', 'example', 'samples']),
    ...group('folder-packages', ['packages']),
    ...group('folder-app', ['apps', 'app']),
    ...group('folder-utils', ['utils', 'util', 'helpers']),
    ...group('folder-mock', ['fixtures', 'mocks', '__mocks__']),
    ...group('folder-api', ['api']),
    ...group('folder-server', ['server', 'backend']),
    ...group('folder-environment', ['venv', '.venv', 'env']),
]);

/**
 * Icons that have a variant drawn for light backgrounds in the set: the
 * stylesheet switches to `<name>_light` under `prefers-color-scheme: light`.
 */
export const LIGHT_VARIANTS: ReadonlySet<string> = new Set(['toml', 'pnpm']);

/**
 * The icon name for an explorer entry or a tab. Files match their whole name
 * first, then the longest known extension (`a.d.ts` before `a.ts`); folders
 * match their name. Unknown names get the generic file or folder icon.
 */
export function iconFor(name: string, kind: IconKind, expanded = false): string {
    const lower = name.toLowerCase();
    if (kind === 'directory') {
        const folder = FOLDER_NAMES.get(lower);
        if (folder) {
            return expanded ? `${folder}-open` : folder;
        }
        return expanded ? DEFAULT_FOLDER_OPEN_ICON : DEFAULT_FOLDER_ICON;
    }
    const byName = FILE_NAMES.get(lower);
    if (byName) {
        return byName;
    }
    if (lower.startsWith('tsconfig.') && lower.endsWith('.json')) {
        return 'tsconfig'; // tsconfig.base.json, tsconfig.node.json, ...
    }
    // From the longest extension to the shortest; a leading dot (".bashrc")
    // is part of the name, not an extension.
    let dot = lower.indexOf('.', 1);
    while (dot !== -1) {
        const icon = EXTENSIONS.get(lower.slice(dot + 1));
        if (icon) {
            return icon;
        }
        dot = lower.indexOf('.', dot + 1);
    }
    return DEFAULT_FILE_ICON;
}

/** Every icon the tables can return: the SVGs `public/file-icons/` must hold. */
export function bundledIconNames(): string[] {
    const names = new Set<string>([DEFAULT_FILE_ICON, DEFAULT_FOLDER_ICON, DEFAULT_FOLDER_OPEN_ICON, 'tsconfig']);
    for (const icon of [...EXTENSIONS.values(), ...FILE_NAMES.values()]) {
        names.add(icon);
    }
    for (const folder of FOLDER_NAMES.values()) {
        names.add(folder);
        names.add(`${folder}-open`);
    }
    for (const icon of LIGHT_VARIANTS) {
        names.add(`${icon}_light`);
    }
    return [...names].sort();
}

/** The icon's URL, relative to the renderer's index.html (served from the app, never a CDN). */
export function iconUrl(name: string): string {
    return `./file-icons/${name}.svg`;
}

/** The class that shows an icon (names are `[a-z0-9_-]`, so they are valid class names as they are). */
export function iconClass(name: string): string {
    return `fi-${name}`;
}

/**
 * One rule per icon, `.fi-<name>` setting its SVG as the background, plus the
 * light-theme variants under `prefers-color-scheme: light`. The renderer
 * adopts it once; the sizing lives with the other workbench styles.
 */
export function fileIconStyleSheet(): string {
    const rules = bundledIconNames()
        .filter((name) => !name.endsWith('_light'))
        .map((name) => `.${iconClass(name)} { background-image: url("${iconUrl(name)}"); }`);
    const light = [...LIGHT_VARIANTS].map((name) => `  .${iconClass(name)} { background-image: url("${iconUrl(`${name}_light`)}"); }`);
    return [...rules, '@media (prefers-color-scheme: light) {', ...light, '}'].join('\n');
}
