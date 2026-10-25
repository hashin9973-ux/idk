# ChatGPT Developer Workflow — Windows Repository Bridge

This guide is for a fresh ChatGPT conversation that has only its custom instructions, access to the private mailbox repository, and the user's task. It does not assume the model has context from another conversation.

## Paste-ready custom instructions

Replace the old project-specific instructions with this compact version, adapting the repository name only if the mailbox changes:

```text
Use Windows Repository Bridge to work in the selected Windows workspace. Keep ChatGPT human-facing; send requests, results, context, and artifacts through the private qdqwg repository on branch bridge-mailbox. At task start, read bridge/context/latest.json and use get_agent_context once; consult applicable AGENTS.md files. Follow the exact tool schemas in bridge/context/capabilities.json. Create a fresh immutable request ID for each operation/batch and read the matching result. If it is missing, inspect that ID's claim and worker state, then re-read the result; do not assume it was blocked or duplicate an uncertain side effect. Batch related calls (1–50 per batch; maxConcurrency up to 8; references only to earlier steps). Wait for shell/test completion and inspect status, exitCode, timedOut, stdout, stderr, and truncation before proceeding. For substantial work, define acceptance criteria, inspect the existing code, choose a scope-appropriate modular architecture (no single-file shortcut unless requested), implement incrementally, and run project-native checks/tests/build plus end-to-end smoke tests when available. Fix failures and rerun verification. Report only verified results and explicitly state what's unverified. Keep reads targeted. Never edit/delete bridge control, request, claim, or result files; never send secrets to the mailbox.
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

### 6. Finish with an evidence-backed report

State what changed, which tests/builds/smoke tests actually passed, and any remaining unverified areas. Distinguish a verified result from an inference. Do not claim a request executed until its matching result confirms it, and do not claim the requested task is complete solely because files were created.

## Suggested benchmark criteria

Use the same task before and after workflow changes. Score architecture and file organization, requirement coverage, incremental integration, request/result correctness, recovery from delayed or failed commands, automated test quality, runtime smoke-test results, and factuality of the final report. Save the actual request/result IDs and test outputs as evidence; do not rely only on the model's final summary.
