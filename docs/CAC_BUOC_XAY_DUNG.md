# Các bước xây WorkspaceGuard MCP

## Giai đoạn 1 — chốt hợp đồng và threat model

1. Xác định caller: MCP client local hoặc OpenAI Secure MCP Tunnel.
2. Xác định boundary: một workspace root canonical.
3. Chia quyền thành `read-only`, `workspace-write`, `command`.
4. Đặt giới hạn file, search, request, output, timeout và concurrency.
5. Ghi rõ command mode có quyền OS, không phải sandbox.

Tiêu chí hoàn tất: mỗi tool có input, output, annotations, giới hạn, lỗi và mode rõ ràng trước khi code.

## Giai đoạn 2 — core filesystem

1. Canonicalize root.
2. Từ chối absolute path và traversal.
3. Resolve existing ancestor để chặn symlink escape cả khi target chưa tồn tại.
4. Chặn `.workspaceguard` và sensitive path mặc định.
5. Thêm bounded read/list/search.
6. Viết atomic, dry-run và optimistic SHA-256.
7. Thay delete bằng trash có đường dẫn khôi phục.

Tiêu chí hoàn tất: test traversal, symlink escape, missing target, secret, write conflict và trash semantics.

## Giai đoạn 3 — Git và process

1. Git read-only độc lập với command mode.
2. Chỉ nhận repository có `.git` directory nằm trong workspace.
3. Tắt prompt, pager, fsmonitor và external diff/textconv.
4. Command nhận executable và mảng args; không shell parse.
5. Allowlist basename, giới hạn args/cwd/time/output/concurrency.
6. Cố gắng dọn process group/Windows process tree khi timeout; Windows Job Object là hardening của phase desktop.

Tiêu chí hoàn tất: test command disabled, allowlist denial, output truncation, timeout và Git repository containment.

## Giai đoạn 4 — MCP transport

1. Đăng ký tool bằng MCP SDK và Zod strict schema.
2. Chỉ expose tool phù hợp với mode.
3. Cung cấp stdio làm mặc định.
4. HTTP chỉ bind `127.0.0.1`, dùng token, Host/Origin/body checks.
5. Audit request ID, tool, summary, outcome và duration; không log file content.

Tiêu chí hoàn tất: MCP client thật discover tool và gọi `read_file`, không chỉ kiểm tra process chạy.

## Giai đoạn 5 — chất lượng và phát hành

1. `npm install` tạo lockfile.
2. `npm run typecheck` với strict TypeScript.
3. `npm test` cho unit/integration.
4. `npm run build` tạo artifact production.
5. `npm run smoke` spawn artifact qua stdio và kiểm tra output theo ý nghĩa.
6. CI gọi đúng `npm run verify` bằng install khóa cứng.
7. Audit dependency và không đóng gói secret/build rác.

## Giai đoạn 6 — desktop app, sau MVP

Khuyến nghị Tauri hoặc native shell mỏng gọi cùng một core/package:

- Folder picker và hiển thị canonical workspace.
- Chọn mode; command allowlist editor.
- Xem audit, trash và restore.
- Quản lý tunnel process/health.
- Lưu runtime API key bằng Keychain/Credential Manager.
- Auto-update có ký, macOS notarization và Windows Authenticode.

Không đưa secret vào settings JSON và không bundle một tunnel binary cũ vô thời hạn. Quy trình release phải xác minh checksum, license và cập nhật từ nguồn chính thức.

## Giai đoạn 7 — policy nâng cao

- Per-tool approval và session-scoped elevation có thời hạn.
- Glob allow/deny theo workspace.
- Tamper-evident audit hoặc gửi audit tới hệ thống ngoài workspace.
- OS sandbox thực: macOS sandbox profile/container, Windows AppContainer/Job/token restrictions, Linux namespace/seccomp.
- Mutating Git với reviewable plan, explicit pathspec, commit diff preview và push destination policy.
- Fuzz HTTP/path/JSON-RPC, Windows junction tests và CI ba hệ điều hành.
