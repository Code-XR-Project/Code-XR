import qrcode from 'qrcode-generator';

/**
 * #19: a QR code for the address a standalone headset opens, as one SVG
 * path (a 1x1 square per dark module) plus the quiet zone around it. Pure,
 * so it is unit-tested; the scene header draws it with DOM calls, never by
 * parsing markup.
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
