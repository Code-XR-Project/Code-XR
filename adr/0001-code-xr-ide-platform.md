# ADR 0001: Build the Code-XR IDE on Electron + Monaco

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Adrián Montes Linares (@aMonteSl)
- **Context issues:** epic #7 "Choose the platform for the Code-XR IDE", evaluations #8 (Code-OSS fork), #9 (Eclipse Theia), #10 (Electron + Monaco)
- **Follow-up:** epic #11 "Migrate Code-XR from a VS Code extension to its own IDE (Electron + Monaco)" and its user stories

## Context

Code-XR ships today as a VS Code extension. Its roadmap (change prediction over Git history, a local LLM that explains risk, voice interaction inside XR) needs more control over the user interface and the runtime than the VS Code extension API gives: webviews, a sidebar tree and commands. Epic #7 chose the platform for that IDE, comparing three candidate platforms against five shared criteria.

What the current codebase brings to the decision:

- The **XR scene and the LivePanel are web content**: A-Frame / BabiaXR pages served by Code-XR's own local HTTP/HTTPS servers with SSE live reload (`src/servers/`, `templates/`).
- The **analysis engine is TypeScript on Node.js** and drives a **Python backend** (Lizard metrics) through a managed virtual environment (`src/code_analysis/`, `src/python_env/`).
- The coupling to the editor host is real but bounded: **179 TypeScript files import `vscode`**, about half of them under `src/code_analysis/` (87), then `views/` (23) and `servers/` (13). Most of these use the host for UI, configuration, output channels and file watching rather than for the analysis itself.

## Options considered

### 1. Fork of Code-OSS (#8)

Maximum compatibility: the extension would run almost unchanged and the UX is familiar. But Code-OSS releases monthly, and a fork that customises the workbench deeply has to merge each release by hand. Distribution also loses the Microsoft Marketplace (Open VSX instead). The maintenance cost is too high for a one-person research project, and the parts Code-XR wants to own (XR-first layout, voice, assistant) are exactly the parts a fork would have to patch.

### 2. Eclipse Theia (#9)

Built for making custom IDEs and can run VS Code extensions. But its VS Code API coverage is partial (webviews and tree views are the risky areas for Code-XR), the framework adds its own architecture to learn (dependency injection, frontend/backend extensions), and its community and ecosystem are smaller, which matters for a project that has to be maintained beyond the thesis.

### 3. Custom Electron app with Monaco (#10) — chosen

- **Chromium ships WebXR**, so the A-Frame / BabiaXR scenes run inside the IDE as they run in the browser today, and *Enter XR* keeps working, with no rewrite of the visualisation layer.
- **Node.js in the main process** runs the existing TypeScript analysis engine and launches the Python backend unchanged.
- **Monaco** provides the editor, and through the Language Server Protocol, language intelligence comparable to VS Code's.
- **Full control of the UI**: XR, LivePanel, voice and assistant can be first-class parts of the layout rather than webviews in someone else's workbench.
- **Licences**: Electron and Monaco are MIT, compatible with Code-XR's GPL-3.0.

A working preview validated the approach before the decision: a real Monaco editor, an A-Frame scene with live metrics, the LivePanel, a command palette and *Enter XR*, split across Electron's main / preload / renderer processes.

### Also discarded: a native shell (e.g. Tauri / Rust)

Smaller binaries, but it renders through the operating system's webview, where WebXR support is not reliable across platforms. That would put the core of Code-XR, the XR scene, at risk.

## Decision

Build the Code-XR IDE as a **custom Electron application around the Monaco editor**, reusing Code-XR's TypeScript analysis engine, Python backend, local servers and A-Frame / BabiaXR templates.

## Consequences

**Positive**

- The XR visualisation, LivePanel and servers are reused as they are.
- Code-XR owns the whole experience, which the thesis features need.
- No upstream fork to keep in sync.

**Negative / risks, and how they are handled**

- Features that VS Code gives for free have to be built: file explorer, tabs, terminal, Git, search, settings. *Mitigation:* scope a minimal MVP (open a project, edit, run an analysis, view it in XR) and add the rest in later phases.
- No VS Code extension ecosystem. *Accepted:* Code-XR is a focused environment, not a general-purpose editor.
- The 179 files coupled to `vscode` need an abstraction layer. *Mitigation:* extract a host-agnostic core behind a small host-adapter interface, so the **VS Code extension keeps working** on top of the same core while the IDE matures.
- Electron's security model must be configured deliberately (context isolation, sandboxed renderer, a narrow preload IPC surface, CSP). *Mitigation:* part of the scaffolding story, not an afterthought.
- Packaging, signing and auto-update per platform. *Mitigation:* a dedicated distribution story.
