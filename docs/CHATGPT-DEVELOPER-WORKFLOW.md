# ChatGPT Developer Workflow — Windows Bridge

The Windows Bridge desktop app is the local execution environment. OneDrive is a synchronized file mailbox only. Use the connected OneDrive integration to publish/read ordinary files; do not use GitHub as the mailbox or ask the user to run local commands when a registered Windows tool can do the work.

## Canonical instructions

Read the generated root files in the existing OneDrive Bridge folder:

- AGENT.md — authoritative operating rules and request/result workflow
- TOOLS.md — complete live Windows worker tool catalog and exact JSON schemas
- STATUS.md — current worker, agent, workspace, tool, queue and diagnostic state
- SCREEN.md — latest Observe context and freshness

The only mailbox folders are request, claims, result, messages and sandbox storage, each partitioned by agent ID. Do not create runtime, bridge, context, state, agents, sessions, tasks, projects, vision, artifacts, docs or other mailbox directories.

## Session bootstrap

If the current conversation has no successful session_start result, create one immutable bootstrap JSON request at request/agent-000/<request-id>.json. Wait for result/agent-000/<same-request-id>.json. The app generates and returns the opaque session_id and agent_id. Reuse only that assigned session; never invent or derive identifiers.

Ordinary requests go to request/<agent-id>/<request-id>.json and carry the exact returned session_id. Matching claims and results live in claims/<agent-id>/ and result/<agent-id>/. Requests, claims and results remain JSON; the four root Markdown files are guides and live context, not a Markdown task protocol.

## Slash-style shortcuts

Use familiar slash-style aliases in the ChatGPT conversation: /help reads AGENT.md and TOOLS.md; /status reads STATUS.md; /tools reads TOOLS.md; /screen reads SCREEN.md; /agents calls agent_status; /messages calls read_agent_messages; /workspace calls get_agent_context; /plan calls update_plan; /tasks <project-id> calls task_project_status and task_list; /inspect <path> calls read_file; and /test <command> calls run_tests. These are conversational aliases resolved by ChatGPT, not new Windows tools, a slash-command parser, or extra mailbox files. The complete live tool names and argument schemas remain in TOOLS.md.

## Coding loop

1. Read STATUS.md and SCREEN.md; inspect workspace and project instructions.
2. Read the exact tool schemas from TOOLS.md.
3. Inspect relevant source, configuration, and tests completely enough to understand the change.
4. Split independent work across agents only with explicit ownership and non-overlapping files/interfaces.
5. Batch independent operations; wait for dependencies; serialize conflicting writes and side effects.
6. Make focused edits using the native Windows tools.
7. Run project-native checks, tests and builds; inspect exit codes, complete output, diffs and generated files.
8. Verify the matching result record before reporting success. If a result is missing, inspect the matching claim and STATUS.md before retrying.

Use the installed toolchains actually reported by the Windows machine. PowerShell is the host shell, not a language limitation. Never assume a compiler, SDK, engine, package manager, path or version without checking.

## Trust and safety

OneDrive never executes code. The Windows app owns validation, approvals, workspace boundaries, local session state and execution. Do not bypass native approvals, path protections, symlink checks, secret-file protections or session lifecycle rules. Do not place credentials or private screenshots in Markdown files. Do not replay an uncertain side effect or broadly delete mailbox/OneDrive content.
