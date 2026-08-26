# Phân tích source FileMCP

Nguồn: [github.com/anhnv02/file-mcp](https://github.com/anhnv02/file-mcp), nhánh `main`, commit được nghiên cứu: `b662e1c098225aca685be0d2eef00af333a8cc34` ngày 2026-08-22.

## 1. Dự án gốc dùng để làm gì?

FileMCP là app desktop native cho macOS và Windows. Nó cho ChatGPT quyền có kiểm soát đối với một thư mục local qua Model Context Protocol:

```text
ChatGPT/OpenAI product
  → OpenAI Secure MCP Tunnel
  → tunnel-client chạy local
  → MCP HTTP trên 127.0.0.1
  → filesystem / Git / optional shell
```

App có UI để nhập Tunnel ID, runtime API key, workspace root, port, Git identity và bật/tắt shell. Secret được lưu trong macOS Keychain hoặc Windows Credential Manager.

## 2. Chức năng

Filesystem:

- Liệt kê file, đọc toàn file hoặc một khoảng dòng.
- Tìm tên file và tìm literal text có context.
- Tạo/ghi đè/append file.
- Xóa file hoặc xóa đệ quy thư mục.

Git:

- Init, status, log, diff, add, commit và push.
- Khi shell tắt, Git chạy ở safe mode, chặn nhiều đường thoát qua hooks, filters, includes, object alternates, credential helpers và transport lạ.

Terminal:

- Chỉ xuất hiện khi user bật setting.
- macOS chạy shell của user với `-lc`; Windows chạy PowerShell `-Command`.
- Timeout 1–120 giây, output bounded, process con được dọn theo process group/Windows Job Object.

Runtime và bảo mật:

- MCP server bind loopback.
- Token 256-bit mới cho mỗi runtime giữa tunnel-client và server.
- Check `Host`, `Origin`, header/body/framing và OAuth discovery path.
- Canonical path và symlink/reparse-point containment.
- Giới hạn file 5 MB, search scope, output và concurrency.
- Bundle binary `tunnel-client` chính thức kèm checksum, license và provenance.

## 3. Điểm mạnh đáng học

- Threat model thực tế, không tuyên bố shell là sandbox.
- Path containment xử lý cả ancestor chưa tồn tại và final symlink/reparse point.
- Secret không nằm trong settings file hay command line.
- Process lifecycle được coi là phần correctness: timeout phải dọn cả descendants.
- Git được xem là bề mặt thực thi, không chỉ là lệnh đọc/ghi thông thường.
- Test integration rất sâu: malformed HTTP, symlink/junction, Git metadata escape, process cleanup và fake tunnel lifecycle.
- CI tách macOS/Windows và xác minh checksum/legal resources của binary vendored.

## 4. Điểm có thể cải tiến

Đây là trade-off kiến trúc, không phải kết luận rằng source gốc “kém”:

1. **Nhân đôi core.** Swift và C# cùng triển khai protocol, filesystem, Git, process và tunnel. Khoảng 8.700 dòng core/UI/test chính phải giữ behavior parity giữa hai platform.
2. **Parser MCP/HTTP tự viết.** Kiểm soát tốt nhưng chi phí cập nhật protocol, fuzzing và compatibility cao hơn dùng SDK chuẩn.
3. **Shell nhận một chuỗi.** Khi bật, caller có toàn bộ ngữ nghĩa shell; allowlist theo executable gần như không thể áp dụng chính xác.
4. **Xóa vĩnh viễn.** `delete_file` và `delete_directory` không có dry-run/trash/undo ở tool contract.
5. **Không có optimistic concurrency cho file.** Ghi atomic giúp tránh file rách, nhưng không ngăn caller ghi đè phiên bản vừa được process khác thay đổi.
6. **Git surface lớn.** `git_push` và Git mutation hữu ích nhưng tăng đáng kể credential/network/config attack surface.
7. **Chưa có mode read-only/write tách biệt.** Shell có toggle, còn các tool ghi/xóa/Git mutation luôn hiện diện.
8. **Không có policy chặn file secret riêng.** Workspace containment không ngăn model đọc `.env` nằm hợp lệ trong workspace.

## 5. Phần giữ, thay và bỏ ở WorkspaceGuard

Giữ:

- Workspace root duy nhất, canonical containment, không follow symlink directory.
- Loopback-only HTTP, token local, request/output/search/time/concurrency limits.
- Shell/command tắt theo mặc định và cảnh báo đúng về quyền OS.
- Git đọc không cần bật command mode.
- Process tree cleanup và structured MCP annotations.

Thay:

- Hai native core → một TypeScript core đa nền tảng.
- Protocol tự viết → MCP TypeScript SDK v2.
- Shell string → executable + args + allowlist.
- Permanent delete → recoverable trash.
- Blind overwrite → atomic write + dry-run + `expected_sha256`.
- Runtime log → audit JSONL đã rút gọn dữ liệu nhạy cảm.

Bỏ khỏi MVP:

- GUI native, tray/Dock behavior và credential store.
- Vendored `tunnel-client` binary.
- Git init/add/commit/push.
- Public network listener, OAuth server và public plugin deployment.

Các mục bỏ có thể quay lại khi có use case và threat model cụ thể. Riêng mutating Git nên đi qua một policy/approval layer riêng, không chỉ thêm vài wrapper command.

## 6. Kiểm chứng source gốc trên môi trường hiện tại

- Repository clone thành công và đã đọc code, test, CI, security/runtime implementation.
- Lệnh `./tests/test_swift_runtime.sh` bắt đầu chạy và test local-auth environment đầu tiên pass.
- Suite dừng ở bước compile do Swift compiler và macOS SDK trên máy có build version không khớp; cache mặc định cũng bị sandbox chặn. Vì vậy chưa thể xác nhận toàn bộ suite macOS tại đây.
- Windows suite không thể chạy trên host macOS này.

Đây là giới hạn môi trường kiểm thử, không phải kết luận lỗi chức năng của FileMCP.
