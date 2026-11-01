# ChatGPT Developer Workflow — Windows Bridge

The selected Windows workspace is the actual execution environment. OneDrive is the request/result mailbox, not the project itself and not a substitute for the Windows worker. Use the user's existing ChatGPT conversation.

## Paste-ready custom instructions

```text
Use Windows Bridge against my actual Windows workspace; OneDrive is the mailbox. The cloud mailbox is OneDrive/Bridge/runtime/bridge and the Windows worker uses the locally synchronized Bridge/runtime folder. For visible desktop work, read OneDrive Bridge/runtime/bridge/vision/observe.json FIRST when Observe is enabled; do not block it on get_agent_context, catalog refresh, or computer(status). Loop: read live state → choose a justified input → use the connected OneDrive integration to create a fresh immutable bridge/requests/<id>.json request using the exact registered schema → read its matching result from bridge/results/<id>.json → reread Observe → adapt and repeat until verified. Reading app repo files is not Windows execution. If request creation fails, report the exact OneDrive integration error; if result is delayed, inspect that same ID's claim and state, then reread the same result—never duplicate uncertain input. Avoid unnecessary status/context calls and narration between inputs. Batch only predictable adjacent inputs with computer(action=sequence, mode=fast); if the next step depends on the changed screen, observe first. Observe supplies window/control/UIA evidence, not full pixels or guaranteed OCR. Use Colab screenshots only when pixel/OCR/model analysis is needed and explicitly permitted, and confirm readiness first. For non-visual Windows tasks, fetch fresh context/catalog only when workspace, state, or schemas are unknown/stale; batch independent work. Discover machine facts before asking me. For substantial changes, inspect source/tests, define acceptance criteria, implement modularly, run checks/tests/builds and smoke tests, fix failures, verify diffs and exit codes, and report only measured results. Fetch all referenced output artifacts from OneDrive and reconstruct parts before relying on previews. Never edit existing bridge transport records, leak secrets, claim blocked access before trying the actual OneDrive integration write, or replay uncertain side effects.
```

## 1. Live desktop: Observe first

When the task concerns the visible Windows desktop and passive Observe is already enabled, read OneDrive `Bridge/runtime/bridge/vision/observe.json` directly and immediately. Do **not** wait for a fresh `get_agent_context`, reread capabilities just to see the screen, or call `computer(action=status)` just to read passive Observe. Context bootstrap and Colab vision status are separate concerns.

