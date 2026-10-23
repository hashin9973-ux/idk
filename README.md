# ChatGPT Assistant Overlay

A compact, always-on-top Windows desktop app that embeds the real ChatGPT website and can collapse into a draggable orb. It now includes a local coding-tool backend, so ChatGPT can request actual workspace operations and receive their results inside the same conversation.

## What it includes

- A frameless ChatGPT window with a collapsible assistant orb.
- Global show/hide shortcut: Ctrl+Shift+Space.
- A selected local project workspace.
- Codex-style slash commands and a structured assistant_tool request protocol.
- Workspace listing, glob search, full-text search, file reads, atomic file writes, multi-file patches, Git status/diff, AGENTS.md initialization, test execution, and PowerShell execution.
- Native approval dialogs for file changes, patches, tests, PowerShell, and reads of secret-like files.
- Result return to the same ChatGPT conversation, allowing it to inspect actual tool output and continue iterating.
- GitHub Actions validation and Windows installer builds.

The app uses your ChatGPT login in its own persistent Chromium session. It does not need a separate OpenAI API key. This embeds a remote website rather than an official ChatGPT desktop API, so login or website changes can affect compatibility.

## Run locally

Requirements: Windows 10/11, Node.js 22 or newer (Node 24 recommended), npm, and internet access.

From the repository root:

    npm install
    npm start

The first run opens the ChatGPT website. Sign in normally. Use the folder button in the title bar to select the project folder. The default workspace is the ChatGPTWorkspace directory inside your Documents folder.

## Build the Windows EXE installer

    npm run dist:win

The installer is emitted under the dist directory. CI also builds the Windows installer on pushes to main and uploads the EXE to GitHub Actions artifacts and a pre-release on the repository Releases page:

- Releases: https://github.com/hashin9973-ux/idk/releases
- Build workflow: https://github.com/hashin9973-ux/idk/actions

The installer is not code-signed, so Windows SmartScreen may show a warning. Review the source and build workflow before installing.

## Start the local coding workflow

1. Open the overlay and choose your repository folder with the folder button.
2. In the ChatGPT conversation, type /codex and press Enter.
3. Ask ChatGPT to inspect or modify the selected repository as usual.
4. When ChatGPT needs local access, it emits one fenced assistant_tool block. The app intercepts it, validates the tool and arguments, and runs the local tool.
5. Read-only tools return their actual result. For edits, patches, tests, PowerShell, and sensitive-file reads, a native approval dialog must be accepted first.
6. The app submits the actual result back into the ChatGPT conversation. ChatGPT can then decide the next step. It should not claim a local operation succeeded without the returned result.

Example tool request (ChatGPT emits this, not something you need to type):

    assistant_tool
    {"version":1,"tool":"read_file","args":{"path":"src/index.js"},"call_id":"read-src"}

The fenced block’s language tag must be assistant_tool. The app recognizes one tool request per assistant response, then waits for its result before recognizing the next call.

## Familiar commands

Type these directly into the ChatGPT composer and press Enter. The app intercepts recognized slash commands instead of submitting them as ordinary ChatGPT text.

- /status or /pwd — workspace summary and Git state.
- /init — create AGENTS.md without overwriting an existing file.
- /ls src or /tree src — list a directory.
- /find src/**/*.js — glob-based file discovery.
- /read src/index.js or /cat src/index.js — read a text file.
- /search useEffect or /grep "some phrase" — full-text search.
- /git — actual Git status.
- /diff — actual tracked-file diff.
- /plan "add feature X" — ask ChatGPT to plan before implementing.
- /review — ask ChatGPT to review current changes without editing them.
- /test — infer and run the project's test command (approval required).
- /exec git status --short — run a PowerShell command (approval required).
- /workspace — choose the project folder.
- /help — show command help.

Direct file operations can also be requested through assistant_tool calls. The tool schema and allowed arguments are in desktop/tool-runner.js and desktop/command-protocol.js.

## Tool approval and safety boundaries

Read-only workspace tools do not require approval, except reads of secret-like file names. Creating or overwriting files, applying patches, running tests, and running PowerShell require a separate native approval dialog per operation. The app also restricts filesystem paths to the selected workspace and rejects parent traversal and symlink escapes.

PowerShell is not sandboxed: an approved command runs with your Windows user's permissions and can access files outside the selected workspace. Review each command carefully. Output is capped, commands have time limits, and results include actual exit codes, stdout, stderr, and timeout status. Search skips files whose names look like credentials, tokens, environment files, private keys, or secrets; a direct read of a matching file requires explicit approval.

## Repository roles

- App development: https://github.com/hashin9973-ux/idk
- Test and release validation plan: https://github.com/hashin9973-ux/qdqwg
