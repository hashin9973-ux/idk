# Windows Repository Bridge — desktop app

This app is a local Windows worker for your existing ChatGPT conversation. ChatGPT remains in your normal browser; requests, results, environment context, and explicitly uploaded files travel through a private GitHub repository branch.

## First-time setup

1. Start the app. The default mailbox is `hashin9973-ux/qdqwg` on branch `bridge-mailbox`; the worker automatically connects when the saved GitHub sign-in and mailbox configuration are valid.
2. Click **Sign in with GitHub** if the app is not authenticated. The app launches the official GitHub CLI browser authorization flow. Approve the permissions on GitHub; the app imports the validated token into Windows-backed Electron `safeStorage`. No custom OAuth App registration, client ID, client secret, personal access token, or pasted credential is required.
3. In the status window, click the **Workspace: …** row to open the Windows folder picker. The app initially uses `Documents\ChatGPTWorkspace`. Select a project folder for narrow access, or select a drive root such as `C:\` to make the entire drive available. A warning confirmation appears before switching to an entire drive. The status row then labels it **Workspace: entire drive C:\**.
4. Continue using your existing ChatGPT conversation and its GitHub integration to create mailbox requests and read results. There is no separate ChatGPT chat interface in this worker.
5. For multiple ChatGPT conversations, each conversation calls `session_start` once. The app generates a cryptographically random `session_id` and binds it to one `agent-###` seat; every subsequent ordinary mailbox request includes that exact session ID. `agent_status` exposes all seats and active/inactive/paused/busy state. The session ID and seat stay bound to that conversation unless explicitly disconnected/revoked or that exact ID is evicted at the 10,000-ID oldest-activity hard cap.

The app maintains a names-only index for the selected workspace. For a normal project folder it indexes descendants; for a drive root it deliberately scans and watches only immediate children instead of crawling every file on a potentially huge drive. The current snapshot is synchronized to `bridge/context/filesystem-index.md`; `bridge/context/latest.json` points ChatGPT to it. The index contains relative paths and item types only—not file contents or absolute local paths. In drive-root mode, explore specific folders on demand with `list_dir`, `directory_tree`, `glob_file_search`, or `search` and provide their `path`. The warning confirmation is important: file tools can change or delete files anywhere inside the selected drive, while PowerShell remains unrestricted as your Windows user.

The installer bundles GitHub CLI v2.103.2 and verifies the archive SHA-256 before packaging it, so you do not need to install the CLI separately. GitHub's authorization consent screen determines the scopes granted to the GitHub CLI OAuth application; review it before approving. The app's own GitHub API routes are restricted to the configured mailbox repository and supported `bridge/` paths. **Disconnect app** clears the app's encrypted token; it does not sign you out of the separate GitHub CLI profile.

ChatGPT does not need a separate login inside this worker. **Sign in to ChatGPT** opens `https://chatgpt.com/auth/login/` in the default browser. This app does not access ChatGPT cookies or credentials and does not inject results into ChatGPT messages.

## Diagnose a failed request

Use the request ID to inspect `bridge/requests/<request-id>.json`, `bridge/claims/<request-id>.json`, and `bridge/results/<request-id>.json` on the configured mailbox branch. A request file means ChatGPT/its GitHub integration committed the request; a matching claim means the local worker claimed it; the result records validation, execution, and any tool error. If no request file exists, the Windows worker never received that request through this mailbox, so investigate the upstream request creation or ChatGPT/GitHub integration rather than describing it as a local execution block. If the GitHub create-file call reports HTTP 409 for a branch-head conflict, read back that exact request path first; if it exists, continue with the same request, and if it is absent, refresh the branch and retry the same ID/path. Never create a second ID to work around an uncertain write.

## Output and installer verification discipline

Keep shell diagnostics compact; do not return full process command lines, environment snapshots, transcripts, or unbounded logs. Report only necessary state/hash/exit fields. For large output that must be preserved, read every artifact part named in the result manifest and check `artifact_errors` rather than relying on a preview.

For downloads or installers, persist a small stage/status marker and capture asset size/hash, installer exit code, before/after app archive hashes and running app state. If the outer shell times out while a launched child may still be running, reconcile the original status marker with a fresh read-only request before retrying. Do not overlap installs or claim success from a launch, a changed worker ID, or a published installer URL alone.

## Observe-first interactive desktop loop

When Observe is already on, read the newest `bridge/vision/observe.json` frame directly before taking any screen action; do not wait for a new context bootstrap or run `computer(action=status)` just to inspect the passive feed. Then use **Observe → justified input → matching result → fresh Observe → next input** until the requested state is verified. Publish real requests with the GitHub integration's create-file/write operation. If request creation fails, quote the observed error; if a result is missing, inspect that exact request's claim/state and reread the same result instead of replaying it. Use `computer(action=sequence, mode="fast")` to batch known adjacent actions; do one action then reread Observe when the next action depends on the changed screen. Avoid status calls and explanatory narration between inputs.

