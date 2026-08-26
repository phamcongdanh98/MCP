# Security model

WorkspaceGuard MCP gives an MCP caller access to local data. Treat the selected workspace and every enabled tool as privileged.

## Enforced

- Filesystem tools are contained to one canonical workspace root.
- Absolute paths, traversal, symlink escapes and reserved internal state are rejected.
- Common secret/key paths are blocked unless `--allow-sensitive` is explicit.
- `git_diff` requires explicit non-glob file paths while that sensitive-path policy is active.
- Reads, writes, searches, process output, timeouts and concurrency are bounded.
- Replacements are atomic; optional SHA-256 preconditions prevent lost updates.
- Removal is recoverable trash, not recursive permanent deletion.
- HTTP binds only to `127.0.0.1` and requires a local token for `/mcp`.
- Tool schemas are strict and tool availability follows the configured mode.

## Not enforced

Command mode is **not an operating-system sandbox**. An allowlisted executable can potentially:

- read or modify files outside the workspace;
- access the network and credentials available to the OS user;
- start other processes;
- modify `.git`, `.workspaceguard`, or other paths that file tools block.

Executable allowlisting reduces accidental shell injection; it does not make interpreters such as Node.js or Python safe against a malicious caller.

The local token protects against accidental/untrusted local HTTP callers but not another process already running with the same OS-user privileges. Audit files inside the workspace are operational records, not tamper-proof security logs.

## Safe operation

1. Start with `--mode read-only` and a narrow disposable workspace.
2. Review tool definitions before enabling an MCP app.
3. Prefer stdio through Secure MCP Tunnel.
4. Enable write/command tools only for trusted workflows.
5. Keep API keys outside the repository and command-line arguments.
6. Review `.workspaceguard/audit.jsonl` and trash contents.
7. Do not publish the HTTP port or bind it to LAN/public interfaces.

## Reporting

Do not include real workspace contents, API keys, tokens, private keys or credential exports in a public issue. Reproduce with synthetic fixtures and describe the affected version, platform and mode.
