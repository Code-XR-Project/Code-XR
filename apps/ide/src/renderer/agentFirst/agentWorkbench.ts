import type { AgentSessionMessage, AgentSessionsApi, AgentSessionState, InstallProgress } from '../../shared/agentSession.ts';
import type { AttachmentSources } from '../agents/chatAttachments.ts';
import type { CommandRegistry } from '../commands/commandRegistry.ts';
import type { CustomEditorInput } from '../editor/customEditor.ts';
import type { EditorGroup } from '../editor/editorGroup.ts';
import type { NotificationCenter } from '../notifications.ts';
import type { Workbench } from '../workbench.ts';
import { el } from '../dom.ts';
import { createChatView, type ChatView, type ChatViewDeps } from './chatView.ts';
import { createSessionsView, type SessionsView } from './sessionsView.ts';
import { createInstructionsView, type InstructionsViewDeps } from './instructionsView.ts';
import { chatIdOf, chatTabId, parseLayoutMode, type LayoutMode } from './agentWorkbenchModel.ts';
import { createGettingStartedView, type GettingStartedView } from './gettingStartedView.ts';
import { ONBOARDED_KEY, progressTitle, shouldShowOnboarding } from './agentSetupModel.ts';
import { errorText as setupErrorText } from './agentSetup.ts';
import './agentFirst.css';

/**
 * The agent-first workbench (epic #265), installed by main.ts on top of the
 * classic one:
 * - AF4 (#269): the Agent / Classic layout modes. Agent keeps the Chats view
 *   on the left and the live analysis column on the right (the scene, or a
 *   placeholder until one opens); Classic is the workbench as it was. The
 *   choice is remembered; Ctrl/Cmd+Alt+M switches.
 * - AF7 (#272): the Chats view (sessionsView.ts) and notifications when a
 *   chat that is not on screen finishes or needs an approval.
 * - AF3 (#268): every chat is an editor tab (`chat:<sessionId>`) through the
 *   editor group's custom-editor seam, so chats sit next to files, split and
 *   come back after a restart.
 * - AF2 (#267): installs and removals of agents report as progress
 *   notifications.
 * - AF13 (#278): the first-run guide, in the editor area's welcome view on a
 *   first run, or as a tab (`guide:getting-started`) from the command palette.
 */

export interface AgentWorkbenchOptions {
    readonly workbench: Workbench;
    readonly api: AgentSessionsApi;
    readonly registry: CommandRegistry;
    readonly notifications: NotificationCenter;
    readonly attachments: AttachmentSources;
    editorGroup(): Promise<EditorGroup>;
    openFile(path: string, line?: number): void;
    copy(text: string): void;
    onStatus(message: string): void;
    /** Opens a recent folder in this window (resolves once it is open). */
    openProject(root: string): Promise<void>;
    showTerminal(): void;
    /** Runs the XR analysis of the open folder (the dock's button). */
    analyseProject(): void;
    /** Whether a folder is open in this window. */
    hasFolder(): boolean;
    /** Asks for a folder to open in this window (File > Open Folder). */
    openFolder(): void;
    /** The workspace calls the project instructions section needs (AF11). */
    readonly instructions: Omit<InstructionsViewDeps, 'openFile' | 'hasFolder' | 'onStatus'>;
    /** Optional hooks of later stories. */
    readonly chatHooks?: Pick<ChatViewDeps, 'restoreCheckpoint' | 'openChanges' | 'decorateTurn'>;
}

export interface AgentWorkbench {
    readonly sessions: SessionsView;
    openChat(sessionId: string): Promise<void>;
    newChat(agentRef?: string): Promise<void>;
    setMode(mode: LayoutMode): void;
    readonly mode: LayoutMode;
    /** The folder of the window changed: chats of the old folder close, the list reloads. */
    folderChanged(): void;
}

const MODE_KEY = 'codexr.layout.mode';
const GUIDE_TAB_ID = 'guide:getting-started';
const DOCK_ART = 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5';

