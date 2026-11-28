'use strict';

// The bind address is the extension's every-interface default unless a host
// (the Code-XR IDE) restricts it to loopback (COLLAB-IDE-2).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..', '..');
const bind = require(path.join(projectRoot, 'out', 'core', 'server', 'serverBindHost.js'));

test('servers listen on every interface by default and on loopback once a host asks', () => {
    assert.equal(bind.getServerBindHost(), '0.0.0.0');
    bind.setServerBindHost('127.0.0.1');
    assert.equal(bind.getServerBindHost(), '127.0.0.1');
    bind.setServerBindHost('0.0.0.0');

    const launcher = fs.readFileSync(path.join(projectRoot, 'src', 'core', 'server', 'multiServerLauncher.ts'), 'utf8');
    assert.match(launcher, /const host = getServerBindHost\(\);/);
});
