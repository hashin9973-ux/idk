# Local protocol v1

A request is one UTF-8 JSON object transported over Chrome Native Messaging. Chrome adds a 4-byte little-endian length prefix. Maximum request payload: 1 MiB.

## Request fields

Common fields: version must be integer 1; id is optional and at most 80 characters; op is a supported operation; approved must be true for workspace operations. The extension sets approved only after a visible confirmation. The host independently validates the operation schema.

### health
{"version":1,"op":"health"}
Returns host status and protocol version.

### list_files
{"version":1,"op":"list_files","approved":true,"path":"."}
Lists immediate entries in a workspace-relative directory (maximum 500 entries).

### read_file
{"version":1,"op":"read_file","approved":true,"path":"README.md"}
Reads UTF-8 text files up to 256 KiB.

### write_file
{"version":1,"op":"write_file","approved":true,"path":"notes.txt","content":"hello"}
Writes UTF-8 text atomically, up to 256 KiB. Existing files are overwritten only after the user confirms the reviewed task.

### run_pytest
{"version":1,"op":"run_pytest","approved":true,"test_path":"tests"}
Runs the fixed command sys.executable -m pytest -q [test_path] with the workspace as current directory. The optional test path is workspace-relative. There is no arbitrary executable or shell input. Tests are untrusted code and must only be run in a workspace you trust.

## Result fields

All results include version, id, op, ok, and duration_ms. Successful operations provide data. Errors include a short error string. run_pytest includes exit_code, stdout, and stderr; outputs are truncated when necessary.

An ok: true result means the operation completed as reported; it does not imply a build or application is correct. A failed test run may still be a successfully executed operation: inspect exit_code.