export function installAgentWorkbench(options: AgentWorkbenchOptions): AgentWorkbench {
    const { workbench, api } = options;
    const views = new Set<ChatView>();
    let activeChatId: string | null = null;
    let mode: LayoutMode = readMode();

    // ---- Dock placeholder (AF8) --------------------------------------------
    const analyse = el('button', { className: 'primary-button', text: 'Analyse this project', attrs: { type: 'button', 'data-testid': 'af-dock-analyse' } });
    analyse.addEventListener('click', () => options.analyseProject());
    const dockNote = el('p', { className: 'muted' });
    const art = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    art.setAttribute('viewBox', '0 0 24 24');
    art.setAttribute('class', 'af-dock-art');
    art.setAttribute('aria-hidden', 'true');
    const artPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    artPath.setAttribute('d', DOCK_ART);
    art.append(artPath);
    const hideDock = el('button', { className: 'icon-button', text: '×', attrs: { type: 'button', title: 'Hide the live analysis column', 'aria-label': 'Hide the live analysis column' } });
    hideDock.addEventListener('click', () => setDockHidden(true));
    workbench.dockArea.replaceChildren(
        el('header', { className: 'af-dock-head' }, [el('span', { text: 'Live analysis' }), el('span', { className: 'af-live', text: 'Waiting', attrs: { 'data-state': 'idle' } }), el('span', { className: 'af-spacer' }), hideDock]),
        el('div', { className: 'af-dock-body' }, [art, el('h3', { text: 'See your project change while the AI works' }), dockNote, analyse]),
    );
    function renderDock(): void {
        const folder = options.hasFolder();
        dockNote.textContent = folder
            ? 'The XR scene of this project appears here and follows every file the agent changes. It starts on its own when a folder opens, once the analysis environment is ready.'
            : 'Open a folder to analyse it. Its XR scene, LivePanel or dependency graph stays in this column while you chat with the agent.';
        analyse.hidden = !folder;
    }
    function setDockHidden(hidden: boolean): void {
        const shell = workbench.dockArea.parentElement;
        shell?.classList.toggle('dock-hidden', hidden);
    }

    // ---- Chats as editor tabs (AF3) ----------------------------------------
    function chatDeps(): ChatViewDeps {
        return {
            api,
            attachments: options.attachments,
            openFile: options.openFile,
            copy: options.copy,
            onStatus: options.onStatus,
            onDidChange: (state) => {
                for (const view of views) {
                    if (view.sessionId === state.id) {
                        titleSetters.get(view)?.(state.title);
                    }
                }
            },
            ...options.chatHooks,
        };
    }
    const titleSetters = new WeakMap<ChatView, (title: string) => void>();
    const tabClosers = new Map<string, () => void>();

    function chatInput(sessionId: string, title = 'Chat'): CustomEditorInput {
        return {
            id: chatTabId(sessionId),
            title,
            iconName: 'chat.md',
            create(context) {
                const view = createChatView(sessionId, chatDeps());
                // A restored tab whose chat was deleted (here or in another window) closes itself.
                api.get(sessionId).catch((error: unknown) => {
                    if (/That chat no longer exists/.test(errorText(error))) {
                        context.close();
                    }
                });
                views.add(view);
                titleSetters.set(view, (next) => context.setTitle(next));
                tabClosers.set(sessionId, () => context.close());
                return {
                    element: view.element,
                    onShow: () => {
                        activeChatId = sessionId;
                        sessions.setActive(sessionId);
                        api.markRead(sessionId).catch(() => undefined);
                    },
                    onHide: () => {
                        if (activeChatId === sessionId) {
                            activeChatId = null;
                            sessions.setActive(null);
                        }
                    },
                    focus: () => view.focus(),
                    dispose: () => {
                        view.dispose();
                        views.delete(view);
                        tabClosers.delete(sessionId);
                    },
                };
            },
        };
    }

    void options.editorGroup().then((group) => {
        group.registerCustomEditor((id) => {
            if (id === GUIDE_TAB_ID) {
                return guideInput();
            }
            const sessionId = chatIdOf(id);
            return sessionId ? chatInput(sessionId) : null;
        });
    });

    async function openChat(sessionId: string): Promise<void> {
        const group = await options.editorGroup();
        let title = 'Chat';
        try {
            title = (await api.get(sessionId)).title;
        } catch {
            // The view reports the error itself.
        }
        await group.openCustom(chatInput(sessionId, title), { preview: false });
    }

    // ---- Chats view (AF7) and project instructions (AF11) ------------------
    const instructions = createInstructionsView({ ...options.instructions, openFile: (path) => options.openFile(path), hasFolder: options.hasFolder, onStatus: options.onStatus });
    const sessions = createSessionsView(workbench.chatsView, {
        api,
        openChat: (id) => void openChat(id),
        openChatInProject: (root, id) => {
            options.openProject(root).then(() => openChat(id)).catch((error: unknown) => options.onStatus(errorText(error)));
        },
        openProject: (root) => {
            options.openProject(root).catch((error: unknown) => options.onStatus(errorText(error)));
        },
        activeChat: () => activeChatId,
        onStatus: options.onStatus,
        mode: () => mode,
        setMode,
        showTerminal: options.showTerminal,
        extraSections: [instructions.element],
        openBuiltinAgents: () => workbench.showView('agents'),
        onRemoved: (id) => tabClosers.get(id)?.(),
        onAttention: (counts) => {
            const parts = [];
            if (counts.running > 0) {
                parts.push(`${counts.running} working`);
            }
            if (counts.waiting > 0) {
                parts.push(`${counts.waiting} waiting for you`);
            }
            attention.textContent = parts.length ? `Agents: ${parts.join(', ')}` : '';
            attention.hidden = parts.length === 0;
        },
    });
    const attention = el('button', { className: 'status-item', attrs: { type: 'button', hidden: '', 'data-testid': 'af-attention', title: 'Show the chats' } });
    attention.addEventListener('click', () => workbench.showView('chats'));
    workbench.editorStatus.parentElement?.prepend(attention);

    // ---- Messages from the main process -------------------------------------
    const lastSeen = new Map<string, AgentSessionState['status']>();
    api.onMessage((message: AgentSessionMessage) => {
        if (message.kind === 'install-progress') {
            installProgress(message);
            return;
        }
        for (const view of views) {
            view.handle(message);
        }
        sessions.handle(message);
        notifyIfHidden(message);
        if (message.kind === 'sessions-changed') {
            refreshHasChat();
        }
    });

    // ---- Installing agents (AF2) --------------------------------------------
    function installProgress(progress: InstallProgress): void {
        const name = sessions.agents().find((agent) => agent.preset === progress.presetId)?.name ?? progress.presetId;
        const key = `agent-install-${progress.presetId}`;
        if (!progress.done) {
            options.notifications.progress(key, { title: progressTitle(progress, name), message: progress.line });
            return;
        }
        options.notifications.endProgress(key);
        if (progress.error) {
            options.notifications.notify('error', progress.action === 'install' ? `${name} could not be installed.` : `${name} could not be removed.`, { detail: progress.error });
        } else {
            options.notifications.notify('info', progress.action === 'install' ? `${name} is installed. Sign in or start a chat.` : `${name} was removed.`);
        }
    }

    // ---- First run (AF13) ---------------------------------------------------
    const guides = new Set<GettingStartedView>();
    let hasChat = false;
    let inlineGuide: GettingStartedView | null = null;
    let closeGuideTab: (() => void) | null = null;
    const readOnboarded = (): string | null => {
        try {
            return localStorage.getItem(ONBOARDED_KEY);
        } catch {
            return null;
        }
    };
    function finishGuide(): void {
        try {
            localStorage.setItem(ONBOARDED_KEY, 'true');
        } catch {
            // Without storage the guide may show again; nothing else depends on it.
        }
        inlineGuide?.element.remove();
        if (inlineGuide) {
            guides.delete(inlineGuide);
            inlineGuide = null;
        }
        closeGuideTab?.();
    }
    function createGuide(): GettingStartedView {
        return createGettingStartedView({
            setup: {
                api,
                onStatus: options.onStatus,
                showTerminal: options.showTerminal,
                refresh: (probe) => sessions.refreshAgents(probe),
                replace: () => void sessions.refreshAgents(false),
            },
            hasFolder: options.hasFolder,
            hasChat: () => hasChat,
            agents: () => sessions.agents(),
            openFolder: options.openFolder,
            startChat: async (ref) => {
                const before = hasChat;
                await sessions.newChat(ref);
                await refreshHasChat();
                if (hasChat && !before) {
                    finishGuide();
                }
            },
            skip: finishGuide,
        });
    }
    function guideInput(): CustomEditorInput {
        return {
            id: GUIDE_TAB_ID,
            title: 'Getting Started',
            iconName: 'guide.md',
            create(context) {
                const guide = createGuide();
                guides.add(guide);
                closeGuideTab = () => context.close();
                return {
                    element: el('div', { className: 'af-guide-tab' }, [guide.element]),
                    onShow: () => guide.render(),
                    dispose: () => {
                        guides.delete(guide);
                        closeGuideTab = null;
                    },
                };
            },
        };
    }
    function renderGuides(): void {
        for (const guide of guides) {
            guide.render();
        }
    }
    async function refreshHasChat(): Promise<void> {
        try {
            hasChat = (await api.listProjects()).some((project) => project.sessions.length > 0);
        } catch {
            // Keeps the last answer.
        }
        renderGuides();
    }
    async function showGettingStarted(): Promise<void> {
        const group = await options.editorGroup();
        group.openCustom(guideInput(), { preview: false });
    }
    sessions.onAgentsChange(() => renderGuides());
    // The guide opens on its own only on a first run: never once done or skipped, never for someone with chats.
    void refreshHasChat().then(() => {
        if (!shouldShowOnboarding(readOnboarded(), hasChat)) {
            return;
        }
        const welcome = workbench.editorArea.querySelector<HTMLElement>('[data-testid="welcome"]');
        if (welcome?.isConnected) {
            inlineGuide = createGuide();
            guides.add(inlineGuide);
            welcome.append(inlineGuide.element);
        } else {
            void showGettingStarted();
        }
    });

    function notifyIfHidden(message: AgentSessionMessage): void {
        if (message.kind !== 'event') {
            return;
        }
        const { sessionId, event } = message;
        const visible = activeChatId === sessionId && document.hasFocus();
        if (event.type === 'permission' && !visible) {
            notify(sessionId, 'warning', 'An agent is waiting for your approval.');
        } else if (event.type === 'turn-end' && !visible && event.stopReason !== 'cancelled') {
            notify(sessionId, event.stopReason === 'error' ? 'error' : 'info', event.stopReason === 'error' ? 'An agent\'s turn failed.' : 'An agent finished.');
        }
        if (event.type === 'status') {
            lastSeen.set(sessionId, event.status);
        }
    }

    function notify(sessionId: string, severity: 'info' | 'warning' | 'error', fallback: string): void {
        api.get(sessionId).then((state) => {
            options.notifications.notify(severity, `${state.title}: ${fallback.replace(/^An agent/, state.agentName)}`, {
                actions: [{ label: 'Open chat', run: () => void openChat(sessionId) }],
            });
        }).catch(() => options.notifications.notify(severity, fallback));
    }

    // ---- Layout mode (AF4) --------------------------------------------------
    function setMode(next: LayoutMode): void {
        mode = next;
        try {
            localStorage.setItem(MODE_KEY, next);
        } catch {
            // Remembering the mode is a convenience.
        }
        workbench.setLayoutMode(next);
        if (next === 'agent') {
            setDockHidden(false);
            workbench.showView('chats');
        }
        sessions.setActive(activeChatId);
        renderDock();
    }

    options.registry.register({ id: 'layout.toggleAgentMode', category: 'View', title: 'Toggle Agent / Classic Layout', keybinding: 'CmdOrCtrl+Alt+M', run: () => setMode(mode === 'agent' ? 'classic' : 'agent') });
    options.registry.register({ id: 'layout.agentMode', category: 'View', title: 'Agent Layout (Chats, Work Area, Live Analysis)', run: () => setMode('agent') });
    options.registry.register({ id: 'layout.classicMode', category: 'View', title: 'Classic Layout', run: () => setMode('classic') });
    options.registry.register({ id: 'chat.new', category: 'Chat', title: 'New Chat', keybinding: 'CmdOrCtrl+Shift+L', run: () => void sessions.newChat() });
    options.registry.register({ id: 'chat.showGettingStarted', category: 'Chat', title: 'Show Getting Started', run: () => {
        showGettingStarted().catch((error: unknown) => options.onStatus(setupErrorText(error)));
    } });
    options.registry.register({ id: 'chat.showChats', category: 'Chat', title: 'Show Chats', run: () => workbench.showView('chats') });
    options.registry.register({ id: 'chat.searchChats', category: 'Chat', title: 'Search Chats', run: () => {
        workbench.showView('chats');
        sessions.focusSearch();
    } });
    options.registry.register({ id: 'layout.toggleLiveAnalysis', category: 'View', title: 'Toggle Live Analysis Column', run: () => {
        const shell = workbench.dockArea.parentElement;
        setDockHidden(!shell?.classList.contains('dock-hidden'));
    } });

    setMode(mode);
    instructions.refresh().catch(() => undefined);

    return {
        sessions,
        openChat,
        newChat: (agentRef?: string) => sessions.newChat(agentRef),
        setMode,
        get mode() {
            return mode;
        },
        folderChanged(): void {
            renderDock();
            renderGuides();
            if (mode === 'agent') {
                workbench.showView('chats');
            }
            sessions.refresh().catch(() => undefined);
            instructions.refresh().catch(() => undefined);
        },
    };
}

function readMode(): LayoutMode {
    try {
        return parseLayoutMode(localStorage.getItem(MODE_KEY));
    } catch {
        return parseLayoutMode(null);
    }
}

function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

