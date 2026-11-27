import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOST_METHODS, MAIN_METHODS, RpcEndpoint, type HostInitData, type UiNotification } from '../src/shared/extensionHostProtocol.ts';
import { codiconName, commandLink, parseViewRequest, parseWelcome, splitIcons, type TreeItemData, type ViewNotification } from '../src/shared/extensionViewsProtocol.ts';
import type { ContributedCommand, ContributedMenuItem } from '../src/shared/extensions.ts';
import { evaluateWhen, parseWhen, whenHolds } from '../src/shared/whenClause.ts';
import { ContributionIndex, menuGroup } from '../src/main/extensions/contributions.ts';
import type { ExtensionManifest } from '../src/main/extensions/manifest.ts';
import type { LoadedExtension } from '../src/main/extensions/extensionStore.ts';
import { inlineIcon, inlineTreeIcons } from '../src/main/extensions/viewIcons.ts';
import { ContextKeys, platformContext } from '../src/renderer/extensions/contextKeys.ts';
import { fileUriOf, guessLanguageId, menuGroups, resourceContext, splitActions } from '../src/renderer/extensions/menuModel.ts';

const HOST_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'extensionHost', 'index.ts');

let tmp = '';
before(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codexr-views-test-')));
});
after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('when clauses (#261)', () => {
    const context: Record<string, unknown> = {
        view: 'npm.scripts', viewItem: 'script-debug', resourceLangId: 'typescript', count: 3, enabled: true, off: false,
        list: ['a', 'b'], map: { x: 1 }, name: 'a', version: '1.2', empty: '',
    };
    const holds = (clause: string): boolean => whenHolds(clause, (key) => context[key]);

    it('reads keys, negation, and/or with precedence and parentheses', () => {
        assert.ok(holds(''));
        assert.ok(holds('enabled'));
        assert.ok(!holds('off'));
        assert.ok(!holds('missing'));
        assert.ok(holds('!missing'));
        assert.ok(holds('enabled && !off'));
        assert.ok(holds('off || enabled'));
        assert.ok(holds('off && missing || enabled'), '&& binds tighter than ||');
        assert.ok(!holds('off && (missing || enabled)'));
        assert.ok(holds('true') && !holds('false'));
    });

    it('compares, matches regexes and looks into arrays and objects', () => {
        assert.ok(holds('view == npm.scripts'));
        assert.ok(holds("view == 'npm.scripts'"));
        assert.ok(holds('view === npm.scripts'));
        assert.ok(holds('view != other'));
        assert.ok(holds('enabled == true'));
        assert.ok(holds('count == 3') && holds('count >= 3') && holds('count > 2') && !holds('count < 3'));
        assert.ok(holds('version >= 1.1'));
        assert.ok(holds('viewItem =~ /^script/'));
        assert.ok(holds('viewItem =~ /DEBUG$/i'));
        assert.ok(!holds('viewItem =~ /^folder/'));
        assert.ok(holds('name in list') && !holds('name not in list'));
        assert.ok(holds("'x' in map") === false, 'the left side of in is a key, not a literal');
        assert.ok(holds('view == npm.scripts && viewItem =~ /script/ && resourceLangId == typescript'));
    });

    it('treats a clause that does not parse as false', () => {
        assert.equal(parseWhen('a &&'), null);
        assert.equal(parseWhen('(a'), null);
        assert.equal(parseWhen("a == 'open"), null);
        assert.ok(!holds('a &&'));
        assert.ok(!holds('viewItem =~ /[/'), 'an invalid regex matches nothing');
        const node = parseWhen('!(a || b)');
        assert.ok(node && evaluateWhen(node, () => undefined));
    });
});

