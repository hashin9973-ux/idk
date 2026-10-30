# Project intelligence and large-workspace execution

The bridge keeps two complementary indexes.

- The existing filesystem index is a names-only workspace map. It remains intentionally small and may be shallow for an entire-drive workspace.
- Project intelligence is a separate local cache in the app user-data directory. It stores relative file metadata, language, bounded identifier terms, declarations, and import specifiers. It does not store file contents and is not published to the mailbox.

## Capabilities

- Incremental updates from filesystem notifications, with periodic reconciliation and metadata reuse when file size and timestamps are unchanged.
- Code-aware search across file paths, identifiers, declared functions/classes, and JavaScript/TypeScript class methods. `kind=file` searches path terms only; `kind=symbol` returns declarations. This is local lexical/symbol ranking, not embedding-based semantic search.
- Project overview: language mix, test/entry-point candidates, symbol count, and relative import-graph size.
- Change impact through resolved relative imports. Package aliases, reflection, generated code, dynamic imports, and framework-specific dependency systems may be unresolved.
- Results contain paths and symbol metadata, not source text. Posting-list work is bounded at 250,000 examined postings per query; bounded results report `scanTruncated` rather than implying completeness.
- Drive-root workspaces are intentionally shallow. Select the specific project folder for recursive indexing.

Supported extensions and generated-directory exclusions are defined in desktop/project-intelligence.js. Secret-like paths, symlinks, binary files, and files larger than 1 MiB are excluded. Defaults cap indexing at 50,000 files, 250,000 directory entries, and 1 GiB of source bytes per full pass. A truncated index is explicitly incomplete: `incompleteReasons` and last-scan counters identify file-count, directory-entry, total-byte, per-file-size, and unreadable-path omissions. Directory traversal is sorted for repeatable capped results. Cache restoration validates every relative path and bounded metadata record before use. Warm starts restore the cached full-scan marker and reconcile the filesystem in the background. Persisted cache files are capped at 256 MiB; oversized metadata remains in memory and reports that a full scan will be needed after restart.

## Scheduling and isolation

A process-wide scheduler protects overlapping read/write paths and serializes barrier operations such as shell, tests, Git mutations, and desktop control. Independent reads and non-conflicting writes can run concurrently. Index readers share a per-workspace read lock and refresh takes that resource's write lock. The process-wide scheduler bounds queued tasks, exposes task details, supports priority aging and cooperative cancellation, and aborts/drains active work during shutdown with a bounded wait. It reports active/queued counts and average queue/execution timing. Each mailbox batch accepts up to 100 steps, defaults to 32 concurrent children, and can request up to 100; the process-wide scheduler enforces a shared maximum of 100 active operations across concurrent requests.

The approval-gated git_worktree tool lists, creates, and removes non-forced worktrees. Worktrees are not created or deleted automatically; callers must choose their paths and branch strategy.

Run `npm run check` and `npm test`. `npm run bench:project-intelligence` exercises a synthetic 2,000-file project and reports cold indexing, warm-cache restoration, symbol search, relative-import impact, and scheduler throughput. CI validates correctness and safety on a Windows runner; synthetic timings are not measurements of the user's actual workspace.
