import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

/**
 * Monaco for the IDE (#14). The workers are bundled by Vite and served from
 * the app's own origin, so the CSP's `worker-src 'self'` holds; nothing is
 * fetched from a CDN. Syntax highlighting covers Monaco's built-in languages;
 * JSON, CSS, HTML and TypeScript/JavaScript also get their language services.
 */
globalThis.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
        switch (label) {
            case 'json': return new JsonWorker();
            case 'css': case 'scss': case 'less': return new CssWorker();
            case 'html': case 'handlebars': case 'razor': return new HtmlWorker();
            case 'typescript': case 'javascript': return new TsWorker();
            default: return new EditorWorker();
        }
    },
};

// Each file is opened on its own, without the project's tsconfig or
// node_modules, so semantic checks would flag every import as unresolved.
// Syntax errors are still reported; project-aware checking is later work.
for (const defaults of [monaco.typescript.typescriptDefaults, monaco.typescript.javascriptDefaults]) {
    defaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
}

/** #257: a colour theme of an extension, defined by extensions/themeController.ts; it wins over the OS scheme. */
let themeOverride: string | null = null;
const systemQuery = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = (): void => monaco.editor.setTheme(themeOverride ?? (systemQuery.matches ? 'vs-dark' : 'vs'));
let following = false;

/** Light or dark, following the operating system like the rest of the workbench (or an extension's theme, #257). */
export function followSystemTheme(): void {
    applyTheme();
    if (!following) {
        following = true;
        systemQuery.addEventListener('change', applyTheme);
    }
}

/** #257: uses a theme defined with `monaco.editor.defineTheme`, or null to follow the OS again. */
export function setThemeOverride(name: string | null): void {
    themeOverride = name;
    applyTheme();
}

export { monaco };
