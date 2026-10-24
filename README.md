# ChatGPT Assistant for Windows

A Windows desktop companion for using **the same normal ChatGPT conversation** with local development tools. It is not a Codex session and does not create a separate AI conversation.

## How it works

- The visible app is a compact native conversation mirror. It displays the active ChatGPT thread in a custom UI, with a viewport-sized message window and a small overscan buffer, plus a composer and a recent-thread picker.
- The existing ChatGPT sign-in session is kept in a separate off-screen Electron web view. The mirror reads the currently visible messages from that session and submits messages back into the same thread.
- When ChatGPT emits a fenced `assistant_tool` request, the app validates it, runs the selected local tool against the chosen workspace, asks for approval where required, and inserts the real tool result into the same conversation. The model can then continue from the returned output.
- The app's own GitHub login is private to the desktop app. It is used only for authenticated local Git operations such as clone, fetch, pull, and push. It does not expose a GitHub API tool to ChatGPT, and the app credential is never placed in a chat message, Git remote URL, or process command line.
- Remote GitHub tasks in the ChatGPT conversation continue to use your existing ChatGPT GitHub integration. That connection is separate from the app's local Git credential.

## Important limitations

This is a **DOM-backed mirror**, not a documented ChatGPT API integration. ChatGPT's public website does not provide a supported interface for registering arbitrary custom native tools against an existing signed-in conversation, so the app detects a structured assistant response in the page and returns the result as a follow-up message in that same thread. This depends on ChatGPT page selectors and may require maintenance when the site changes.

The custom native UI renders only a bounded subset of the active conversation, not ChatGPT's sidebar or full page layout. However, the authenticated website remains loaded off-screen as the transport and still builds its own page DOM; this reduces what is shown and copied into the mirror, but does **not** eliminate the website's background CPU or network work. Avoiding all of that while preserving the existing account conversation would require a supported underlying conversation interface that is not currently available to this app.

The mirror currently supports text and code display, conversation switching, text submission, and bounded viewport paging. File uploads and full-fidelity rendering for images, audio, interactive widgets, and other rich ChatGPT content are not mirrored. The temporary visible ChatGPT session window remains available for sign-in or features that the mirror doesn't support. The app has not yet been manually smoke-tested on your Windows machine; passing CI does not prove the interactive website bridge is stable.

## Local tools

**Workspace and files:** `get_capabilities`, `project_status`, `environment_info`, `list_dir`, `directory_tree`, `glob_file_search`, `read_file`, `file_info`, `search`, `discover_instructions`, `init`, `write_file`, `apply_patch`, `create_directory`, `move_path`, `delete_path`.

**Local Git inspection:** `git_status`, `git_diff`, `git_log`, `git_show`, `git_branches`, `git_changed_files`.

**Local Git changes:** `git_create_branch`, `git_switch_branch`, `git_commit`, `git_fetch`, `git_pull`, `git_push`, `git_clone`.

**Execution and planning:** `shell`, `run_tests`, `update_plan`.

The selected folder is the local workspace root; choose the actual checkout you want to work on. Paths passed to file tools are relative to it. The local tool set does not include a duplicate GitHub REST API tool.

Authenticated Git operations are available after you connect GitHub in **Accounts**. They are restricted to GitHub remotes, use the app credential in a temporary process environment, and do not rewrite saved remote URLs. Clone destinations must remain inside the selected workspace; pull is fast-forward-only; push does not force-update remote history. Clone, fetch, pull, push, all file changes, tests, and shell commands require native per-operation approval.

PowerShell commands run with the signed-in Windows user's permissions and are **not sandboxed**. Approval is not a security sandbox; review the command and target before allowing it.

## Install and sign in

Requirements: Windows 10/11, Node.js 22 or newer, npm, Git for Windows, and internet access.

From the repository root:

```powershell
npm install
npm start
```

Open **Accounts**:

- **ChatGPT:** sign in using the temporary visible ChatGPT window. It uses the same persistent session as the mirror. Close that window to return to the native UI.
- **GitHub (app-side):** configure an OAuth App client ID with Device Flow enabled, save it, then select **Sign in with GitHub**. The app requests `repo` and `read:user` scopes; review them on GitHub. The OAuth token is encrypted with Electron's OS-backed `safeStorage` and is used only inside the app's main process for local Git operations. Signing out removes the saved encrypted token.

After sign-in, the app adds local-tool instructions to the active idle conversation once per workspace/conversation pair. This is a normal user message in the same thread, not a hidden system prompt or a first-party ChatGPT tool registration. Use `/tools` to resend the instructions if automatic setup missed a conversation.

## Slash commands

- `/status` or `/pwd` — inspect the selected workspace and local Git state.
- `/env` — non-secret runtime and machine information.
- `/ls [path]`, `/tree [path]`, `/find <glob>`, `/read <path>`, `/info <path>`, `/search <text>`.
- `/git`, `/diff`, `/log`, `/branches`, `/changed`.
- `/mkdir <path>`, `/mv <source> <destination>`, `/rm <path>`.
- `/branch <name>`, `/switch <name>`, `/commit <message>`.
- `/fetch [remote]`, `/pull [remote] [branch]`, `/push [remote] [branch]`, `/clone <owner/repository> <path> [branch]` — authenticated local Git operations, with approval.
- `/test [command]`, `/exec <PowerShell command>` — local execution (approval required).
- `/github` — app-side GitHub sign-in status; `/workspace` — select the local project folder.
- `/tools` — resend local-tool instructions; `/plan [task]`, `/review`, and `/help`.

## Validation and packaging

```powershell
npm run check
npm test
npm run dist:win
```

GitHub Actions runs syntax checks, tests, and an unsigned Windows NSIS installer build. These checks do not replace interactive testing of ChatGPT sign-in, same-thread message insertion, and native approval dialogs.

- App repository: https://github.com/hashin9973-ux/idk
- Build workflow: https://github.com/hashin9973-ux/idk/actions
- Releases: https://github.com/hashin9973-ux/idk/releases
- Companion test/release plan: https://github.com/hashin9973-ux/qdqwg
