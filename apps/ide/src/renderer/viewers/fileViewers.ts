import type { CodeXRApi } from '../../shared/api.ts';
import { el } from '../dom.ts';
import type { CustomEditorResolver, CustomEditorView } from '../editor/customEditor.ts';
import { extensionOf, isSchemeId, VIEWER_IMAGE_EXTENSIONS } from '../editor/customEditorRegistry.ts';
import { createImageView } from './imageViewer.ts';

/**
 * #256: the built-in file viewers as a custom-editor resolver: a `.pdf` opens
 * in the PDF viewer, a raster image in the image viewer, anything else is
 * left to the text editor. The id of a viewer tab is the file's path, so a
 * saved session and a rename treat it like any file. pdf.js is loaded on the
 * first PDF only, so a window that never opens one never pays for it.
 */
export function fileViewerResolver(workspace: Pick<CodeXRApi['workspace'], 'readImage' | 'readDocument'>): CustomEditorResolver {
    return (id) => {
        if (isSchemeId(id)) {
            return null; // another kind of tab (chat:...), not a workspace path
        }
        const extension = extensionOf(id);
        const title = id.slice(id.lastIndexOf('/') + 1);
        if (extension === 'pdf') {
            return {
                id, title, filePath: id,
                create: () => lazyView(import('./pdfViewer.ts').then((module) => module.createPdfView(id, (path) => workspace.readDocument(path)))),
            };
        }
        if (VIEWER_IMAGE_EXTENSIONS.has(extension)) {
            return { id, title, filePath: id, create: () => createImageView(id, (path) => workspace.readImage(path)) };
        }
        return null;
    };
}

/** A view whose module is still loading: a holder element now, the real view inside it once it arrives. */
function lazyView(loading: Promise<CustomEditorView>): CustomEditorView {
    const element = el('div', { className: 'viewer-lazy' });
    let view: CustomEditorView | null = null;
    let shown = false;
    let disposed = false;
    let wantsFocus = false;
    loading.then((loaded) => {
        if (disposed) {
            loaded.dispose?.();
            return;
        }
        view = loaded;
        element.replaceChildren(loaded.element);
        if (shown) {
            loaded.onShow?.();
        }
        if (wantsFocus) {
            loaded.focus?.();
        }
    }).catch((error: unknown) => {
        element.replaceChildren(el('div', { className: 'viewer-message muted', text: `The viewer could not start: ${error instanceof Error ? error.message : String(error)}` }));
    });
    return {
        element,
        onShow: () => { shown = true; view?.onShow?.(); },
        onHide: () => { shown = false; view?.onHide?.(); },
        focus: () => { wantsFocus = true; view?.focus?.(); },
        fileChanged: (state) => view?.fileChanged?.(state),
        dispose: () => { disposed = true; view?.dispose?.(); },
    };
}
