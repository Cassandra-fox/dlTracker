import type { TrackedRecord } from '@/shared/types';
import { errorMessage, operationSummary, sendRuntimeMessage, waitForOperation } from '@/shared/runtime';
import { priceStatus } from '@/shared/price';
import { parseDlsiteProductUrl } from '@/shared/product';
import { MAX_NOTE_LENGTH } from '@/shared/constants';
import { noteLength, toYen } from '@/shared/utils';

const statusEl = document.getElementById('status') as HTMLParagraphElement;
const tableBody = document.getElementById('table-body') as HTMLTableSectionElement;
const selectAll = document.getElementById('select-all') as HTMLInputElement;
const selectionEl = document.getElementById('selection-status')!;
const selected = new Set<string>();
const rows = new Map<string, Row>();
let records: TrackedRecord[] = [];
let busy = false;
let failedCodes: string[] = [];
let loadSequence = 0;

interface Row {
  element: HTMLTableRowElement;
  checkbox: HTMLInputElement;
  cells: HTMLTableCellElement[];
  record: TrackedRecord;
  editing: boolean;
  updateButton: HTMLButtonElement;
}

function setStatus(message: string): void { statusEl.textContent = message; }
function button(id: string): HTMLButtonElement { return document.getElementById(id) as HTMLButtonElement; }
function run(action: () => Promise<void>): void { void action().catch((error: unknown) => setStatus(errorMessage(error))); }
function formatTime(value?: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) return '-';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
function updateControls(): void {
  selectionEl.textContent = `共 ${records.length} 个追踪作品，已选择 ${selected.size} 项`;
  selectAll.checked = records.length > 0 && selected.size === records.length;
  selectAll.indeterminate = selected.size > 0 && selected.size < records.length;
  selectAll.disabled = !records.length;
  button('update-selected').disabled = busy || !selected.size;
  button('delete-selected').disabled = busy || !selected.size;
  button('update-all').disabled = busy || !records.length;
  button('retry-failed').disabled = busy || !failedCodes.length;
  for (const row of rows.values()) { row.checkbox.checked = selected.has(row.record.rjCode); row.updateButton.disabled = busy; }
}
function showNote(row: Row): void {
  const cell = row.cells[6];
  cell.replaceChildren();
  const display = document.createElement('div');
  display.className = 'note-preview';
  display.textContent = row.record.note || '—';
  const edit = document.createElement('button');
  edit.textContent = '编辑备注';
  edit.addEventListener('click', () => editNote(row));
  cell.append(display, edit);
}
function editNote(row: Row): void {
  row.editing = true;
  const original = row.record;
  const cell = row.cells[6];
  cell.replaceChildren();
  const input = document.createElement('textarea');
  input.rows = 4;
  input.value = original.note;
  input.setAttribute('aria-label', `${original.rjCode} 的备注`);
  const count = document.createElement('span');
  const save = document.createElement('button');
  const cancel = document.createElement('button');
  save.textContent = '保存';
  cancel.textContent = '取消 / 载入最新备注';
  function updateCount(): void {
    const length = noteLength(input.value);
    count.textContent = `${length}/${MAX_NOTE_LENGTH}`;
    save.disabled = length > MAX_NOTE_LENGTH;
  }
  input.addEventListener('input', updateCount);
  updateCount();
  cancel.addEventListener('click', () => { row.editing = false; showNote(row); });
  save.addEventListener('click', () => run(async () => {
    save.disabled = true;
    cancel.disabled = true;
    input.disabled = true;
    try {
      const saved = await sendRuntimeMessage({ type: 'SAVE_NOTE', payload: {
        rjCode: original.rjCode, note: input.value, revision: original.noteRevision, trackingToken: original.trackingToken,
      } });
      row.record = { ...row.record, ...saved };
      row.editing = false;
      showNote(row);
      setStatus('备注已保存');
    } finally { input.disabled = false; cancel.disabled = false; updateCount(); }
  }));
  cell.append(input, count, save, cancel);
  input.focus();
}