describe('views protocol helpers (#261)', () => {
    it('checks every renderer request field by field', () => {
        assert.deepEqual(parseViewRequest({ kind: 'treeChildren', viewId: 'v', handle: null }), { kind: 'treeChildren', viewId: 'v', handle: null });
        assert.deepEqual(parseViewRequest({ kind: 'treeCommand', viewId: 'v', command: 'c', handle: 'h', selected: ['h'] }), { kind: 'treeCommand', viewId: 'v', command: 'c', handle: 'h', selected: ['h'] });
        assert.equal(parseViewRequest({ kind: 'treeChildren', viewId: '', handle: null }), null);
        assert.equal(parseViewRequest({ kind: 'treeClick', viewId: 'v', handle: 5 }), null);
        assert.equal(parseViewRequest({ kind: 'treeCommand', viewId: 'v', command: 'c', handle: 'h', selected: [1] }), null);
        assert.equal(parseViewRequest({ kind: 'treeSelection', viewId: 'v', handles: new Array(1001).fill('h') }), null);
        assert.equal(parseViewRequest({ kind: 'viewVisibility', viewId: 'v', visible: 'yes' }), null);
        assert.equal(parseViewRequest({ kind: 'nope', viewId: 'v' }), null);
        assert.equal(parseViewRequest(null), null);
    });

    it('reads welcome content, command links and icon references', () => {
        assert.deepEqual(parseWelcome('No scripts found.\n[Run Script](command:npm.runScript)\nRead [the docs](https://example.com) first.'), [
            { kind: 'text', parts: [{ text: 'No scripts found.' }] },
            { kind: 'button', label: 'Run Script', target: 'command:npm.runScript' },
            { kind: 'text', parts: [{ text: 'Read ' }, { label: 'the docs', target: 'https://example.com' }, { text: ' first.' }] },
        ]);
        assert.deepEqual(commandLink('command:a.b'), { command: 'a.b', args: [] });
        assert.deepEqual(commandLink(`command:a.b?${encodeURIComponent(JSON.stringify(['x', 1]))}`), { command: 'a.b', args: ['x', 1] });
        assert.deepEqual(commandLink(`command:a.b?${encodeURIComponent('{"k":1}')}`), { command: 'a.b', args: [{ k: 1 }] });
        assert.equal(commandLink('https://x'), null);
        assert.equal(codiconName('$(refresh)'), 'refresh');
        assert.equal(codiconName('$(sync~spin)'), 'sync');
        assert.equal(codiconName('icons/a.svg'), null);
        assert.deepEqual(splitIcons('$(check) Done $(x)'), [{ icon: 'check' }, { text: ' Done ' }, { icon: 'x' }]);
    });
});

function fakeExtension(location: string, id: string, contributes: Record<string, unknown>, main: string | null = 'index.js'): LoadedExtension {
    const [publisher, name] = id.split('.') as [string, string];
    const manifest = { id, publisher, name, version: '1.0.0', displayName: name, description: '', engine: '^1.80.0', main, browser: null, icon: null, categories: [], license: null, repository: null, activationEvents: [], extensionDependencies: [], extensionPack: [], contributes, supportsUntrusted: false, raw: {} } satisfies ExtensionManifest;
    return { manifest, location, record: {} as LoadedExtension['record'], enabled: true };
}

