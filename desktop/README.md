# ChatGPT Assistant desktop app

This is a Windows desktop wrapper for the real ChatGPT web experience, with a local project-tool backend. It is not a separate chatbot and does not require an OpenAI API key.

## Run locally

Requirements: Windows 10/11, Node.js 22+ (Node 24 recommended), npm, and internet access.

    npm install
    npm start

Sign in to ChatGPT inside the app. Its login is stored in an app-specific persistent Chromium session and does not import browser cookies. Select the project workspace with the folder button in the title bar.

## Windows installer

    npm run dist:win

The NSIS installer is emitted in dist. GitHub Actions builds it on every push to main and uploads it as a build artifact and a downloadable prerelease:
https://github.com/hashin9973-ux/idk/releases

The installer is unsigned; Windows SmartScreen may show a warning. Verify the source and build output before installing.

## Tool-driven coding workflow

Type /codex in the ChatGPT composer and press Enter. That seeds the conversation with instructions to use the local tools. Continue describing the task normally. When a local operation is needed, ChatGPT emits one fenced block with the language assistant_tool, for example:

    assistant_tool
    {"version":1,"tool":"read_file","args":{"path":"src/index.js"},"call_id":"read-src"}

The app validates and executes the request, then submits the actual result back into the same ChatGPT conversation. ChatGPT should wait for each returned result before making claims about local execution or issuing the next tool request.

Supported tools:
- Workspace inspection: get_capabilities, project_status, list_dir, glob_file_search, read_file, search.
- Git: git_status, git_diff.
- Project setup and edits: init, write_file, apply_patch.
- Execution and planning: shell, run_tests, update_plan.

Familiar direct commands (type in ChatGPT and press Enter):

- /status or /pwd
- /init
- /ls src or /tree src
- /find src/**/*.js
- /read src/index.js or /cat src/index.js
- /search useEffect or /grep "some phrase"
- /git and /diff
- /plan "add feature X" and /review
- /test
- /exec git status --short
- /workspace and /help

## Approval and scope

Read-only workspace operations are available directly, except reading secret-like filenames. Write operations, patches, tests, PowerShell, and secret-like file reads require an approval dialog for each operation. Filesystem operations are restricted to the selected workspace and guard against traversal and symlink escapes.

PowerShell is not sandboxed. If you approve a command, it executes with your Windows user's permissions and may access paths outside the selected workspace. Inspect commands before approving. Tool output is bounded and includes actual process exit codes, stdout/stderr, and timeout state where applicable.

## Implementation notes

- The ChatGPT web contents have no Node integration and no app preload access.
- Local app actions are exposed through a narrow preload API, while tool dispatch and approvals live in the Electron main process.
- The local tool request protocol is defined in desktop/command-protocol.js.
- Tool behavior and path guards live in desktop/tool-runner.js.
- The injected ChatGPT-side detector and result handoff live in desktop/tool-bridge.js.
- ChatGPT’s website UI is not a formal embedding API; changes to its composer or code-block DOM may require updates.