- Validate `enabled`, `updated_at`, the newest frame's `captured_at`, and its active window/focused control. If the feed is disabled, absent, or stale, say exactly what evidence is missing; never enable/disable it without the user's instruction.
- Observe frames contain active-window and focused-control data, Windows UI Automation control bounds when available, screen dimensions and change fingerprints. They are **not full screenshot pixels** and do not guarantee OCR or readable values for inputs. Do not claim that text was read when the feed says it was withheld.
- Use the adaptive loop **Observe read → choose next justified input → publish one request through the connected OneDrive integration → verify matching result → read newest Observe → adapt**, repeating until the requested outcome is confirmed.
- Each input request must use a new unique ID. Invoke the actual OneDrive integration create-file/write operation for `Bridge/runtime/bridge/requests/<id>.json`; merely reading the repo or seeing a catalog entry does not invoke the Windows tool. A successful commit proves publication only. A matching completed result proves execution. If the write result is uncertain, read the exact request path: if it exists, follow that same request; if absent, retry the same ID/path. Do not blindly publish a second ID for an uncertain write.
- If the next action is predictable, batch adjacent actions in one `computer(action=sequence, mode="fast", steps=[...])` request (subject to the current catalog's maximum). If the next action depends on the resulting screen, use the minimum needed input and read Observe again before deciding.
- Use `observe=false` for a fast input sequence when you will read the passive Observe file directly and do not need Colab inference. Set `observe=true` only when the Colab screenshot-analysis report itself is needed to make the next decision.
- Avoid narration between each step, repeated status checks, repeated context bootstrap, and one-request-per-key when a known sequence can be sent together. Do not sacrifice verification for speed.
- Never infer failure from a missing result alone. Inspect the same request's `bridge/claims/<id>.json` and current `bridge/state/windows-app.json`, then reread `bridge/results/<id>.json`. Do not issue a duplicate while an input might still execute.
- The worker scans its local OneDrive-synchronized request directory every 2 seconds. `requestPolling` telemetry records local scan duration/count and poll duration. This local interval is not an end-to-end SLA; OneDrive connector publication, cloud synchronization, Windows local sync, and ChatGPT latency are separate stages.

## 2. Bootstrap and catalog only when needed

For non-visual Windows tasks, or when tool availability, workspace boundaries, local state or exact schemas are unknown/stale:

1. Read `bridge/context/latest.json` and `bridge/context/capabilities.json` in OneDrive `Bridge/runtime/bridge/`.
2. Submit `get_agent_context` using a fresh request when a genuinely fresh view is needed. Its returned tool catalog and workspace guidance govern calls to the worker.
3. Read the applicable root/nested `AGENTS.md`, project manifests, relevant source and tests. Discover locally available facts before asking the user.
4. Treat OneDrive as the mailbox only; create/read request, claim, result, and context files there. Run commands through registered Windows tools within the selected workspace and local policy.

A fresh environment bootstrap must not block direct reading of an already-enabled live Observe feed. When both reads are useful, start the independent OneDrive reads concurrently where the interface permits.

## 3. Mailbox efficiency and latency diagnosis

Every local operation is published and returned through OneDrive, so avoid avoidable cycles.

- The current worker can process up to 32 independent mailbox requests. The current published `batch` catalog supports 1–100 steps and `maxConcurrency` 1–100; the installed catalog is authoritative for the build actually running.
- Batch independent inspections and edits; preserve dependencies, shared-file conflicts, installs, stateful inputs and other side-effect order. Use result references for actual dependencies.
- The current worker scans the local OneDrive-synchronized request directory on a 2-second reconciliation interval. Cloud-to-Windows and Windows-to-cloud synchronization add separate latency; local polling alone does not establish end-to-end pickup time.
- Use the OneDrive request's creation/modified time, matching claim `claimed_at`, result `timing_ms`, and sync errors to locate delay. `created_to_worker_start` begins at request JSON `created_at`, before cloud publication and synchronization, so it includes pre-publication time.
- If `output_truncated` is true, status is `partial`, or a field says `OUTPUT EXTERNALIZED`, fetch all artifacts referenced in `artifacts[]`. For `tool_output_part`, concatenate all parts for the field in numeric part order; for `complete_result_part`, reconstruct the full result JSON before following its manifest. Check `artifact_errors`, stdout/stderr truncation and EOF/page markers before claiming complete output.

## Compact diagnostics and long-running installs

Prefer bounded PowerShell summaries over returning whole files, process objects, command lines, environment snapshots or full transcripts. Return only the fields that determine the next action, and cap log output by both lines and characters. Huge stdout can create many numbered artifacts and extra OneDrive artifact writes; retrieve all parts only when complete output is necessary, and never infer from a preview alone.

For installs/downloads that may outlive a shell wrapper, record a small status file with stage, expected/actual asset size and SHA-256, installer exit code, before/after app archive hashes and process status. A wrapper timeout is an uncertain outcome when a child may still be running: issue a new read-only status request and reconcile that same operation before any retry. A new worker ID indicates a restart but is not by itself proof of success. Do not duplicate installers or side effects while status is ambiguous.

For pickup latency, compare the OneDrive request's creation/modified timestamp with the matching claim's `claimed_at`; `created_to_worker_start` includes time before the cloud write/sync completes. Use local scan/poll telemetry to distinguish sync delay, local discovery, tool execution, and result publication.

## 4. Trust results, recover carefully

1. Publish a new immutable JSON request at `Bridge/runtime/bridge/requests/<id>.json` with protocol `chatgpt-local-repo-bridge/v1`, exact `tool`, schema-valid `args`, and matching `request_id`.
2. Read `Bridge/runtime/bridge/results/<same-id>.json`. Check request ID, status, nested `ok`, errors, exit code, timeout, partial/truncation flags and artifacts.
3. If missing, inspect that same ID's claim and current worker state, then poll/re-read the same result. Claims, commits, heartbeats and previews are not terminal results.
4. Diagnose the observed error: a OneDrive create/write rejection or unsynchronized file means Windows has not yet received the request; a missing result is a pickup/result-publication problem until evidence says otherwise; a matching rejected result gives the actual local validation error. Do not label these generically as a safety block.
5. Never replay uncertain side effects. Rerun only when the original operation is known not to have executed or its state has been reconciled.

## 5. Build and verify software changes

For substantial coding tasks, define measurable acceptance criteria, inspect existing implementation and tests, choose an architecture appropriate to the feature, and deliver integrated modules rather than an unrelated single-file approximation. Run project-native syntax/lint/checks, relevant automated tests, builds and available UI smoke tests. Fix failures and repeat the checks. Inspect diffs, output truncation, exit codes and persisted postconditions. Distinguish the tests that actually ran from unverified environment-specific behavior. Documentation-only changes do not require a redundant installer run.

## 6. Optional pixel-level Colab vision

Passive Observe and the Colab screenshot backend are independent.

- Use the Colab `computer(action=screenshot)` path only when pixels, OCR, image interpretation or model-grounded coordinates materially help and the user asked for that visual path or its use is otherwise clearly permitted by their instruction.
- Before screenshot analysis, check `computer(action=status)` and confirm the direct Colab connection, vision-enabled state and model readiness. Do not connect, activate or capture automatically just because Observe is on.
- The Colab service analyzes screenshots; Windows still executes mouse/keyboard input. Keep screenshots, private messages, tunnel URLs and secrets out of repository artifacts.
- If a screenshot/inference request returns pending, wait with the exact returned request ID. Do not submit duplicates.
- `disable` prevents new screenshots but does not stop the Colab runtime or unload the model.

## 7. Report only verified outcomes

Keep reporting concise during rapid interaction and summarize at completion. State what was actually changed, the request/result IDs that support local actions, checks that passed, and remaining limitations. Never claim that a window opened, a tool executed, a build passed, or a file was fully read without matching evidence.