function refreshRow(row: Row, record: TrackedRecord): void {
  row.record = record;
  const codeCell = row.cells[1];
  const product = record.dlsiteUrl ? parseDlsiteProductUrl(record.dlsiteUrl) : null;
  codeCell.replaceChildren();
  if (product?.rjCode === record.rjCode) {
    const link = document.createElement('a');
    link.href = product.dlsiteUrl!;
    link.textContent = record.rjCode;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    codeCell.append(link);
  } else codeCell.textContent = record.rjCode;
  row.cells[2].textContent = record.title === record.rjCode ? '—' : record.title;
  row.cells[2].title = record.title;
  row.cells[3].textContent = toYen(record.lowestPrice) + (record.lowestPrice !== null && record.discountRate !== undefined ? `（${record.discountRate}%OFF）` : '');
  row.cells[4].textContent = priceStatus(record);
  row.cells[4].title = `最近尝试：${formatTime(record.lastAttemptAt)}${record.lastErrorCode ? '\n' + record.lastErrorCode : ''}`;
  row.cells[5].textContent = formatTime(record.lastSuccessAt);
  if (!row.editing) showNote(row);
}
function createRow(record: TrackedRecord): Row {
  const element = document.createElement('tr');
  const cells = Array.from({ length: 8 }, () => element.insertCell());
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.setAttribute('aria-label', `选择 ${record.rjCode}`);
  checkbox.addEventListener('change', () => {
    if (checkbox.checked) selected.add(record.rjCode); else selected.delete(record.rjCode);
    updateControls();
  });
  cells[0].append(checkbox);
  cells[2].className = 'cell-title';
  const updateButton = document.createElement('button');
  updateButton.textContent = '更新';
  updateButton.addEventListener('click', () => run(() => updateProducts([record.rjCode])));
  cells[7].append(updateButton);
  const row = { element, cells, checkbox, record, editing: false, updateButton };
  refreshRow(row, record);
  return row;
}

async function loadTable(): Promise<void> {
  const sequence = ++loadSequence;
  const next = await sendRuntimeMessage({ type: 'LIST_RECORDS' });
  if (sequence !== loadSequence) return;
  records = next.sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.rjCode.localeCompare(b.rjCode));
  const present = new Set(records.map((r) => r.rjCode));
  for (const [code, row] of rows) if (!present.has(code)) { row.element.remove(); rows.delete(code); selected.delete(code); }
  let previous: HTMLTableRowElement | null = null;
  for (const record of records) {
    const row = rows.get(record.rjCode) ?? createRow(record);
    rows.set(record.rjCode, row);
    refreshRow(row, record);
    // Keep existing DOM nodes and editor drafts; order is stable by first import time.
    const expectedPosition: ChildNode | null = previous ? previous.nextSibling : tableBody.firstChild;
    if (expectedPosition !== row.element) tableBody.insertBefore(row.element, expectedPosition);
    previous = row.element;
  }
  failedCodes = failedCodes.filter((code) => present.has(code));
  updateControls();
}

async function updateProducts(codes?: string[]): Promise<void> {
  if (busy) return;
  busy = true;
  updateControls();
  setStatus('正在准备更新...');
  let refreshedAt = 0;
  try {
    const result = codes?.length === 1
      ? await sendRuntimeMessage({ type: 'UPDATE_ONE', payload: { rjCode: codes[0] } })
      : codes
        ? await sendRuntimeMessage({ type: 'UPDATE_SELECTED', payload: { rjCodes: [...codes] } })
        : await sendRuntimeMessage({ type: 'UPDATE_ALL_FAVORITES' });
    const operation = await waitForOperation(result.operationId, (progress) => {
      setStatus(operationSummary(progress));
      if (Date.now() - refreshedAt > 1500) { refreshedAt = Date.now(); run(loadTable); }
    });
    failedCodes = operation.items.filter((item) => item.status === 'failed').map((item) => item.rjCode);
    setStatus(operationSummary(operation));
  } finally {
    busy = false;
    updateControls();
    await loadTable();
  }
}
selectAll.addEventListener('change', () => {
  for (const record of records) { if (selectAll.checked) selected.add(record.rjCode); else selected.delete(record.rjCode); }
  updateControls();
});
button('refresh').addEventListener('click', () => run(loadTable));
button('update-selected').addEventListener('click', () => run(() => updateProducts([...selected])));
button('update-all').addEventListener('click', () => run(() => updateProducts()));
button('retry-failed').addEventListener('click', () => run(() => updateProducts([...failedCodes])));
button('delete-selected').addEventListener('click', () => run(async () => {
  const codes = [...selected];
  if (!codes.length || !window.confirm(`从本地追踪列表删除所选 ${codes.length} 个作品及备注？不会修改 DLsite 收藏；已有价格可能继续作为临时缓存保留。`)) return;
  busy = true; updateControls();
  try {
    const result = await sendRuntimeMessage({ type: 'DELETE_TRACKED', payload: { rjCodes: codes } });
    setStatus(`已删除 ${result.deleted} 个本地追踪作品`);
  } finally { busy = false; await loadTable(); updateControls(); }
}));
button('export').addEventListener('click', () => run(async () => {
  const { csv } = await sendRuntimeMessage({ type: 'EXPORT_CSV' });
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `dltracker-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('已导出全部本地追踪作品');
}));
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'DATA_CHANGED') run(loadTable);
});
window.addEventListener('focus', () => run(loadTable));
run(loadTable);
