# Local model context and tool execution

The OpenAI-compatible and KoboldCpp direct agents share one runtime inside the Windows desktop application. Tool execution remains in the existing local tool bridge; this feature does not add a second runtime, proxy service, mailbox or execution layer.

## Model-facing tool catalog

The direct-agent catalog exposes nine grouped tools:

| Tool | Purpose |
| --- | --- |
| `workspace` | Workspace context, environment, listing/tree/glob/search, file read/info/write/patch, directory create, move/delete, instruction discovery and initialization |
| `project` | Project status, local index status/refresh/search/overview/impact and game-project metadata |
| `git` | Git status/diff/log/show/branches/changed files/worktrees, branch create/switch, commit, fetch/pull/push and clone |
| `computer` | Local Windows computer status, vision and input actions |
| `tts` | Local Piper speech synthesis/playback |
| `shell` | Approval-governed PowerShell commands |
| `run_tests` | Project-native or explicitly supplied test commands |
| `update_plan` | Ordered local task plan |
| `batch` | Multiple local operations, with dependency handling and safe parallelism |

The app checks the actual published catalog before sending every provider request and rejects a catalog above the hard limit of 30 tools. Workspace, project and Git actions are resolved to existing local capabilities. Aliases do not create extra tools or execution capabilities.

## Native calls and slash fallback

When the configured provider and model support native Chat Completions tool calls, the runtime advertises the grouped schemas using `tools` and `tool_choice: auto`. It reconstructs streamed tool-call names and arguments, validates the registered tool and argument schema, executes the operation through the existing local tool bridge, persists the real invocation/result and sends the result back to the model. The model can then make additional calls or produce a final response. Independent native calls in a round can execute concurrently; subsequent rounds wait for the prior results.

OpenAI-compatible URLs do not guarantee native tool support. A server may reject tool schemas, or a model/template may report that it cannot use them. In that case the runtime switches that agent session to the slash-command fallback and stops sending native tool schemas.

In slash mode, the complete assistant response must be one valid slash command. Use named `key=value` arguments, quote strings containing spaces or command separators, and use simple bracketed lists. Examples:

```text
/project
/project action=search query="main entry point" kind=symbol maxResults=10
/workspace action=read path="package.json" startLine=1 endLine=80
/workspace action=write path="notes.md" content="A short note"
/git action=status
/run command="npm test"
/test command="npm test"
/find path="src" pattern="**/*.js"
/plan items=[Inspect, Implement, Verify]
/batch steps="read_file path=README.md; git_status"
```

Familiar shortcuts such as `/status`, `/ls`, `/tree`, `/find`, `/read`, `/write`, `/patch`, `/run`, `/test` and `/plan` resolve to the grouped tools. Former individual command names such as `/read_file`, `/project_search` and `/git_status` also normalize to their grouped action.

Ordinary prose is never an execution request. A response such as “I read the file” or “I ran the tests” does not execute anything. The runtime detects common unsupported completion claims, requests an actual tool call/command, and does not report completion without matching successful execution evidence. Missing, malformed or unknown tool calls are reported as failures. Repeated identical failed operations and duplicate identical side effects in one turn are blocked.

## Security and execution boundaries

All grouped operations route through the existing local bridge and preserve its argument checks, selected-workspace path validation, symlink-escape protection, shared scheduler, local approval dialogs and signed-in Windows permission boundary. Arbitrary PowerShell remains approval-governed by the existing app policy; grouping tools does not grant shell access or bypass approval. Computer inputs remain local Windows input, not Colab execution. The batch tool retains per-step validation and approval.

## Markdown context and observations

Project/status context, tool descriptions and returned observations use readable Markdown. The shared result formatter:
- renders structured result fields as headings/lists;
- preserves source text, diffs, stdout, stderr and other code-like fields in fenced blocks;
- redacts secret-like field names, including token, credential, API-key and session-ID values;
- omits internal protocol metadata; and
- adds an explicit shortening notice when the model-context limit is reached.

Native tool-call arguments and API envelopes remain structured where the Chat Completions protocol requires them. In native mode, the runtime preserves the provider's assistant tool-call messages and matching tool-role results. In slash fallback mode, legacy native-call history is presented as readable slash commands and Markdown observations rather than exposing raw JSON tool-result payloads.

## Verification

Run `npm run check`, `npm test` and `npm run bench:project-intelligence`. The Windows packaging workflow also validates package metadata and runs `npm run dist:win`. Provider/mock tests verify protocol parsing and lifecycle behavior; they are not evidence of a live OpenAI-compatible or KoboldCpp endpoint, nor a real Windows installation.
