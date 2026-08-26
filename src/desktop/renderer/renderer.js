const workspacePath = document.querySelector('#workspace-path');
const chooseWorkspace = document.querySelector('#choose-workspace');
const start = document.querySelector('#start');
const stop = document.querySelector('#stop');
const status = document.querySelector('#status');
const message = document.querySelector('#message');
const logs = document.querySelector('#logs');
const port = document.querySelector('#port');
const commandOptions = document.querySelector('#command-options');
const workspaceInput = document.querySelector('#workspace-input');
const runMcpCheck = document.querySelector('#run-mcp-check');
const checkResults = document.querySelector('#check-results');
const writeCheckWarning = document.querySelector('#write-check-warning');
const confirmWriteCheck = document.querySelector('#confirm-write-check');

let workspace = '';
let currentState = null;

function selectedMode() {
  return document.querySelector('input[name="mode"]:checked').value;
}

function render(state) {
  currentState = state;
  status.className = `status ${state.status}`;
  status.textContent = `● ${state.status === 'running' ? 'Đang chạy' : state.status === 'starting' ? 'Đang khởi động' : state.status === 'failed' ? 'Có lỗi' : 'Đã dừng'}`;
  message.textContent = state.message;
  logs.textContent = state.logs.length ? state.logs.join('\n') : 'Chưa có nhật ký.';
  logs.scrollTop = logs.scrollHeight;
  const active = state.status === 'starting' || state.status === 'running';
  start.disabled = active;
  stop.disabled = !active;
  chooseWorkspace.disabled = active;
  workspaceInput.disabled = active;
  port.disabled = active;
  document.querySelectorAll('input[name="mode"]').forEach((input) => { input.disabled = active; });
  document.querySelectorAll('#command-options input').forEach((input) => { input.disabled = active; });
  const canCheck = state.status === 'running';
  const needsWriteApproval = canCheck && state.mode !== 'read-only';
  writeCheckWarning.hidden = !needsWriteApproval;
  confirmWriteCheck.disabled = !needsWriteApproval;
  if (!needsWriteApproval) confirmWriteCheck.checked = false;
  runMcpCheck.disabled = !canCheck || (needsWriteApproval && !confirmWriteCheck.checked);
}

function updateCommandOptions() {
  commandOptions.hidden = selectedMode() !== 'command';
}

chooseWorkspace.addEventListener('click', async () => {
  try {
    const selected = await window.workspaceGuard.chooseWorkspace();
    if (!selected) return;
    workspace = selected;
    workspaceInput.value = selected;
    workspacePath.textContent = selected;
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : 'Không mở được hộp chọn thư mục. Hãy dán đường dẫn ở ô bên dưới.';
  }
});

workspaceInput.addEventListener('input', () => {
  workspace = workspaceInput.value.trim();
  workspacePath.textContent = workspace || 'Chưa chọn thư mục';
});

document.querySelectorAll('input[name="mode"]').forEach((input) => input.addEventListener('change', updateCommandOptions));

start.addEventListener('click', async () => {
  const allowedCommands = [...document.querySelectorAll('#command-options input:checked')].map((input) => input.value);
  try {
    await window.workspaceGuard.start({ root: workspace, mode: selectedMode(), port: Number(port.value), allowedCommands });
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : 'Không thể khởi động MCP server.';
  }
});

stop.addEventListener('click', async () => {
  try { await window.workspaceGuard.stop(); }
  catch (error) { message.textContent = error instanceof Error ? error.message : 'Không thể dừng MCP server.'; }
});

confirmWriteCheck.addEventListener('change', () => {
  if (!currentState) return;
  render(currentState);
});

runMcpCheck.addEventListener('click', async () => {
  runMcpCheck.disabled = true;
  checkResults.replaceChildren(Object.assign(document.createElement('li'), { textContent: 'Đang gọi MCP client…' }));
  try {
    const result = await window.workspaceGuard.runMcpProbe();
    checkResults.replaceChildren(...result.steps.map((step) => {
      const item = document.createElement('li');
      item.className = step.status;
      item.textContent = `${step.status === 'passed' ? '✓' : step.status === 'skipped' ? '–' : '✕'} ${step.name}: ${step.detail}`;
      return item;
    }));
  } catch (error) {
    checkResults.replaceChildren(Object.assign(document.createElement('li'), {
      className: 'failed', textContent: error instanceof Error ? error.message : 'Không thể chạy kiểm tra MCP.',
    }));
  } finally {
    if (currentState) render(currentState);
  }
});

window.workspaceGuard.onState(render);
window.workspaceGuard.getState().then(render);
updateCommandOptions();
