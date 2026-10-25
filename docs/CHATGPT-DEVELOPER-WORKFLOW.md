# ChatGPT Developer Workflow — Windows Repository Bridge

This guide is for a fresh ChatGPT conversation that has only its custom instructions, access to the private mailbox repository, and the user's task. It does not assume the model has context from another conversation.

## Paste-ready custom instructions

Replace the old project-specific instructions with this compact version, adapting the repository name only if the mailbox changes:

```text
Use Windows Repository Bridge against my actual Windows workspace; GitHub is only the mailbox, not the project environment. Keep ChatGPT human-facing; use qdqwg:bridge-mailbox for requests/results. Start with bridge/context/latest.json, then call get_agent_context once; inspect applicable AGENTS.md and targeted source/manifests. Follow bridge/context/capabilities.json. Use fresh immutable request IDs and read matching results. If missing, inspect that ID's claim and worker state, then re-read; don't assume blocked or duplicate uncertain side effects. Batch related operations (1–50 steps, concurrency up to 8). Check shell/test exitCode, timedOut, stdout/stderr and truncation; fix failures and rerun. For substantial work, define acceptance criteria, build scope-appropriate modular architecture incrementally, and run tests/build plus UI smoke tests when available. Use Colab vision only when visual evidence matters: check vision_status, activate if needed, confirm actual readiness, capture a targeted screenshot, and use vision_wait with the same ID if pending. Vision can be slow; deactivate when done, knowing this disables new requests but does not stop Colab. Avoid screenshots of sensitive content because they enter repository history. Report verified results and unknowns. Keep reads targeted. Never edit bridge control/request/claim/result files or send secrets.
```

This is intentionally workflow-focused. Keep the task's actual feature requirements in the user's prompt rather than trying to place every future project detail in custom instructions.

## Task workflow

### 1. Bootstrap from little context

1. Read `bridge/context/latest.json` first. Use its compact `agent_context` as the entry point; do not fetch every context file independently.
2. Call `get_agent_context` once for a fresh live snapshot when the task depends on the selected workspace. It includes the current tool schemas, project scripts, bounded directory overview, and applicable instruction-file metadata.
3. Read root or path-specific `AGENTS.md` instructions that apply to files being changed. Read relevant source, tests, manifests, and configuration; do not dump the whole repository.
4. Identify the project framework, current state, test/build commands, and any existing work before editing. Preserve unrelated modifications.

### 2. Plan scope-appropriate software

For a substantial task, write measurable acceptance criteria and a short plan. Make architecture decisions from the task and the existing repository, not from convenience.

- A complex game or app should normally have separate modules for gameplay/domain logic, state/data, UI/rendering, input, persistence, configuration, and tests as appropriate to its framework.
- A multi-system feature should be broken into coherent modules with clear interfaces. A one-file implementation is acceptable for a genuinely small task or when the user explicitly requests a single-file deliverable; it is not an automatic shortcut for a large task.
- Prefer an integrated vertical slice over a large pile of disconnected stubs. Keep the project runnable as components are added.
- Avoid overengineering: use the smallest architecture that meets the actual requirements and can be verified.

### 3. Use the bridge efficiently

Every independent request/result cycle crosses GitHub's asynchronous mailbox. Batch related work instead of making a separate request for every small read.

- `batch` supports 1–50 steps, with concurrency defaulting to 4 and a maximum of 8. Steps with dependencies or conflicting file effects are ordered by the runner. A `$ref` may refer only to an earlier step and must use a valid field path, such as `{"$ref":"readme.result.content"}`.
- Good inspection batch: status, project manifest, applicable instructions, targeted searches, and a few relevant source/test reads.
- Good implementation cycle: a focused patch, then a separate verification batch that runs relevant checks and inspects diff/status.
- Use `maxConcurrency: 1` when strict ordering is more important than speed. Don't put a dependent test in the same batch as an edit unless the dependency is represented explicitly.
- For large output, use smaller ranges/pages and stable offsets. A `partial` status or truncation flag means the returned content is incomplete, not that the operation was blocked.

