import fs from 'node:fs';
import path from 'node:path';
import yauzl from 'yauzl';
import { isSafeRelativePath } from './manifest.ts';

/**
 * Reading and unpacking a `.vsix` (#254). A VSIX is a zip whose `extension/`
 * folder is the extension; the rest (`[Content_Types].xml`,
 * `extension.vsixmanifest`) is packaging. Archives are untrusted input, so
 * every entry is checked before a byte is written: it must sit under
 * `extension/`, be a relative path with no `..`, drive letter or NUL, not be
 * a symbolic link, and the archive must stay inside the entry and size
 * limits (a zip bomb stops at the limit, not at the disk).
 */

export const VSIX_LIMITS = {
    maxEntries: 30_000,
    maxFileBytes: 256 * 1024 * 1024,
    maxTotalBytes: 768 * 1024 * 1024,
};

export class VsixError extends Error {}

const PREFIX = 'extension/';

interface Entry {
    readonly name: string;
    readonly relative: string;
    readonly isDirectory: boolean;
    readonly size: number;
    readonly raw: yauzl.Entry;
}

/** Whether a zip entry's Unix mode (high 16 bits of the external attributes) is a symbolic link. */
export function isSymlinkEntry(externalFileAttributes: number): boolean {
    const mode = (externalFileAttributes >>> 16) & 0o170000;
    return mode === 0o120000;
}

/**
 * The path an entry unpacks to, relative to the extension folder, or null
 * for packaging files outside `extension/`. Throws for anything unsafe.
 */
export function vsixEntryPath(name: string): string | null {
    if (name.includes('\\') || name.includes('\0')) {
        throw new VsixError(`Unsafe path in the archive: ${JSON.stringify(name)}`);
    }
    if (!name.startsWith(PREFIX)) {
        if (name.startsWith('/') || name.split('/').includes('..')) {
            throw new VsixError(`Unsafe path in the archive: ${JSON.stringify(name)}`);
        }
        return null;
    }
    const relative = name.slice(PREFIX.length).replace(/\/$/, '');
    if (relative === '') {
        return '';
    }
    if (!isSafeRelativePath(relative) || relative.split('/').some((segment) => segment === '' || segment === '.')) {
        throw new VsixError(`Unsafe path in the archive: ${JSON.stringify(name)}`);
    }
    return relative;
}

function open(file: string): Promise<yauzl.ZipFile> {
    return new Promise((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
            if (error || !zip) {
                reject(new VsixError(`Not a valid .vsix (zip) file: ${error?.message ?? 'unknown error'}`));
            } else {
                resolve(zip);
            }
        });
    });
}

function listEntries(zip: yauzl.ZipFile): Promise<Entry[]> {
    return new Promise((resolve, reject) => {
        const entries: Entry[] = [];
        let total = 0;
        const fail = (error: Error): void => {
            zip.close();
            reject(error);
        };
        zip.on('error', (error: Error) => fail(new VsixError(`Broken archive: ${error.message}`)));
        zip.on('entry', (raw: yauzl.Entry) => {
            try {
                if (entries.length >= VSIX_LIMITS.maxEntries) {
                    throw new VsixError(`The archive has more than ${VSIX_LIMITS.maxEntries} files.`);
                }
                const relative = vsixEntryPath(raw.fileName);
                if (relative !== null) {
                    if (isSymlinkEntry(raw.externalFileAttributes)) {
                        throw new VsixError(`The archive contains a symbolic link: ${raw.fileName}`);
                    }
                    if (raw.uncompressedSize > VSIX_LIMITS.maxFileBytes) {
                        throw new VsixError(`A file in the archive is too large: ${raw.fileName}`);
                    }
                    total += raw.uncompressedSize;
                    if (total > VSIX_LIMITS.maxTotalBytes) {
                        throw new VsixError('The archive unpacks to more than the allowed size.');
                    }
                    entries.push({ name: raw.fileName, relative, isDirectory: raw.fileName.endsWith('/'), size: raw.uncompressedSize, raw });
                }
                zip.readEntry();
            } catch (error) {
                fail(error as Error);
            }
        });
        zip.on('end', () => resolve(entries));
        zip.readEntry();
    });
}

function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        zip.openReadStream(entry, (error, stream) => {
            if (error || !stream) {
                reject(new VsixError(`Cannot read ${entry.fileName}: ${error?.message ?? ''}`));
                return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > VSIX_LIMITS.maxFileBytes) {
                    stream.destroy(new VsixError(`A file in the archive is too large: ${entry.fileName}`));
                    return;
                }
                chunks.push(chunk);
            });
            stream.on('error', reject);
            stream.on('end', () => resolve(Buffer.concat(chunks)));
        });
    });
}

/** The VSIX's files read into memory by name (for the manifest and its translations). */
export interface VsixPreview {
    readonly packageJson: string;
    readonly nlsJson: string | null;
}

/** Reads `extension/package.json` (and `package.nls.json`) without unpacking anything. */
export async function readVsixManifest(file: string): Promise<VsixPreview> {
    const zip = await open(file);
    try {
        const entries = await listEntries(zip);
        const find = (relative: string): Entry | undefined => entries.find((entry) => entry.relative === relative && !entry.isDirectory);
        const pkg = find('package.json');
        if (!pkg) {
            throw new VsixError('The archive has no extension/package.json: it is not a VS Code extension.');
        }
        const nls = find('package.nls.json');
        return {
            packageJson: (await readEntry(zip, pkg.raw)).toString('utf8'),
            nlsJson: nls ? (await readEntry(zip, nls.raw)).toString('utf8') : null,
        };
    } finally {
        zip.close();
    }
}

/**
 * Unpacks the `extension/` folder of a VSIX into `target`, which must not
 * exist yet. Writes into a sibling temporary folder first and renames it at
 * the end, so a failed unpack leaves nothing half-installed.
 */
export async function extractVsix(file: string, target: string): Promise<void> {
    if (fs.existsSync(target)) {
        throw new VsixError(`The folder already exists: ${target}`);
    }
    const temp = `${target}.partial-${process.pid}-${Date.now()}`;
    const zip = await open(file);
    try {
        const entries = await listEntries(zip);
        await fs.promises.mkdir(temp, { recursive: true });
        const root = path.resolve(temp);
        for (const entry of entries) {
            if (entry.relative === '') {
                continue;
            }
            const destination = path.resolve(root, ...entry.relative.split('/'));
            // Belt and braces: vsixEntryPath already refused anything that could leave the folder.
            if (destination !== root && !destination.startsWith(root + path.sep)) {
                throw new VsixError(`Unsafe path in the archive: ${entry.name}`);
            }
            if (entry.isDirectory) {
                await fs.promises.mkdir(destination, { recursive: true });
                continue;
            }
            await fs.promises.mkdir(path.dirname(destination), { recursive: true });
            await fs.promises.writeFile(destination, await readEntry(zip, entry.raw), { flag: 'wx' });
        }
        await fs.promises.rename(temp, target);
    } catch (error) {
        await fs.promises.rm(temp, { recursive: true, force: true });
        throw error;
    } finally {
        zip.close();
    }
}
