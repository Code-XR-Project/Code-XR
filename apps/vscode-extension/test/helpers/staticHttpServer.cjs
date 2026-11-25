'use strict';
// Serves a folder over HTTP on 127.0.0.1 for the browser harnesses.
// Loaded from file://, Chromium blocks every fetch() (CORS), so the mode
// harnesses never loaded their datasets: they only checked panel routing over
// empty modes, and a mode whose data could not load looked "ready". Over HTTP
// the dependency, comparison and evolution data really load.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.glb': 'model/gltf-binary',
};

/**
 * @param {string} rootDir folder served at '/'
 * @returns {Promise<{ url: (relativePath: string) => string, close: () => Promise<void> }>}
 */
function startStaticServer(rootDir) {
    const root = path.resolve(rootDir);
    const server = http.createServer((request, response) => {
        let pathname;
        try {
            pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        } catch {
            response.writeHead(400);
            response.end();
            return;
        }
        const filePath = path.resolve(root, '.' + pathname);
        if (filePath !== root && !filePath.startsWith(root + path.sep)) {
            response.writeHead(403);
            response.end();
            return;
        }
        fs.stat(filePath, (error, stats) => {
            if (error || !stats.isFile()) {
                response.writeHead(404);
                response.end();
                return;
            }
            response.writeHead(200, {
                'content-type': CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
                'cache-control': 'no-store',
            });
            fs.createReadStream(filePath).pipe(response);
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url(relativePath) {
                    const normalized = path.relative(root, path.resolve(root, relativePath)).split(path.sep).join('/');
                    return `http://127.0.0.1:${port}/${normalized}`;
                },
                close() {
                    server.closeAllConnections?.();
                    return new Promise((done) => server.close(() => done()));
                },
            });
        });
    });
}

module.exports = { startStaticServer };