Observe currently gives window/control/UI Automation evidence and changed-screen fingerprints, not guaranteed OCR or full screenshot pixels. It cannot verify text that its controls explicitly mark unreadable. Use the Colab screenshot path only when pixels or model interpretation are needed, and follow its separate explicit-activation/readiness rules.

## Trust boundaries

- The worker scheduler wakes on an approximately one-second timer, but new-request discovery scans the bounded request-directory Git tree every five seconds. It no longer waits for the path-filtered commits endpoint before scanning; a slow query there previously could block the poll loop and make the five-second recovery interval ineffective. `requestPolling` telemetry reports the last tree scan duration/count and last poll duration. GitHub MCP write/read latency and ChatGPT turn latency remain separate; compare the actual request commit time, claim time, and result `timing_ms` to diagnose them.
- The worker admits up to 64 independent mailbox requests at once, enough for 50 collaborating sessions with headroom. The published local `batch` schema supports 1–100 steps and `maxConcurrency` 1–100; batch concurrency is separate from worker request slots and the process-wide 100-operation scheduler. `$ref` dependencies, conflicting workspace paths, and side-effecting operations must remain ordered. The installed tool catalog is authoritative if a build differs.
- A private repository is strongly recommended because requests, results, context, and artifacts live in that repository.
- Read-only workspace inspection normally runs without approval. Ordinary file edits/moves/deletions inside the selected workspace normally run automatically unless a path looks sensitive. If a whole drive is selected, that includes files anywhere inside the drive. Git writes, shell commands, tests, and uploads require native Windows approval unless Auto-accept everything was explicitly enabled.
- PowerShell is not sandboxed: an approved command runs with the signed-in Windows user's permissions.
- GitHub access authorizes the mailbox transport; local work is performed by this Windows worker, not by GitHub itself.
- The app uses GitHub as transport. It is not a second AI agent and does not send or type messages into ChatGPT.

## Run and verify

```powershell
npm install
npm run check
npm test
npm start
```

On Windows, `npm start` prepares the pinned CLI helper automatically. To build the installer locally, `npm run dist:win` performs the same verified download and packages it with the app.


## Separate dashboard and embedded Colab browser

The compact overlay remains available. Open the separate Dashboard from the arrow button in the overlay or from the tray menu. The dashboard has Main and Settings tabs at the bottom; the Settings tab can be closed and restored with the + control. Dashboard widgets can be moved and resized with invisible resize edges and snap to a fine positioning grid.

Settings reuse the app's GitHub sign-in, workspace selection, Observe sampling, and repository bridge configuration. Repository changes are refused while any requests are active or queued and the previous configuration is restored if a replacement cannot be started. Public mailbox use requires an explicit checkbox. TTS volume scales local 16-bit PCM samples before playback.

Quick Colab connect opens the existing notebook in an embedded tab using the app's existing automatic clipboard endpoint watcher and authenticated HTTPS registration. Remote web content runs in an isolated WebContentsView with no application preload or Node integration. The optional background-focus compatibility mode disables Chromium background throttling and makes document visibility/focus APIs report active; it does not focus the native window or synthesize input, and some sites may use other focus signals. Low-memory mode unloads inactive web tabs instead, so the two options are mutually exclusive. The app measures the embedded renderer's private memory, but 100 MB is a best-effort target, not a guaranteed cap; Chromium and Colab can exceed it.


## Dashboard color themes

The dashboard Settings tab includes a visual theme gallery with 15 selectable designs: Midnight (default), Light, Ocean, Forest, Sunset, Rose, High contrast, Aurora, Cyberpunk, Dracula, Nord, Solarized light, Terminal, Lavender, and Graphite. Each card includes a miniature dashboard preview; the presets vary color palette and selected surface, border, glow, shape, and typography treatments as well as accents. The selected theme is persisted in the app's settings and restored at dashboard startup. Theme names are validated in the main process; theme choices only affect the dashboard's visual presentation.

## Agent session lifecycle and retention

Each agent widget has compact icon controls for workspace, messages, nickname, request-history auto-dump, pause/resume, disconnect, and delete. Pause temporarily rejects all new requests for that exact session while keeping its seat reserved; resuming restores the same session ID. Disconnect releases the seat and permanently detaches the old session ID while preserving its session history. Delete writes a permanent revocation tombstone and optionally wipes only attributable mailbox records. These operations are distinct; a disconnected or revoked session cannot be resumed.

Session IDs have no TTL or inactivity-based expiration. The mailbox hard cap is always 10,000 registered `bridge/sessions` records. When a new session would exceed the cap, the worker evicts the registered ID with the oldest `last_activity_at` using SHA-checked deletion; busy and paused IDs are not exempt from the cap. Each eviction is recorded separately in `bridge/evicted-sessions` so subsequent requests fail explicitly as `SESSION_EVICTED`. The worker cancels in-flight operations for an evicted ID and detaches its task ownership after those operations drain. Activity timestamps are updated by bridge-tool requests, not ordinary natural-language turns. The 10-minute status window is display-only and never invalidates a session or releases a v2 seat.

