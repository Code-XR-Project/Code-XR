import { crc32, deflateRawSync } from 'node:zlib';

/**
 * A minimal zip writer for the tests (#254): enough to build `.vsix` files,
 * including malicious ones the real packager would never produce (`..`
 * entries, absolute paths, symbolic links).
 */
export interface ZipEntry {
    readonly name: string;
    readonly data?: string | Buffer;
    /** Unix mode in the external attributes (0o120777 for a symbolic link). */
    readonly mode?: number;
}

export function zip(entries: readonly ZipEntry[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const entry of entries) {
        const name = Buffer.from(entry.name, 'utf8');
        const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
        const compressed = deflateRawSync(raw);
        const crc = crc32(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(raw.length, 22);
        local.writeUInt16LE(name.length, 26);
        locals.push(local, name, compressed);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE((3 << 8) | 20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(raw.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(((entry.mode ?? (entry.name.endsWith('/') ? 0o040755 : 0o100644)) << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, name);
        offset += 30 + name.length + compressed.length;
    }
    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, ...centrals, end]);
}

/** A `.vsix` of an extension: `files` are paths inside `extension/`. */
export function vsix(manifest: Record<string, unknown>, files: Record<string, string> = {}): Buffer {
    return zip([
        { name: '[Content_Types].xml', data: '<Types/>' },
        { name: 'extension/package.json', data: JSON.stringify(manifest) },
        ...Object.entries(files).map(([name, data]) => ({ name: `extension/${name}`, data })),
    ]);
}
