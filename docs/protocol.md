# Local protocol v1

A request is one UTF-8 JSON object transported over Chrome Native Messaging. Chrome adds a 4-byte little-endian length prefix. Maximum request payload: 1 MiB.

## Request fields

Common fields: version must be integer 1; id is optional and at most 80 characters; op is a supported operation; approved must be true for workspace operations. The extension sets approved only after a visible confirmation. The host independently validates the operation schema.

### health
{"version":1,"op":"health"}
Returns host status, protocol version, supported operation names, and configured request/file/output/listing/timeout limits. It does not disclose the workspace path.

### list_files
{"version":1,"op":"list_files","approved":true,"path":"."}
Lists immediate entries in a workspace-relative directory (maximum 500 entries).

### read_file
{"version":1,"op":"read_file","approved":true,"path":"README.md"}
Reads UTF-8 text files up to 256 KiB.

### write_file
{"version":1,"op":"write_file","approved":true,"path":"notes.txt","content":"hello"}
Writes UTF-8 text atomically, up to 256 KiB. Existing files are overwritten only after the user confirms the reviewed task.

### write_files
`{"version":1,"op":"write_files","approved":true,"files":[{"path":"src/one.py","content":"first file text"},{"path":"src/two.py","content":"second file text"}]}`
Writes 1–20 files as one explicitly approved batch. Each entry must contain only `path` and `content`. Paths must stay inside the configured workspace; parent directories must exist. Each file and each prior existing target must be at most 256 KiB; combined new content is at most 512 KiB. Every replacement is staged before the first target is replaced, and original file contents are staged for rollback. If a replacement fails, rollback is attempted and any recovery-copy location is reported if restoration fails. This is not a filesystem-atomic transaction; do not use it where partial visibility is unacceptable.

### run_pytest
{"version":1,"op":"run_pytest","approved":true,"test_path":"tests"}
Runs the fixed command sys.executable -m pytest -q [test_path] with the workspace as current directory. The optional test path is workspace-relative. There is no arbitrary executable or shell input. Tests are untrusted code and must only be run in a workspace you trust.

### run_process
`{"version":1,"op":"run_process","approved":true,"executable":"git","args":["status","--short"],"cwd":".","timeout_seconds":30}`
Starts the named executable with an argument array, never by concatenating a command string. An absolute executable path is allowed; a relative executable path must remain inside the workspace; a bare program name is resolved through PATH. The working directory must be within the configured workspace. Arguments are limited to 128 strings, 8192 characters per string, and 64 KiB combined. Timeout is 1–120 seconds. Output is bounded and includes the real process exit code. An approved shell/interpreter executable may still run commands; it runs with the current Windows user's permissions and is not sandboxed to the configured workspace. Only cwd is constrained. Review every field before authorizing it.

## Result fields

All results include version, id, op, ok, and duration_ms. Successful operations provide data. Errors include a short error string. run_pytest and run_process return the actual process exit_code, stdout, stderr, and timeout status; outputs are truncated when necessary.

An ok: true result means the operation completed as reported; it does not imply a build or application is correct. A failed test run may still be a successfully executed operation: inspect exit_code.
