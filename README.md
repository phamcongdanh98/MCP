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

Ứng dụng có giao diện desktop Electron để chọn workspace, chọn mode, chọn command allowlist, khởi động/dừng server, kiểm tra MCP ngay trong app và kết nối Secure MCP Tunnel. Theo hướng FileMCP, app tạo token loopback mới theo từng phiên, giữ server ở `127.0.0.1`, quản lý vòng đời `tunnel-client`, và lưu Runtime API key bằng cơ chế mã hóa hệ điều hành (Keychain trên macOS khi khả dụng). Binary `tunnel-client` vẫn do người dùng tải từ OpenAI; dự án không đóng gói binary đó.

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

### Bước 3 — chạy giao diện desktop (cách dễ nhất)

```bash
npm run desktop
```

Trong cửa sổ **WorkspaceGuard**:

1. Nhấn **Chọn thư mục…** và chọn một workspace thử nghiệm.
2. Giữ **Chỉ đọc** khi dùng lần đầu.
3. Nhấn **Khởi động MCP**. Khi trạng thái chuyển thành **Đang chạy**, server HTTP đã sẵn sàng trên `127.0.0.1:<cổng>`.
4. Nhấn **Dừng** khi xong. Đóng ứng dụng cũng dừng cả server lẫn Tunnel.

Giao diện không hiển thị hoặc lưu token HTTP; token được tạo mới trong main process mỗi lần khởi động.

### Kiểm tra toàn bộ MCP ngay trong giao diện

Sau khi server báo **Đang chạy**, nhấn **Chạy kiểm tra MCP**. Đây là MCP client thật trong Electron main process, không phải kiểm tra giả qua giao diện.

- Với **Chỉ đọc**, app kiểm tra handshake HTTP MCP, khám phá tool, `workspace_info` và `list_files`.
- Với **Đọc và ghi**, app kiểm tra thêm `write_file` → `read_file` → `trash_path`. Bạn phải tick xác nhận vì file thử tên ngẫu nhiên sẽ được chuyển vào `.workspaceguard/trash`.
- Với **Chạy lệnh**, giữ tick `node` trong allowlist để app kiểm tra thêm `run_command` bằng `node --version`.

Chọn một thư mục thử nghiệm riêng cho hai mode cuối. Kết quả từng bước hiện ngay trong phần kiểm tra của giao diện.

### Bước 4 — build core bằng terminal (tùy chọn)

```bash
npm run build
```

Entry point production là:

```text
/Users/danhpham/Documents/ChatGPT/MCP/dist/index.js
```

### Bước 5 — chọn workspace và mode bằng terminal (tùy chọn)

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

### Bước 6A — chạy qua stdio (khuyến nghị)

```bash
node dist/index.js \
  --root /tmp/workspaceguard-demo \
  --transport stdio \
  --mode read-only
```

Terminal sẽ chờ MCP client gửi request qua stdin. Đây là hành vi đúng, không phải treo.

### Bước 6B — bật quyền ghi

```bash
node dist/index.js \
  --root /tmp/workspaceguard-demo \
  --transport stdio \
  --mode workspace-write
```

`trash_path` mặc định `dry_run=true`. Chỉ khi caller gửi `dry_run=false` thì path mới được chuyển vào trash.

### Bước 6C — cho phép tự chạy lệnh terminal

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

### Bước 7 — nối ChatGPT bằng giao diện Secure MCP Tunnel

Trên OpenAI Platform, tạo một Secure MCP Tunnel và runtime API key có quyền dùng tunnel. Tải `tunnel-client` phù hợp hệ điều hành. Không gửi Runtime API key cho Codex và không ghi nó vào `.env`, source hay Git.

Trong app, sau khi MCP đã báo **Đang chạy**:

1. Dán **Tunnel ID** có dạng `tunnel_...`.
2. Dán **Runtime API key**. Lần sau có thể để trống để dùng key đã lưu mã hóa.
3. Nhập `tunnel-client` nếu binary đã nằm trong `PATH`, hoặc nhấn **Chọn file…** để chọn binary đã tải.
4. Giữ profile mặc định, nhấn **Kết nối Tunnel**, đợi thông báo “sẵn sàng cho ChatGPT”.
5. Nhấn **Ngắt Tunnel** nếu chỉ muốn ngắt ChatGPT; nhấn **Dừng** để dừng cả Tunnel lẫn MCP server.

App thực hiện tương đương chuỗi `tunnel-client init --sample sample_mcp_remote_no_auth` → `doctor --explain` → `run`, với endpoint MCP `http://127.0.0.1:<cổng>/mcp`, health endpoint cục bộ và header token truyền bằng biến môi trường. Các profile tunnel nằm trong dữ liệu riêng của app, không trong workspace.

Trong ChatGPT Web, bật Developer Mode/custom MCP app theo policy của workspace, tạo app mới, chọn kết nối **Tunnel**, chọn tunnel vừa tạo, chạy **Scan Tools**, sau đó thử `workspace_info`, `list_files` và `read_file` trước khi bật tool ghi. Nếu không thấy lựa chọn Tunnel, kiểm tra workspace đã được cấp quyền đọc và dùng Tunnel.

### Bước 8 — HTTP loopback (tùy chọn)

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
├── desktop/                  # Electron main/preload + renderer an toàn
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
