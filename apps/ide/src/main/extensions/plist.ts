/**
 * A minimal reader for XML property lists, the format of `.tmTheme` colour
 * themes (#257): dict, array, string, integer, real, true, false. Enough for
 * TextMate themes; anything else reads as null. Pure, unit-tested.
 */

export type PlistValue = string | number | boolean | null | PlistValue[] | { [key: string]: PlistValue };

class Reader {
    private pos = 0;
    private readonly text: string;

    constructor(text: string) {
        this.text = text;
    }

    private skip(): void {
        for (;;) {
            const rest = this.text.slice(this.pos);
            const ws = /^\s+/.exec(rest);
            if (ws) {
                this.pos += ws[0].length;
                continue;
            }
            if (rest.startsWith('<?') || rest.startsWith('<!')) {
                const end = rest.startsWith('<!--') ? this.text.indexOf('-->', this.pos) + 3 : this.text.indexOf('>', this.pos) + 1;
                if (end <= this.pos) {
                    throw new Error('Unterminated declaration.');
                }
                this.pos = end;
                continue;
            }
            return;
        }
    }

    /** Reads the next tag: `{ name, close, selfClosing }`. */
    private tag(): { name: string; close: boolean; selfClosing: boolean } {
        this.skip();
        const match = /^<(\/?)([A-Za-z]+)[^>]*?(\/?)>/.exec(this.text.slice(this.pos));
        if (!match) {
            throw new Error(`Expected a tag at ${this.pos}.`);
        }
        this.pos += match[0].length;
        return { name: match[2] ?? '', close: match[1] === '/', selfClosing: match[3] === '/' };
    }

    private textUntil(name: string): string {
        const end = this.text.indexOf(`</${name}>`, this.pos);
        if (end < 0) {
            throw new Error(`Unterminated <${name}>.`);
        }
        const raw = this.text.slice(this.pos, end);
        this.pos = end + name.length + 3;
        return decode(raw);
    }

    document(): PlistValue {
        const open = this.tag();
        if (open.name !== 'plist') {
            return this.value(open);
        }
        const value = this.value(this.tag());
        return value;
    }

    private value(open: { name: string; close: boolean; selfClosing: boolean }): PlistValue {
        switch (open.name) {
            case 'dict': {
                const dict: { [key: string]: PlistValue } = {};
                if (open.selfClosing) {
                    return dict;
                }
                for (;;) {
                    const next = this.tag();
                    if (next.close && next.name === 'dict') {
                        return dict;
                    }
                    if (next.name !== 'key') {
                        throw new Error('Expected <key> in <dict>.');
                    }
                    const key = this.textUntil('key');
                    dict[key] = this.value(this.tag());
                }
            }
            case 'array': {
                const array: PlistValue[] = [];
                if (open.selfClosing) {
                    return array;
                }
                for (;;) {
                    const next = this.tag();
                    if (next.close && next.name === 'array') {
                        return array;
                    }
                    array.push(this.value(next));
                }
            }
            case 'string':
                return open.selfClosing ? '' : this.textUntil('string');
            case 'integer':
            case 'real': {
                const n = Number(this.textUntil(open.name));
                return Number.isFinite(n) ? n : null;
            }
            case 'true':
                return true;
            case 'false':
                return false;
            default:
                if (!open.selfClosing) {
                    this.textUntil(open.name);
                }
                return null;
        }
    }
}

function decode(raw: string): string {
    return raw
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
        .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, '\'').replace(/&amp;/g, '&');
}

export function parsePlist(text: string): PlistValue {
    return new Reader(text).document();
}