### 4. Treat the mailbox as asynchronous, not as a synchronous tool call

Each request file is immutable. Use a new unique ID for each intentional operation, and never overwrite an existing request.

1. Create `bridge/requests/<id>.json`.
2. Read `bridge/results/<id>.json` and verify that its `request_id` exactly matches the request.
3. Make decisions from the nested tool result—not from the existence of the request file, the fact that the write succeeded, or a missing result file.
4. If the result is not yet visible, check `bridge/claims/<id>.json` and `bridge/state/windows-app.json`, then re-read the same result. Do not immediately call it blocked, issue duplicate commands, or change the ID for a side-effecting operation that may still be running.
5. For `needs_manual_recovery`, inspect the real workspace before retrying with a new ID. Never blindly replay an operation whose execution outcome is uncertain.

For `shell` and `run_tests`, check the actual `exitCode`, `timedOut`, `stdout`, `stderr`, and truncation fields. Exit code zero is necessary but not sufficient: inspect whether the output shows the expected behavior. A timeout or non-zero exit is a failure to diagnose, not success. Long-running services should be launched deliberately as background processes with logs and bounded readiness checks; do not wait forever for a server that is designed not to exit.

### 5. Verify behavior, not just code shape

After implementation:

1. Run project-native syntax/lint/check and automated tests. Add tests for the bug or requirement being changed.
2. Build the actual target when a build command exists.
3. For user-facing software, use an available browser or UI smoke test: load the application, exercise its principal flows, inspect console/runtime errors, and confirm persisted state where relevant.
4. On failure, inspect the complete available error output, fix the root cause, and rerun the relevant tests. Recheck the final diff for accidental changes, broken imports, stale references, or unfinished placeholders.
5. Do not claim full-game, full-workflow, performance, or compatibility coverage unless it was actually tested.

### 6. Optional Colab vision

The bridge exposes `vision_status`, `vision_activate`, `vision_analyze_screenshot`, `vision_wait`, and `vision_deactivate`. Vision is optional: use it when a visible UI, layout, rendered scene, dialog, or screenshot materially helps diagnose or verify the task. Prefer code, logs, tests, and structured evidence when they answer the question already.

1. Check `vision_status` before analysis. If visual inspection is warranted and vision is disabled, call `vision_activate`; opening Colab is not proof of readiness. The user may need to sign in, start a GPU runtime, and run the notebook's worker cell. Verify the model/runtime is ready before submitting a screenshot.
2. Submit one targeted `vision_analyze_screenshot` request, with a narrow question. Use the desktop source for the current screen or a workspace-relative image path for a known screenshot. If the result is pending, retain its exact request ID and use `vision_wait` rather than sending duplicate screenshots. Inference may take a long time, so continue nonvisual work while waiting where practical.
3. If the service is unavailable, the GPU is missing, the heartbeat is stale, or analysis fails, report that accurately and continue with other methods. Do not claim visual verification occurred unless a real report was returned.
4. Use screenshots carefully: the compressed image is uploaded to the configured GitHub mailbox, and deletion does not erase earlier Git history. Avoid credentials, private messages, and unrelated sensitive information.
5. When finished, call `vision_deactivate` to disable new screenshot jobs. It does not stop Colab, close the browser, or unload the model. Do not claim otherwise.

For a graphical game or app, use automated tests for exact state and vision for visible outcomes. When both matter, combine a deterministic test with one targeted screenshot rather than repeatedly sampling the screen.

### 7. Finish with an evidence-backed report

State what changed, which tests/builds/smoke tests actually passed, and any remaining unverified areas. Distinguish a verified result from an inference. Do not claim a request executed until its matching result confirms it, and do not claim the requested task is complete solely because files were created.

## 8. Suggested benchmark criteria

Use the same task before and after workflow changes. Score architecture and file organization, requirement coverage, incremental integration, request/result correctness, recovery from delayed or failed commands, automated test quality, runtime smoke-test results, and factuality of the final report. Save the actual request/result IDs and test outputs as evidence; do not rely only on the model's final summary.
