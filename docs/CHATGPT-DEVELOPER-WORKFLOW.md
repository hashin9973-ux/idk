# ChatGPT Developer Workflow — Windows Repository Bridge

This guide is for a ChatGPT conversation with access to the user's private shared mailbox and Windows Repository Bridge. The Windows workspace is the actual project environment; GitHub is only request/result transport.

## Paste-ready custom instructions

```text
Use Windows Repository Bridge against my actual Windows workspace; GitHub is only the mailbox, not the project environment. For Windows tasks, inspect qdqwg:bridge-mailbox context, then call get_agent_context and use the installed tool catalog. Do not claim access is blocked or give manual instructions before trying the bridge. Use fresh immutable request IDs and read the matching result. If it is missing, inspect that ID's claim and worker state, then reread it; never duplicate an uncertain side effect. Discover machine facts before asking me. Batch related operations and use explicit references for dependencies. For substantial software work, define acceptance criteria, use modular architecture appropriate to scope, implement integrated slices, run checks/tests/builds and available UI smoke tests, fix failures, and report only verified outcomes. Check exit codes, timeouts, output and truncation. The optional computer tool has status/connect/enable/disable/screenshot/wait actions; do not enable or connect vision unless I explicitly request visual inspection/activation. Confirm actual readiness before screenshots, reuse the same pending request ID when waiting, and do not claim disable shuts down Colab. Screenshots go directly to the authenticated Colab service; avoid sensitive screen contents. Never edit bridge control/request/claim/result records or send secrets.
```

Keep task-specific requirements in the user's prompt rather than trying to encode every future feature in custom instructions.

## 1. Bootstrap with little context

1. Read `bridge/context/latest.json` and `bridge/context/capabilities.json` from `hashin9973-ux/qdqwg` on `bridge-mailbox`.
2. Submit a fresh `get_agent_context` request when current Windows state matters. Its result and exact tool catalog are authoritative for the installed worker.
3. Read applicable `AGENTS.md` files, project manifests, targeted source and tests. Identify the framework, existing implementation, and native test/build commands before asking for discoverable machine facts.
4. Preserve unrelated files and changes. The selected Windows workspace is the actual target; the mailbox repository is not the project itself.

## 2. Plan and implement to match the task

For substantial work, define measurable acceptance criteria and a short implementation plan. Keep the plan proportional to scope.

- Choose the smallest architecture that really satisfies the requirements. Do not collapse a complex game, app, or multi-system feature into one source file merely for convenience unless the user explicitly requests a single-file deliverable.
- Inspect entry points, existing modules, data formats, framework conventions and tests before choosing the design.
- Implement in small, integrated vertical slices with clear responsibilities and interfaces. Keep the project runnable as work progresses; avoid disconnected stubs and unrelated rewrites.
- Prefer targeted reads, searches and bounded output over dumping the whole workspace.

## 3. Use the mailbox efficiently

Every request/result cycle crosses GitHub asynchronously. Batch related work rather than creating one request per small read or command.

- `batch` supports 1–50 steps. Its independent-step concurrency defaults to 4 and has a maximum of 8. This is separate from the worker's mailbox request-concurrency limit.
- Use an initial inspection batch for project status, relevant instructions, searches and source reads; a focused edit batch; then a verification batch for tests, build output, diff and status.
- Use explicit result references for dependent steps. Do not put a dependent test beside an edit unless the dependency is represented in the batch.
- Each request file is immutable. Use a new unique request ID for each intentional operation; never overwrite or delete existing request, claim, result, state, context or artifact records.

## 4. Trust results, not assumptions

1. Create `bridge/requests/<id>.json` with the published protocol and exact tool/argument schema.
2. Read `bridge/results/<same-id>.json` and confirm the request ID and result status.
3. If a result is missing, inspect `bridge/claims/<same-id>.json` and `bridge/state/windows-app.json`, then reread that same result. A request or claim alone is not proof of completion.
4. Diagnose the actual error. A missing native local-tool function, a ChatGPT server-sandbox path miss, a timeout, a compile error, a rejected schema and truncated output are different problems—not generic evidence that Windows access is blocked.
5. Never replay an operation with uncertain side effects. Inspect the workspace before retrying any request marked for manual recovery.

For `shell` and `run_tests`, inspect the real `exitCode`, `timedOut`, `stdout`, `stderr` and truncation flags. Exit code zero is necessary but not sufficient; confirm the output demonstrates the expected behavior. Background services should have redirected logs and bounded readiness checks rather than an unbounded foreground wait.

## 5. Verify behavior before reporting completion

After implementation:

1. Run project-native syntax/check/lint commands and the relevant automated tests. Add regression tests for changed behavior.
2. Build the actual target when a build command exists.
3. For user-facing software, run the available UI or end-to-end smoke test. Exercise principal flows and inspect runtime errors and persisted state where relevant.
4. Fix failures and repeat the relevant checks. Review the final diff for accidental changes, stale imports/references, secrets, or unfinished placeholders.
5. Distinguish verified outcomes from assumptions and unverified areas. Do not claim a build, browser check, UI flow or full playthrough passed without its actual result.

## 6. Optional computer / Colab vision

The current ChatGPT-facing interface is the single `computer` tool with `status`, `connect`, `enable`, `disable`, `screenshot` and `wait` actions. It uses direct authenticated HTTPS transport between Windows and Colab; screenshot analysis results return through the normal mailbox.

- Vision is optional. Do not automatically connect to Colab, enable the model or capture a screenshot. Use connect/enable only when the user explicitly requests it.
- Check status first. Before capture, confirm the connection and model are actually ready. Opening a notebook or seeing a running cell is not proof that inference is ready.
- Capture only when visual evidence materially helps and avoid credentials, private messages and unrelated sensitive content.
- If a screenshot request is pending, wait using the exact request ID returned by that request. Do not submit duplicate screenshots while the first may still be processing.
- `disable` prevents new screenshot requests but does not stop the Colab runtime, close the browser or unload the model. Do not claim otherwise.

## 7. Finish with evidence

State what changed, the tests/builds/smoke checks that actually passed, and remaining unverified areas. Match every claim of successful local work to a real result from the corresponding request ID.