describe('view and menu contributions (#261)', () => {
    it('reads view containers, views, welcome content and menus, with their icons', () => {
        const location = path.join(tmp, 'acme.todo');
        fs.mkdirSync(path.join(location, 'media'), { recursive: true });
        fs.writeFileSync(path.join(location, 'media', 'todo.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M1 1h14v14H1z"/></svg>');
        fs.writeFileSync(path.join(location, 'media', 'big.png'), Buffer.alloc(300 * 1024));
        const warnings: string[] = [];
        const index = new ContributionIndex([fakeExtension(location, 'acme.todo', {
            commands: [
                { command: 'todo.refresh', title: 'Refresh', icon: '$(refresh)' },
                { command: 'todo.open', title: { value: 'Open', original: 'Open' }, category: 'Todo', icon: { light: 'media/todo.svg', dark: 'media/todo.svg' }, enablement: 'todo.ready' },
                { command: 'todo.big', title: 'Big', icon: 'media/big.png' },
                { command: 'todo.hidden', title: 'Hidden' },
            ],
            viewsContainers: { activitybar: [{ id: 'todo-tree', title: 'Todo', icon: 'media/todo.svg' }, { id: 'explorer', title: 'Bad' }], panel: [{ id: 'todo-panel', title: 'Todo Panel', icon: '$(checklist)' }] },
            views: {
                'todo-tree': [{ id: 'todo.list', name: 'Todos', when: 'todo.enabled' }, { id: 'todo.web', name: 'Web', type: 'webview', visibility: 'collapsed' }],
                explorer: [{ id: 'todo.explorer', name: 'Todo Files' }],
                'nowhere-container': [{ id: 'todo.lost', name: 'Lost' }],
            },
            viewsWelcome: [{ view: 'todo.list', contents: 'Nothing yet.\n[Scan](command:todo.refresh)', when: 'workspaceFolderCount > 0' }],
            menus: {
                commandPalette: [{ command: 'todo.hidden', when: 'false' }, { command: 'todo.open', when: 'todo.ready' }],
                'view/title': [{ command: 'todo.refresh', when: 'view == todo.list', group: 'navigation@2' }],
                'view/item/context': [{ command: 'todo.open', when: 'viewItem == file', group: 'inline' }, { submenu: 'todo.more', group: 'navigation' }],
                'scm/title': [{ command: 'todo.refresh' }],
            },
        })], (message) => warnings.push(message));
        const c = index.contributions;
        assert.deepEqual(c.viewContainers.map((container) => [container.id, container.title, container.icon?.kind]), [['todo-tree', 'Todo', 'image'], ['todo-panel', 'Todo Panel', 'codicon']]);
        const svg = c.viewContainers[0]?.icon;
        assert.ok(svg?.kind === 'image' && svg.light.startsWith('data:image/svg+xml;base64,'), 'icons reach the renderer as data URLs');
        assert.deepEqual(c.views.map((view) => [view.id, view.container, view.type, view.when, view.collapsed]), [
            ['todo.list', 'todo-tree', 'tree', 'todo.enabled', false],
            ['todo.web', 'todo-tree', 'webview', null, true],
            ['todo.explorer', 'explorer', 'tree', null, false],
        ]);
        assert.ok(warnings.some((warning) => warning.includes('"explorer"')), 'a container may not take a built-in id');
        assert.ok(warnings.some((warning) => warning.includes('todo.lost')), 'a view in an unknown container is reported');
        assert.deepEqual(c.viewsWelcome, [{ extensionId: 'acme.todo', view: 'todo.list', contents: 'Nothing yet.\n[Scan](command:todo.refresh)', when: 'workspaceFolderCount > 0' }]);
        assert.deepEqual(c.menus.map((item) => [item.menu, item.command, item.group, item.order]), [['view/title', 'todo.refresh', 'navigation', 2], ['view/item/context', 'todo.open', 'inline', 0]]);
        const byId = new Map(c.commands.map((command) => [command.command, command]));
        assert.deepEqual(byId.get('todo.refresh')?.icon, { kind: 'codicon', name: 'refresh' });
        assert.equal(byId.get('todo.open')?.icon?.kind, 'image');
        assert.equal(byId.get('todo.open')?.enablement, 'todo.ready');
        assert.equal(byId.get('todo.open')?.paletteWhen, 'todo.ready');
        assert.equal(byId.get('todo.big')?.icon, null, 'an icon over the size limit is not inlined');
        assert.equal(byId.get('todo.hidden')?.hiddenFromPalette, true);
        assert.deepEqual(menuGroup('1_edit@-3'), { group: '1_edit', order: -3 });
        assert.deepEqual(menuGroup(undefined), { group: '', order: 0 });
    });

    it('does not read menus of an extension without code, nor an icon outside the extension', () => {
        const location = path.join(tmp, 'acme.theme');
        fs.mkdirSync(location, { recursive: true });
        fs.writeFileSync(path.join(tmp, 'outside.svg'), '<svg/>');
        const index = new ContributionIndex([fakeExtension(location, 'acme.theme', {
            menus: { 'view/title': [{ command: 'x' }] },
            viewsContainers: { activitybar: [{ id: 'side', title: 'Side', icon: '../outside.svg' }] },
            views: { side: [{ id: 'side.view', name: 'Side view' }] },
        }, null)]);
        assert.deepEqual(index.contributions.menus, []);
        assert.equal(index.contributions.viewContainers[0]?.icon, null);
        assert.equal(index.contributions.views.length, 1, 'a view needs no code (welcome content only)');
    });
});

describe('tree icons from files (#261)', () => {
    it('reads only images inside the allowed folders, as data URLs', () => {
        const root = path.join(tmp, 'icons');
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        fs.writeFileSync(path.join(tmp, 'secret.png'), Buffer.from([1, 2, 3]));
        fs.writeFileSync(path.join(root, 'notes.txt'), 'not an image');
        const cache = new Map<string, string | null>();
        assert.deepEqual(inlineIcon({ kind: 'iconFile', file: path.join(root, 'a.png') }, [root], cache), { kind: 'image', light: 'data:image/png;base64,iVBORw==', dark: 'data:image/png;base64,iVBORw==' });
        assert.equal(inlineIcon({ kind: 'iconFile', file: path.join(tmp, 'secret.png') }, [root], cache), undefined, 'outside the roots');
        assert.equal(inlineIcon({ kind: 'iconFile', file: path.join(root, '..', 'secret.png') }, [root], cache), undefined, 'no climbing out');
        assert.equal(inlineIcon({ kind: 'iconFile', file: path.join(root, 'notes.txt') }, [root], cache), undefined, 'not an image type');
        assert.deepEqual(inlineIcon({ kind: 'codicon', name: 'x' }, [root], cache), { kind: 'codicon', name: 'x' });
        const result = inlineTreeIcons({ items: [{ handle: 'a', icon: { kind: 'iconFile', file: path.join(tmp, 'secret.png') } }, { handle: 'b', icon: { kind: 'iconFile', file: path.join(root, 'a.png') } }] }, [root], cache) as { items: TreeItemData[] };
        assert.equal(result.items[0]?.icon, undefined);
        assert.equal(result.items[1]?.icon?.kind, 'image');
    });
});

describe('menus and context keys in the workbench (#261)', () => {
    const commands: ContributedCommand[] = [
        { extensionId: 'a.b', command: 'x.refresh', title: 'Refresh', category: null, hiddenFromPalette: false, paletteWhen: null, enablement: null, icon: { kind: 'codicon', name: 'refresh' } },
        { extensionId: 'a.b', command: 'x.delete', title: 'Delete', category: null, hiddenFromPalette: false, paletteWhen: null, enablement: 'canDelete', icon: null },
        { extensionId: 'a.b', command: 'x.rename', title: 'Rename', category: null, hiddenFromPalette: false, paletteWhen: null, enablement: null, icon: null },
    ];
    const item = (menu: string, command: string, group: string, order = 0, when: string | null = null, extensionId = 'a.b'): ContributedMenuItem => ({ extensionId, menu, command, when, group, order });

    it('groups and orders a menu, keeping only what applies', () => {
        const items = [
            item('view/item/context', 'x.delete', '9_cutcopypaste', 2),
            item('view/item/context', 'x.rename', '9_cutcopypaste', 1),
            item('view/item/context', 'x.refresh', 'inline', 0, 'viewItem == folder'),
            item('view/item/context', 'x.refresh', 'navigation', 0, 'view == other'),
            item('view/item/context', 'x.rename', 'navigation', 0, 'view == list'),
            item('view/item/context', 'x.refresh', '', 0, null, 'off.ext'),
            item('view/title', 'x.refresh', 'navigation'),
        ];
        const keys = new ContextKeys();
        const groups = menuGroups('view/item/context', items, commands, keys.lookup({ view: 'list', viewItem: 'folder' }), (id) => id === 'a.b');
        assert.deepEqual(groups.map((group) => [group.group, group.actions.map((action) => action.command)]), [
            ['navigation', ['x.rename']],
            ['inline', ['x.refresh']],
            ['9_cutcopypaste', ['x.rename', 'x.delete']],
        ]);
        assert.equal(groups[2]?.actions[1]?.enabled, false, '`enablement` greys an entry out');
        keys.set('canDelete', true);
        assert.equal(menuGroups('view/item/context', items, commands, keys.lookup({ view: 'list' }))[1]?.actions[1]?.enabled, true);
        const { primary, secondary } = splitActions(groups, 'inline');
        assert.deepEqual(primary.map((action) => action.command), ['x.refresh']);
        assert.deepEqual(secondary.map((group) => group.group), ['9_cutcopypaste']);
    });

    it('answers keys from setContext, the workbench providers, then the per-menu extras', async () => {
        const keys = new ContextKeys();
        keys.addProvider(platformContext('win32'));
        keys.addProvider((key) => (key === 'workspaceFolderCount' ? 1 : undefined));
        let heard = 0;
        keys.onDidChange(() => heard++);
        keys.set('todo.ready', true);
        keys.set('todo.count', 3);
        await Promise.resolve();
        assert.equal(heard, 1, 'changes in one task are heard once');
        const lookup = keys.lookup({ view: 'x' });
        assert.ok(whenHolds('isWindows && !isMac && workspaceFolderCount == 1 && todo.ready && todo.count > 2 && view == x', lookup));
        keys.set('todo.ready', undefined);
        keys.clear();
        assert.ok(!whenHolds('todo.ready || todo.count', keys.lookup()));
    });

    it('describes a file for explorer and editor menus', () => {
        assert.deepEqual(resourceContext('src/app.test.ts', 'typescript'), {
            resource: 'src/app.test.ts', resourcePath: 'src/app.test.ts', resourceScheme: 'file', resourceFilename: 'app.test.ts', resourceDirname: 'src',
            resourceExtname: '.ts', resourceLangId: 'typescript', explorerResourceIsFolder: false,
        });
        assert.equal(guessLanguageId('docs/README.md'), 'markdown');
        assert.equal(guessLanguageId('Dockerfile'), 'dockerfile');
        assert.equal(guessLanguageId('a.unknown'), null);
        assert.equal(fileUriOf('/home/me/ws', 'src/a b.ts'), 'file:///home/me/ws/src/a%20b.ts');
        assert.equal(fileUriOf('C:\\Users\\me\\ws\\', 'a#.ts'), 'file:///C:/Users/me/ws/a%23.ts');
    });
});

const TREE_JS = `
const vscode = require('vscode');
const path = require('path');
exports.activate = (context) => {
    const changed = new vscode.EventEmitter();
    const data = { roots: ['alpha', 'beta'], children: { alpha: ['a1', 'a2'], beta: [] } };
    const calls = [];
    const provider = {
        onDidChangeTreeData: changed.event,
        getChildren: (element) => (element ? data.children[element] || [] : data.roots),
        getTreeItem: (element) => {
            const isGroup = Array.isArray(data.children[element]);
            const item = new vscode.TreeItem(element, isGroup ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
            item.contextValue = isGroup ? 'group' : 'leaf';
            item.tooltip = new vscode.MarkdownString('**' + element + '**');
            if (element === 'alpha') {
                item.iconPath = new vscode.ThemeIcon('beaker', new vscode.ThemeColor('charts.red'));
                item.description = 'two items';
            }
            if (element === 'a1') {
                item.iconPath = vscode.Uri.file(path.join(__dirname, 'leaf.svg'));
                item.command = { command: 'tree.open', title: 'Open', arguments: [element, 42] };
            }
            if (element === 'a2') {
                item.resourceUri = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'src', 'a2.ts'));
                item.iconPath = vscode.ThemeIcon.File;
                item.id = 'stable-a2';
            }
            return item;
        },
        getParent: (element) => (element === 'a1' || element === 'a2' ? 'alpha' : undefined),
    };
    const view = vscode.window.createTreeView('acme.tree', { treeDataProvider: provider, showCollapseAll: true, canSelectMany: true });
    view.onDidChangeSelection((event) => calls.push(['selection', ...event.selection]));
    view.onDidChangeVisibility((event) => calls.push(['visible', event.visible]));
    view.onDidExpandElement((event) => calls.push(['expand', event.element]));
    context.subscriptions.push(
        view,
        vscode.commands.registerCommand('tree.open', (...args) => calls.push(['open', ...args])),
        vscode.commands.registerCommand('tree.remove', (element, all) => calls.push(['remove', element, all])),
        vscode.commands.registerCommand('tree.calls', () => calls),
        vscode.commands.registerCommand('tree.add', () => { data.roots.push('gamma'); changed.fire(); }),
        vscode.commands.registerCommand('tree.touch', () => changed.fire('alpha')),
        vscode.commands.registerCommand('tree.reveal', () => view.reveal('a2', { focus: true, select: true })),
        vscode.commands.registerCommand('tree.meta', () => { view.title = 'Tasks'; view.message = 'Two left'; view.badge = { value: 2, tooltip: '2 tasks' }; }),
    );
    vscode.window.registerTreeDataProvider('acme.second', { getChildren: () => [1, 2], getTreeItem: (n) => ({ label: 'n' + n }) });
};
`;

describe('tree views in the extension host (#261)', () => {
    let child: ChildProcess;
    let main: RpcEndpoint;
    let workspace = '';
    let extensionFolder = '';
    const views: ViewNotification[] = [];

    const waitFor = async <T>(probe: () => T | undefined, what: string): Promise<T> => {
        for (let attempt = 0; attempt < 200; attempt++) {
            const value = probe();
            if (value !== undefined) {
                return value;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`Timed out waiting for ${what}`);
    };
    const children = (viewId: string, handle: string | null): Promise<{ items: TreeItemData[] } | null> => main.request(HOST_METHODS.view, { kind: 'treeChildren', viewId, handle });
    const calls = (): Promise<unknown[][]> => main.request(HOST_METHODS.executeCommand, 'tree.calls', []);

    before(async () => {
        workspace = path.join(tmp, 'tree-ws');
        fs.mkdirSync(path.join(workspace, 'src'), { recursive: true });
        extensionFolder = path.join(tmp, 'extensions', 'acme.tree-1.0.0');
        fs.mkdirSync(extensionFolder, { recursive: true });
        const packageJSON = { publisher: 'acme', name: 'tree', version: '1.0.0', main: 'index.js', engines: { vscode: '^1.80.0' }, activationEvents: ['onView:acme.tree'], contributes: { views: { explorer: [{ id: 'acme.tree', name: 'Tree' }] } } };
        fs.writeFileSync(path.join(extensionFolder, 'package.json'), JSON.stringify(packageJSON));
        fs.writeFileSync(path.join(extensionFolder, 'index.js'), TREE_JS);

        child = fork(HOST_ENTRY, [], { execArgv: ['--experimental-strip-types', '--no-warnings'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' });
        child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[host stderr] ${chunk.toString()}`));
        main = new RpcEndpoint((message) => child.send(message));
        child.on('message', (message) => main.receive(message));
        main.handle(MAIN_METHODS.log, () => undefined);
        main.handle(MAIN_METHODS.activation, () => undefined);
        main.handle(MAIN_METHODS.notImplemented, () => undefined);
        main.handle(MAIN_METHODS.uiNotify, (notification) => {
            const typed = notification as UiNotification;
            if (typed.kind === 'view') {
                views.push(typed.notification);
            }
        });
        main.handle(MAIN_METHODS.ui, () => null);
        const init: HostInitData = {
            extensions: [{ id: 'acme.tree', location: extensionFolder, main: 'index.js', packageJSON, activationEvents: ['onView:acme.tree'], extensionDependencies: [] }],
            passive: [],
            workspaceFolder: workspace,
            trusted: true,
            configuration: {},
            globalStorageRoot: path.join(tmp, 'tree-storage'),
            workspaceStorageRoot: null,
            logRoot: path.join(tmp, 'tree-logs'),
            env: { appName: 'Code-XR IDE', appRoot: tmp, appHost: 'desktop', language: 'en', machineId: 'm', sessionId: 's', uriScheme: 'codexr', shell: '/bin/sh', version: '0.0.0' },
            isDevelopment: false,
            documents: [],
            activeEditor: null,
        };
        await main.request(HOST_METHODS.init, init);
    });

    after(() => {
        if (child.exitCode === null) {
            child.kill();
        }
    });

    it('activates the extension on onView when the view first asks for its roots, and announces the tree', async () => {
        const roots = await children('acme.tree', null);
        assert.deepEqual(roots?.items.map((item) => [item.label, item.collapsible, item.contextValue]), [['alpha', 1, 'group'], ['beta', 1, 'group']]);
        const registered = views.find((notification) => notification.kind === 'treeRegistered' && notification.viewId === 'acme.tree');
        assert.deepEqual(registered, { kind: 'treeRegistered', viewId: 'acme.tree', extensionId: 'acme.tree', showCollapseAll: true, canSelectMany: true, manageCheckboxStateManually: false });
        assert.ok(views.some((notification) => notification.kind === 'treeRegistered' && notification.viewId === 'acme.second'), 'registerTreeDataProvider announces too');
        const alpha = roots?.items[0];
        assert.deepEqual(alpha?.icon, { kind: 'codicon', name: 'beaker', color: 'charts.red' });
        assert.equal(alpha?.description, 'two items');
        assert.equal(alpha?.tooltip, '**alpha**');
    });

    it('gives children by handle, with file icons, resources and commands kept in the host', async () => {
        const roots = await children('acme.tree', null);
        const alpha = roots?.items[0] as TreeItemData;
        const kids = await children('acme.tree', alpha.handle);
        assert.deepEqual(kids?.items.map((item) => item.label), ['a1', 'a2']);
        const [a1, a2] = kids?.items ?? [];
        // Windows: the host spells the drive in lower case, as `Uri.fsPath` does.
        assert.deepEqual(a1?.icon?.kind === 'iconFile' ? { ...a1.icon, file: a1.icon.file.toLowerCase() } : a1?.icon, { kind: 'iconFile', file: path.join(extensionFolder, 'leaf.svg').toLowerCase() });
        assert.equal(a1?.hasCommand, true);
        assert.equal(a2?.handle, 'i:stable-a2', 'an item id is its handle');
        assert.deepEqual(a2?.icon, { kind: 'file' });
        assert.equal(a2?.resourceName, 'a2.ts');
        assert.equal(a2?.resource?.path.toLowerCase(), path.join(workspace, 'src', 'a2.ts').toLowerCase());
        assert.deepEqual(await children('acme.tree', 'no-such-handle'), { items: [] });
        assert.equal(await children('nobody.view', null), null, 'a view without a provider answers null');

        await main.request(HOST_METHODS.view, { kind: 'treeClick', viewId: 'acme.tree', handle: a1?.handle });
        await main.request(HOST_METHODS.view, { kind: 'treeCommand', viewId: 'acme.tree', command: 'tree.remove', handle: a1?.handle, selected: [a1?.handle, a2?.handle] });
        await main.request(HOST_METHODS.view, { kind: 'treeSelection', viewId: 'acme.tree', handles: [a2?.handle] });
        await main.request(HOST_METHODS.view, { kind: 'treeExpand', viewId: 'acme.tree', handle: alpha.handle, expanded: true });
        await main.request(HOST_METHODS.view, { kind: 'viewVisibility', viewId: 'acme.tree', visible: true });
        assert.deepEqual(await calls(), [['open', 'a1', 42], ['remove', 'a1', ['a1', 'a2']], ['selection', 'a2'], ['expand', 'alpha'], ['visible', true]]);
    });

    it('keeps handles across refreshes and tells the workbench what changed', async () => {
        const before = await children('acme.tree', null);
        views.length = 0;
        await main.request(HOST_METHODS.executeCommand, 'tree.add', []);
        await main.request(HOST_METHODS.executeCommand, 'tree.touch', []);
        assert.deepEqual(views, [{ kind: 'treeChanged', viewId: 'acme.tree', handles: null }, { kind: 'treeChanged', viewId: 'acme.tree', handles: [before?.items[0]?.handle] }]);
        const after = await children('acme.tree', null);
        assert.deepEqual(after?.items.map((item) => item.label), ['alpha', 'beta', 'gamma']);
        assert.equal(after?.items[0]?.handle, before?.items[0]?.handle);
    });

    it('reveals through getParent, and passes title, message and badge', async () => {
        views.length = 0;
        await main.request(HOST_METHODS.executeCommand, 'tree.reveal', []);
        await main.request(HOST_METHODS.executeCommand, 'tree.meta', []);
        const roots = await children('acme.tree', null);
        const reveal = await waitFor(() => views.find((notification) => notification.kind === 'treeReveal'), 'the reveal');
        assert.deepEqual(reveal, { kind: 'treeReveal', viewId: 'acme.tree', path: [roots?.items[0]?.handle, 'i:stable-a2'], select: true, focus: true, expand: 0 });
        const meta = views.filter((notification) => notification.kind === 'viewMeta');
        assert.deepEqual(meta, [
            { kind: 'viewMeta', viewId: 'acme.tree', title: 'Tasks' },
            { kind: 'viewMeta', viewId: 'acme.tree', message: 'Two left' },
            { kind: 'viewMeta', viewId: 'acme.tree', badge: { value: 2, tooltip: '2 tasks' } },
        ]);
    });
});
