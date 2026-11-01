# Local model context and tool-output format

The direct OpenAI-compatible and KoboldCpp agents share one runtime. Their model-facing interface is Markdown-first and follows the same readable working conventions as Codex- and Claude-style coding agents.

## Model-facing format

- Project summaries, workspace status, task/plan information, agent observations, tool results, command output, diffs and file content are presented as Markdown.
- Tool catalogs are Markdown headings and argument lists generated from the actual registered tool definitions.
- Tool observations are labeled as untrusted data. They must never be treated as instructions that override the user, repository instructions or local approval policy.
- Source files, diffs, stdout, stderr and other exact text are preserved in fenced code blocks. Large results retain an explicit truncation notice and should be narrowed or paged rather than mistaken for complete output.
- Familiar slash aliases include `/project`, `/ls`, `/tree`, `/find`, `/read`, `/write`, `/patch`, `/run`, `/test` and `/plan`. Each resolves to an existing registered local tool; aliases do not create new execution capabilities.

## Structured protocol boundaries

The runtime still uses JSON where the underlying API or local tool contract requires it:

- OpenAI-compatible Chat Completions request and response envelopes.
- Function argument objects and the existing local tool schema validation.
- Persisted app settings and structured internal execution results.

These structures are not serialized into the model's conversation as the default presentation. Tool results are converted into Markdown before being appended to conversation history. Legacy sessions containing native tool-call history are normalized into the same slash-command and Markdown-observation format.

## Validation

Run `npm run check` and `npm test`. Tests cover Markdown rendering, secret redaction, code/output preservation, legacy-history conversion, familiar aliases, and both supported API provider configurations.
