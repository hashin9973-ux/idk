# Project intelligence and large-workspace execution

The bridge keeps two complementary indexes.

- The existing filesystem index is a names-only workspace map. It remains intentionally small and may be shallow for an entire-drive workspace.
- Project intelligence is a separate local cache in the app user-data directory. It stores relative file metadata, language, bounded identifier terms, declarations, and import specifiers. It does not store file contents and is not published to the mailbox.

## Capabilities

- Incremental updates from filesystem notifications, with periodic reconciliation and metadata reuse when file size and timestamps are unchanged.
- Code-aware search across paths, identifiers, and declared symbols. This is local lexical/symbol ranking, not embedding-based semantic search.
- Project overview: language mix, test/entry-point candidates, symbol count, and relative import-graph size.
- Change impact through resolved relative imports. Package aliases, reflection, generated code, dynamic imports, and framework-specific dependency systems may be unresolved.
- Results contain paths and symbol metadata, not source text.
- Drive-root workspaces are intentionally shallow. Select the specific project folder for recursive indexing.

Supported extensions and generated-directory exclusions are defined in desktop/project-intelligence.js. Secret-like paths, symlinks, binary files, and files larger than 1 MiB are excluded. Defaults cap indexing at 50,000 files, 250,000 directory entries, and 1 GiB of source bytes per full pass. A truncated index is explicitly incomplete: `incompleteReasons` and last-scan counters identify file-count, directory-entry, total-byte, per-file-size, and unreadable-path omissions. Directory traversal is sorted for repeatable capped results. Cache restoration validates every relative path and bounded metadata record before use.

## Scheduling and isolation

A process-wide scheduler protects overlapping read/write paths and serializes barrier operations such as shell, tests, Git mutations, and desktop control. Independent reads and non-conflicting writes can run concurrently. Index readers share a per-workspace read lock and refresh takes that resource's write lock. The process-wide scheduler bounds queued tasks, exposes task details, supports priority aging and cooperative cancellation, and aborts/drains active work during shutdown with a bounded wait. It reports active/queued counts and average queue/execution timing. Existing per-request batch scheduling remains available for up to 100 steps.

The approval-gated git_worktree tool lists, creates, and removes non-forced worktrees. Worktrees are not created or deleted automatically; callers must choose their paths and branch strategy.

Run npm run check and npm test. CI validates correctness and safety, not performance on every Windows project. For real performance evaluation, compare cold index duration, warm search latency, files indexed, truncation state, and scheduler timing on the target workspace.