The `session_start` result includes a `context_message` showing the generated session and seat IDs plus the calling/coordination instructions. The app also opens the existing TTS-caption notification window when a new session assignment is waiting in the dashboard.

## Shared task coordination

Use `task_project_init` once per game/project and share the returned `project_id` with every participating ChatGPT session. The task tools provide durable task records, dependency gates, priority, file/module scope leases, heartbeats, submission evidence, independent review, approved Git worktree integration, and independent build/test/runtime verification. An ordinary claim cannot bypass a task in review, integration, or verification. Task scopes are workspace-relative; agents should use worktrees derived from the same primary project repository when coordinating changes to one project. The dashboard Settings tab shows shared board/task summaries and ownership leases.

Recommended lifecycle: `proposed → ready → claimed → in_progress → blocked → review → integration → verification → verified`. Rejected reviews or failed verification return tasks to `needs_rework`. Use `task_heartbeat` while working and `task_submit` with a commit SHA, changed paths, and evidence before asking another session to review. `task_integrate` performs a non-forced merge only when both source and primary worktrees are clean and the primary worktree is already on the selected target branch. `task_verify` requires separate build, test, and runtime commands; the task is not marked verified unless all exit codes are zero.

## Multi-language project and toolchain intelligence

The workspace profile is a bounded, read-only scan of project manifests and source-file extensions. It can report several project roots and languages in one workspace, including C/C++, C#, Rust, Java, Kotlin, Python, Go, JavaScript/TypeScript, PHP, Ruby, Swift, Dart/Flutter, Scala, Elixir, Erlang, Zig, Lua, Perl, R, Vue and Svelte. Recognized project/build metadata includes CMake, Make, Meson, MSBuild/Visual Studio, Unreal, Unity, Godot, .NET, Cargo, Maven, Gradle, Python packaging/test manifests, Go modules/workspaces, npm/pnpm/Yarn, Composer, Bundler, Swift Package Manager/Xcode, Dart/Flutter, sbt, Mix and Rebar3.

Scanning is capped by depth, entry count, manifest size and project count. Drive-root workspaces remain shallow. Common generated/dependency directories and symbolic links are skipped, and likely secret filenames are excluded from language and manifest inspection. Project profiles contain concise metadata, not full source listings. The profile cache is short-lived and separate from the existing source/symbol index.

The local toolchain report separately probes executable lookup and version output. On Windows it also checks Visual Studio installations using the installed Visual Studio locator when available, so MSBuild and MSVC can be found even when their command prompts are not on the normal PATH. Unity Editor path discovery is a presence check; it does not launch the Editor. A successful version probe establishes executable availability, not that a compiler can compile this particular project.

Project support levels have specific meanings:
- **detected_only**: project files were recognized, but one or more required tools or engine prerequisites are missing/unresolved.
- **toolchain_available**: relevant toolchains are present, but no grounded build/test plan is currently available from the manifest/configuration.
- **toolchain_ready**: required tools have usable executable/version evidence and at least one supported workflow can be proposed.

Build/test plans are derived from manifests, registered scripts/targets, local wrappers, configured build directories and discovered executables. They include their project root and evidence source. Discovery does not run these commands, install SDKs/dependencies, or bypass local approval. The agent must work from the indicated project root, inspect project-specific instructions and arguments, then use the normal approval-gated execution tools. A suggested command is not a passing build or test.

Unreal and Unity receive engine-specific detection and prerequisite reporting, but they are not advertised as fully build-ready based only on project markers. UnrealBuildTool/engine association resolution and Unity's batch-mode target configuration remain separate requirements; this profile does not replace the engine editor, asset pipeline, UHT/UBT, or runtime verification. Some source-only language roots can be identified before they contain a recognizable build manifest; those are detection-only until their actual project configuration and tools are established.

## Game project intelligence and scheduling

`game_project_intelligence` scans bounded local project metadata for Unreal (`.uproject`, `.uplugin`, `Build.cs`, `Target.cs`, C++ reflection macros and exported Asset Registry JSON), Unity manifests/assembly definitions/serialized GUID references, and Godot project configuration/autoloads. It does not parse or edit binary `.uasset`/`.umap` assets, execute UHT/UBT, inspect Blueprint graphs, or replace an engine editor. Use detected engine files and verified project commands to run engine-native build/cook/test/runtime operations through the local Windows tools.

The process-wide scheduler retains the 100-operation hard ceiling and path/resource conflict checks, with additional per-class limits for filesystem operations, source analysis, compilation, editor, cook, packaging, GPU, binary assets, desktop control, audio, shell and Git. Batch steps use the same class limits in addition to `maxConcurrency`. These are conservative admission limits, not a claim of CPU/GPU isolation. The local scheduler reports active pool usage; no 50-session stress validation is included in this PR.