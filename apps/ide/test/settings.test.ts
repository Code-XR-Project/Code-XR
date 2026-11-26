import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    cleanSettings, formatSettingsFile, parseSettingsFile, resolveSettings, SETTINGS, settingOf, stripJsonComments, validSettingValue,
} from '../src/shared/settings.ts';
import { FOLDER_SETTINGS_PATH, memoryStorage, SettingsService } from '../src/main/settings/settingsService.ts';
import { Workspace } from '../src/main/workspace/workspace.ts';
import { matchesFilter, parseControlValue, settingRows } from '../src/renderer/settings/settingsModel.ts';

describe('settings schema (#18)', () => {
    it('has unique keys and defaults its own validator accepts', () => {
        assert.equal(new Set(SETTINGS.map((setting) => setting.key)).size, SETTINGS.length);
        for (const setting of SETTINGS) {
            assert.equal(validSettingValue(setting.key, setting.default), setting.default, setting.key);
        }
    });

    it('accepts only values of the right shape', () => {
        assert.equal(validSettingValue('editor.fontSize', 16), 16);
        assert.equal(validSettingValue('editor.fontSize', 16.5), undefined);
        assert.equal(validSettingValue('editor.fontSize', 500), undefined);
        assert.equal(validSettingValue('editor.fontSize', '16'), undefined);
        assert.equal(validSettingValue('editor.wordWrap', 'on'), 'on');
        assert.equal(validSettingValue('editor.wordWrap', 'sometimes'), undefined);
        assert.equal(validSettingValue('editor.minimap.enabled', 'false'), undefined);
        assert.equal(validSettingValue('editor.fontFamily', 'x'.repeat(301)), undefined);
        assert.equal(validSettingValue('no.such.setting', true), undefined);
        assert.deepEqual(cleanSettings({ 'editor.fontSize': 15, 'editor.wordWrap': 7, other: 1 }), { 'editor.fontSize': 15 });
        assert.deepEqual(cleanSettings([1, 2]), {});
    });

    it('resolves folder over user over default', () => {
        const snapshot = resolveSettings({ 'editor.fontSize': 15, 'editor.tabSize': 2 }, { 'editor.fontSize': 18 });
        assert.equal(settingOf<number>(snapshot, 'editor.fontSize'), 18);
        assert.equal(settingOf<number>(snapshot, 'editor.tabSize'), 2);
        assert.equal(settingOf<boolean>(snapshot, 'editor.minimap.enabled'), true);
    });

    it('reads files with comments and trailing commas, and says when it cannot', () => {
        const text = '{\n  // bigger\n  "editor.fontSize": 16, /* block */\n  "editor.fontFamily": "a // not a comment, }",\n}\n';
        assert.deepEqual(parseSettingsFile(text), { values: { 'editor.fontSize': 16, 'editor.fontFamily': 'a // not a comment, }' }, error: null });
        assert.equal(stripJsonComments('["a\\"//b",]'), '["a\\"//b"]');
        assert.notEqual(parseSettingsFile('{ nope').error, null);
        assert.deepEqual(parseSettingsFile('   ').values, {});
        assert.equal(formatSettingsFile({ b: 1, a: true }), '{\n    "a": true,\n    "b": 1\n}\n');
    });
});

describe('SettingsService (#18)', () => {
    let root = '';
    before(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-ide-settings-'));
    });
    after(() => fs.rmSync(root, { recursive: true, force: true }));

    it('stores user values, keeps unknown keys and refuses bad values', async () => {
        const storage = memoryStorage();
        await storage.write('{ "future.setting": 1 }');
        const service = new SettingsService(storage);
        const report = await service.update(null, 'user', 'editor.fontSize', 17);
        assert.equal(report.effective['editor.fontSize'], 17);
        assert.equal(report.folder, null);
        assert.deepEqual(JSON.parse((await storage.read()) ?? ''), { 'editor.fontSize': 17, 'future.setting': 1 });
        await assert.rejects(service.update(null, 'user', 'editor.fontSize', 'big'));
        await assert.rejects(service.update(null, 'user', 'no.such', 1));
        await assert.rejects(service.update(null, 'elsewhere', 'editor.fontSize', 12));
        await assert.rejects(service.update(null, 'folder', 'editor.fontSize', 12));
        const removed = await service.update(null, 'user', 'editor.fontSize', null);
        assert.equal(removed.effective['editor.fontSize'], 13);
    });

    it('writes the folder file inside the folder and lets it win', async () => {
        const workspace = await Workspace.open(root);
        const service = new SettingsService(memoryStorage());
        await service.update(workspace, 'user', 'editor.tabSize', 8);
        const report = await service.update(workspace, 'folder', 'editor.tabSize', 2);
        assert.equal(report.effective['editor.tabSize'], 2);
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.codexr', 'settings.json'), 'utf8')), { 'editor.tabSize': 2 });
        assert.equal(await service.ensureFolderFile(workspace), FOLDER_SETTINGS_PATH);
    });

    it('reports an unreadable folder file and does not overwrite it', async () => {
        const workspace = await Workspace.open(root);
        fs.writeFileSync(path.join(root, '.codexr', 'settings.json'), '{ broken');
        const service = new SettingsService(memoryStorage());
        const report = await service.snapshot(workspace);
        assert.equal(report.errors.length, 1);
        assert.equal(report.effective['editor.tabSize'], 4);
        await assert.rejects(service.update(workspace, 'folder', 'editor.tabSize', 2));
        assert.equal(fs.readFileSync(path.join(root, '.codexr', 'settings.json'), 'utf8'), '{ broken');
    });
});

describe('Settings view rows (#18)', () => {
    const snapshot = resolveSettings({ 'editor.fontSize': 15 }, { 'editor.tabSize': 2 });

    it('marks what each scope sets and explains what wins', () => {
        const user = settingRows(snapshot, 'user', '').flatMap((group) => group.rows);
        const fontSize = user.find((row) => row.setting.key === 'editor.fontSize');
        const tabSize = user.find((row) => row.setting.key === 'editor.tabSize');
        assert.deepEqual([fontSize?.value, fontSize?.modified, fontSize?.note], [15, true, null]);
        assert.equal(tabSize?.modified, false);
        assert.match(tabSize?.note ?? '', /folder sets its own value/);
        const folder = settingRows(snapshot, 'folder', '').flatMap((group) => group.rows);
        const inherited = folder.find((row) => row.setting.key === 'editor.fontSize');
        assert.deepEqual([inherited?.value, inherited?.modified], [15, false]);
        assert.match(inherited?.note ?? '', /user setting applies/);
    });

    it('filters on every word and groups by category', () => {
        const groups = settingRows(snapshot, 'user', 'font size');
        assert.deepEqual(groups.map((group) => group.category), ['Editor', 'Terminal']);
        assert.equal(matchesFilter(SETTINGS[0] ?? SETTINGS[1]!, 'zzz'), false);
    });

    it('turns control text into a typed value', () => {
        const fontSize = SETTINGS.find((setting) => setting.key === 'editor.fontSize')!;
        assert.equal(parseControlValue(fontSize, '14'), 14);
        assert.equal(parseControlValue(fontSize, '14.5'), null);
        assert.equal(parseControlValue(fontSize, ''), null);
        assert.equal(parseControlValue(fontSize, '99'), null);
    });
});
