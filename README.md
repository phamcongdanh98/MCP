# WorkspaceGuard MCP

WorkspaceGuard MCP là MCP server cục bộ, đa nền tảng, cho phép ChatGPT hoặc MCP client thao tác trên **một workspace được chỉ định**. Dự án được xây mới sau khi nghiên cứu [FileMCP](https://github.com/anhnv02/file-mcp), giữ các nguyên tắc bảo mật hữu ích và giảm những phần chưa cần cho bản đầu tiên.

## Dùng để làm gì?

- Liệt kê, đọc theo file hoặc theo dòng, tìm tên và tìm nội dung.
- Ghi file theo kiểu atomic, hỗ trợ `dry_run` và `expected_sha256` để tránh ghi đè thay đổi mới hơn.
- “Xóa” bằng cách chuyển vào `.workspaceguard/trash`, có thể khôi phục thủ công.
- Đọc Git status, log và diff mà không bật shell.
- Tùy chọn chạy terminal bằng `program + args`, không ghép chuỗi qua shell và chỉ cho phép executable trong allowlist.
- Dùng qua `stdio` hoặc MCP Streamable HTTP trên `127.0.0.1` có token.
- Ghi audit JSONL mà không lưu nội dung file hoặc toàn bộ tham số lệnh.

## Cải tiến chính

| Chủ đề | FileMCP gốc | WorkspaceGuard MCP |
| --- | --- | --- |
| Core đa nền tảng | Swift và C# triển khai song song | Một core TypeScript cho macOS/Windows/Linux |
| Quyền | File/Git; shell bật hoặc tắt | `read-only`, `workspace-write`, `command` |
| Chạy lệnh | Chuỗi shell (`zsh -lc`/PowerShell) | Executable + mảng args, `shell: false`, allowlist |
| Ghi file | Ghi/append, có atomic replace | Atomic replace + dry-run + optimistic lock SHA-256 |
| Xóa | Xóa file/thư mục thật | Chuyển vào trash nội bộ |
| File bí mật | Không có denylist riêng | Chặn `.env`, key/certificate và credential mặc định |
| Theo dõi | Log runtime | Audit JSONL có request ID, kết quả và thời lượng |
| Giao thức | Parser HTTP/MCP tự triển khai | MCP TypeScript SDK v2 chính thức của dự án MCP |

Đổi lại, bản `0.1.0` chưa có GUI desktop, Keychain/Credential Manager, ký/notarize app hoặc installer. Đây là lựa chọn có chủ đích: kiểm chứng một core an toàn và dễ bảo trì trước, sau đó mới bọc bằng Tauri/native shell.

## Yêu cầu

- Node.js 20 trở lên (đã kiểm tra với Node.js 24).
- Git nếu dùng các tool `git_*`.
- Với ChatGPT: một workspace hỗ trợ custom MCP app, một Secure MCP Tunnel và runtime API key có quyền tunnel phù hợp. Xem [OpenAI Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

## Chạy từng bước

### Bước 1 — cài dependency

```bash
cd "/Users/danhpham/Documents/ChatGPT/MCP"
npm install
```

Không đặt API key vào `.env` hoặc commit lên Git.

### Bước 2 — kiểm tra toàn bộ dự án

```bash
npm run verify
```

Lệnh này chạy typecheck, unit/integration test, build production và semantic smoke test qua MCP stdio.

### Bước 3 — build

```bash
npm run build
```

Entry point production là:

```text
/Users/danhpham/Documents/ChatGPT/MCP/dist/index.js
```

### Bước 4 — chọn workspace và mode

Nên bắt đầu với một thư mục thử nghiệm nhỏ:

```bash
mkdir -p /tmp/workspaceguard-demo
printf 'Xin chào MCP\n' > /tmp/workspaceguard-demo/hello.txt
```

Ba mode:

- `read-only`: chỉ có tool đọc file và đọc Git. Đây là mặc định.
- `workspace-write`: thêm `write_file` và `trash_path`.
- `command`: thêm quyền ghi và `run_command`.

Lưu ý: server vẫn ghi audit nội bộ vào `.workspaceguard/audit.jsonl` trong cả ba mode. “Read-only” mô tả các tool công khai, không phải filesystem sandbox của chính tiến trình server.

### Bước 5A — chạy qua stdio (khuyến nghị)

```bash
node dist/index.js \
  --root /tmp/workspaceguard-demo \
  --transport stdio \
  --mode read-only
```

Terminal sẽ chờ MCP client gửi request qua stdin. Đây là hành vi đúng, không phải treo.

### Bước 5B — bật quyền ghi

```bash
node dist/index.js \
  --root /tmp/workspaceguard-demo \
  --transport stdio \
  --mode workspace-write
```

`trash_path` mặc định `dry_run=true`. Chỉ khi caller gửi `dry_run=false` thì path mới được chuyển vào trash.

### Bước 5C — cho phép tự chạy lệnh terminal

```bash
node dist/index.js \
  --root /tmp/workspaceguard-demo \
  --transport stdio \
  --mode command \
  --allow-command git,node,npm,npx
```

Ví dụ input tool:

```json
{
  "program": "npm",
  "args": ["test"],
  "cwd": "",
  "timeout_seconds": 120
}
```

`run_command` không dùng shell, nhưng **không phải OS sandbox**. `node`, `npm`, Python hoặc một executable được phép vẫn có thể đọc/ghi ngoài workspace, dùng mạng và chạy process khác với quyền của tài khoản hiện tại. Chỉ dùng command mode với workspace và workflow đáng tin cậy.

### Bước 6 — nối với OpenAI Secure MCP Tunnel

Theo tài liệu OpenAI hiện hành, tunnel có thể gọi MCP server qua stdio; cách này tránh mở cả cổng loopback. Tải `tunnel-client` từ Platform tunnel settings hoặc bản phát hành chính thức mới nhất, rồi:

```bash
export CONTROL_PLANE_API_KEY="sk-..."

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile workspaceguard-local \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --mcp-command "node /Users/danhpham/Documents/ChatGPT/MCP/dist/index.js --root /tmp/workspaceguard-demo --transport stdio --mode read-only"

tunnel-client doctor --profile workspaceguard-local --explain
tunnel-client run --profile workspaceguard-local
```

Giữ `tunnel-client run` hoạt động. Trong ChatGPT, bật Developer Mode/custom MCP app theo policy của workspace, tạo app mới, chọn kết nối **Tunnel**, chọn tunnel vừa tạo, chạy **Scan Tools**, sau đó thử `workspace_info`, `list_files` và `read_file` trước khi bật tool ghi.

API key chỉ truyền qua biến môi trường của terminal; không đưa vào command profile, source code, log hoặc Git.

### Bước 7 — HTTP loopback (tùy chọn)

```bash
export WORKSPACE_MCP_TOKEN="$(openssl rand -hex 32)"

node dist/index.js \
  --root /tmp/workspaceguard-demo \
  --transport http \
  --mode read-only \
  --port 7331
```

Health check:

```bash
curl --fail http://127.0.0.1:7331/healthz
```

MCP request phải gửi header:

```text
X-Workspace-MCP-Token: <WORKSPACE_MCP_TOKEN>
```

HTTP server chỉ bind `127.0.0.1`, kiểm tra `Host`, `Origin`, token, framing cơ bản và giới hạn body. Dùng stdio nếu không có nhu cầu HTTP cụ thể.

## Tool có sẵn

### Luôn có

- `workspace_info`
- `list_files`
- `read_file`
- `read_file_range`
- `search_filenames`
- `search_content`
- `git_status`
- `git_log`
- `git_diff`

### Mode `workspace-write` hoặc `command`

- `write_file`
- `trash_path`

### Chỉ mode `command`

- `run_command`

## Khôi phục file đã trash

Tool trả về `trashPath`. Khôi phục bằng lệnh local, ví dụ:

```bash
mv "/tmp/workspaceguard-demo/.workspaceguard/trash/<id>/remove-me.txt" \
  "/tmp/workspaceguard-demo/remove-me.txt"
```

WorkspaceGuard không tự động dọn trash ở phiên bản này để tránh xóa dữ liệu ngoài ý muốn.

## Cấu trúc

```text
src/
├── config.ts                 # CLI/env và mode
├── security/path-policy.ts   # containment + sensitive-path policy
├── services/files.ts         # file/search/write/trash
├── services/git.ts           # Git read-only
├── services/process.ts       # process limits + tree cleanup
├── tools.ts                  # MCP schemas, annotations, audit
├── server.ts                 # stdio + HTTP loopback
└── index.ts                  # CLI entry
tests/                        # unit, integration, MCP semantic smoke
docs/                         # phân tích source và lộ trình
```

## Tài liệu bổ sung

- [Phân tích dự án FileMCP gốc](docs/PHAN_TICH_FILE_MCP.md)
- [Các bước xây dự án và lộ trình](docs/CAC_BUOC_XAY_DUNG.md)
- [Mô hình bảo mật](SECURITY.md)

## License và nguồn tham khảo

Dự án dùng Apache License 2.0. FileMCP cũng dùng Apache-2.0; xem [NOTICE](NOTICE) để biết nguồn thiết kế tham khảo. Không bao gồm binary `tunnel-client`; người vận hành tải bản phù hợp từ nguồn OpenAI chính thức.
