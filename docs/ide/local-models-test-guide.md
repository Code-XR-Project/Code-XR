# Manual test guide: local models (epic #310)

For the person verifying epic #310 by hand (Windows first, then Linux/macOS if available). About 20 minutes. Each step says what to do and what you should see. Note the step number of anything that differs.

## Before you start

1. Install **Ollama** (https://ollama.com/download) and pull two models from a terminal:
   ```
   ollama pull qwen2.5-coder:7b
   ollama pull gemma:2b
   ```
   `qwen2.5-coder` calls tools; `gemma:2b` does not (it is used in step 9). Leave Ollama running (tray icon on Windows).
2. Build and start the IDE from the `ide` branch: `npm ci`, then `npm run ide:dev` (or `npm start --workspace=code-xr-ide`).
3. Open a small project folder you do not mind being edited (a copy), with a few source files, and **Trust** it.

## Add a local model

| # | Do | Expected |
|---|---|---|
| 1 | Chats view > **Agents** > **Add local model** | A form opens in place: Detect, Server (Ollama), Address `http://127.0.0.1:11434/v1`, Model, Name, API key. |
| 2 | Press **Detect** | "Ollama on 127.0.0.1:11434: 2 models" with one button per model, showing size and parameters (e.g. `qwen2.5-coder:7b (7.6B, 4.7 GB)`). |
| 3 | Click `qwen2.5-coder:7b` | Server, Address and Model are filled; the Name placeholder reads `qwen2.5-coder:7b (Ollama)`. |
| 4 | Press **Add** | The form closes; `qwen2.5-coder:7b (Ollama)` appears in Agents with **Added**, a description "... on Ollama (127.0.0.1:11434). Runs on your own machine..." and **Check / Edit / Remove**. It is also in the picker next to **New chat**. |
| 5 | Press **Check** on it | The badge turns **Ready** after a moment. |

## Chat with it

| # | Do | Expected |
|---|---|---|
| 6 | Pick it next to **New chat**, press **New chat**, ask: *What does this project do? Look at the files first.* | Tool cards appear (**List the project folder**, **Read** a file...) and an answer streams in. The chat header shows the agent name and **Ready**. |
| 7 | Ask: *Add a short docstring to the first function of <a file>.* | An **Edit** card with the diff appears and a permission card **Allow / Always allow edits in this chat / Reject**. The file is unchanged on disk until you choose. |
| 8 | Press **Allow** | The file changes; **Changes (1)** appears in the chat header and the live analysis on the right re-analyses the file. **Changes** lets you keep or undo it. |
| 9 | Ask it to run the tests or `git status` | A **Run ...** permission card; after **Allow**, a terminal card shows the output and the exit code. |
| 10 | Analyse the project (right column, **Analyse this project**), start a **new** chat and ask *Which files are the most complex?* | A `code-xr: get_hotspots` (or `get_metrics`) card, then an answer based on Code-XR's numbers. |
| 11 | In the chat, **Model** menu: pick `gemma:2b` and ask anything about a file | A note in italics says the model cannot call tools on this server and it answers as a plain chat. Switch back to `qwen2.5-coder:7b`: tools work again. |
| 12 | **Mode** menu: **Accept edits**, ask for another small edit | The edit is applied without a permission card (still listed in **Changes**). Commands still ask. |
| 13 | While it is answering, press **Stop** | It stops within a second or two; the chat is usable again. |

## Errors and edits

| # | Do | Expected |
|---|---|---|
| 14 | Quit Ollama (tray > Quit), then send a message in the chat | A clear error: "Ollama is not answering on 127.0.0.1:11434 (connection refused). Start Ollama (the app, or `ollama serve`) and pull a model...". **Check** shows the same reason. Start Ollama again: the next message works. |
| 15 | **Edit** the local model: change the Name, press **List models** | The model list comes back in the Model field's suggestions; **Save** renames the entry. |
| 16 | Add a model with server **Other OpenAI-compatible server** and address `http://example.org/v1` | Refused: "Plain http is only allowed for this computer or your local network; use https for anything else." |
| 17 | (Optional) LM Studio: start its server with a model loaded, **Detect** | "LM Studio on 127.0.0.1:1234: 1 model"; adding and chatting work as above. |
| 18 | **Remove** the local model | It leaves the list and the picker; Ollama still has the model. |

## What to report

The step number, what you saw, and a screenshot. If a model answers badly but the IDE behaves as described, that is the model, not a bug: try `qwen2.5-coder:14b` or `qwen3` if your machine can run them.
