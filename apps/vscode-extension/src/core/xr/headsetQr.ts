import qrcode from 'qrcode-generator';

/**
 * #19: the QR code of the address a standalone headset opens to join a
 * scene, shared by the VS Code extension (a webview) and the Code-XR IDE
 * (its scene header). Pure and vscode-free: one SVG path, a 1x1 square per
 * dark module, inside the 4-module quiet zone scanners expect.
 */
export interface QrDrawing {
    /** The side of the square viewBox, modules plus the quiet zone. */
    readonly size: number;
    readonly path: string;
}

const QUIET_ZONE = 4;

export function qrDrawing(text: string): QrDrawing {
    const code = qrcode(0, 'M');
    code.addData(text);
    code.make();
    const count = code.getModuleCount();
    const parts: string[] = [];
    for (let row = 0; row < count; row++) {
        for (let col = 0; col < count; col++) {
            if (code.isDark(row, col)) {
                parts.push(`M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
            }
        }
    }
    return { size: count + QUIET_ZONE * 2, path: parts.join('') };
}

function escapeXml(text: string): string {
    return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * The same code as standalone SVG markup, black on white whatever the theme,
 * for a page that is written as HTML (the extension's webview). The text only
 * ever lands in an escaped attribute.
 */
export function qrSvgMarkup(text: string, pixels = 240): string {
    const drawing = qrDrawing(text);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${drawing.size} ${drawing.size}" width="${pixels}" height="${pixels}" `
        + `shape-rendering="crispEdges" role="img" aria-label="QR code of ${escapeXml(text)}">`
        + `<rect width="${drawing.size}" height="${drawing.size}" fill="#fff"/><path d="${drawing.path}" fill="#000"/></svg>`;
}
