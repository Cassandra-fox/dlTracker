import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { closeDb } from '@/db/index';
import { appendTrackedProducts, getTracking, listTrackedRecords, trackingCount } from '@/db/repository';
import { sleep } from '@/shared/utils';
import { sendRuntimeMessage, waitForOperation } from '@/shared/runtime';

const html = await readFile(new URL('../src/options/index.html', import.meta.url), 'utf8');
const dom = new JSDOM(html, { url: 'chrome-extension://test/src/options/index.html' });
Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
dom.window.confirm = () => true;
type Listener = (message: unknown, sender: chrome.runtime.MessageSender, reply: (value: unknown) => void) => boolean | void;
const listeners: Listener[] = [];
const requests: Array<{ type?: string; payload?: { rjCode?: string; rjCodes?: string[] } }> = [];
const sender = { id: 'test', url: dom.window.location.href };
const runtime = {
  id: 'test', getURL: (path: string) => 'chrome-extension://test/' + path,
  getPlatformInfo: async () => ({}),
  onMessage: { addListener: (listener: Listener) => listeners.push(listener) },
  sendMessage: (message: { type?: string; payload?: { rjCode?: string; rjCodes?: string[] } }) => {
    requests.push(message);
    return new Promise((resolve) => {
      let asyncResponse = false;
      for (const listener of listeners) if (listener(message, sender, resolve) === true) asyncResponse = true;
      if (!asyncResponse) resolve(undefined);
    });
  },
};
Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime, tabs: { onUpdated: { addListener: () => {} } } } });
globalThis.fetch = async () => {
  await sleep(50);
  return Response.json({ lowestPrice: { priceInfo: { price: 100 } } });
};
await appendTrackedProducts([{ rjCode: 'RJ300001', title: '第一部' }, { rjCode: 'VJ300002', title: '第二部' }]);
await import('../src/background/index');
await import('../src/options/main');
after(async () => { await closeDb(); dom.window.close(); });

async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(20); }
  throw new Error('UI did not reach expected state');
}
function findRow(code: string): HTMLTableRowElement {
  return [...dom.window.document.querySelectorAll<HTMLTableRowElement>('tbody tr')].find((row) => row.cells[1].textContent === code)!;
}
function click(id: string): void { (document.getElementById(id) as HTMLButtonElement).click(); }

test('management flow: missing price rows, selection, notes, updates, refresh and deletion', async () => {
  await until(() => document.querySelectorAll('tbody tr').length === 2);
  assert.equal(document.querySelectorAll('thead th').length, 8);
  assert.ok(!document.querySelector('thead')!.textContent!.includes('收藏'));
  const row = findRow('RJ300001');
  assert.match(row.cells[4].textContent!, /待获取/);
  (row.cells[6].querySelector('button') as HTMLButtonElement).click();
  const textarea = row.querySelector('textarea')!;
  textarea.value = '尚未保存的草稿';
  textarea.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  click('refresh');
  await sleep(80);
  assert.equal(findRow('RJ300001').querySelector('textarea'), textarea);
  assert.equal(textarea.value, '尚未保存的草稿');
  const save = [...row.cells[6].querySelectorAll('button')].find((item) => item.textContent === '保存')!;
  save.click();
  await until(async () => (await getTracking('RJ300001'))!.note === '尚未保存的草稿');
  await until(() => !row.querySelector('textarea'));
  const checkbox = row.querySelector<HTMLInputElement>('input[type=checkbox]')!;
  checkbox.click();
  assert.equal((document.getElementById('select-all') as HTMLInputElement).indeterminate, true);
  click('update-selected');
  await until(() => requests.some((request) => request.type === 'UPDATE_ONE' && request.payload?.rjCode === 'RJ300001'));
  await until(() => !(document.getElementById('update-selected') as HTMLButtonElement).disabled);
  assert.equal((await listTrackedRecords()).find((record) => record.rjCode === 'RJ300001')!.note, '尚未保存的草稿');
  assert.equal((await listTrackedRecords()).find((record) => record.rjCode === 'VJ300002')!.lowestPrice, null);
  click('delete-selected');
  await until(async () => await trackingCount() === 1);
  await until(() => document.querySelectorAll('tbody tr').length === 1);
  assert.equal(await getTracking('RJ300001'), undefined);
  const stats = await runtime.sendMessage({ type: 'GET_STATS' });
  assert.deepEqual(stats, { ok: true, data: { favorites: 1 } });
});
test('content sources cannot delete or read notes; malformed messages are errors', async () => {
  async function sendAsContent(message: unknown): Promise<unknown> {
    return new Promise((resolve) => { listeners[0](message, { id: 'test', url: 'https://www.dlsite.com/home/mypage/wishlist' }, resolve); });
  }
  const deletion = await sendAsContent({ type: 'DELETE_TRACKED', payload: { rjCodes: ['VJ300002'] } }) as { ok: boolean };
  const listing = await sendAsContent({ type: 'LIST_RECORDS' }) as { ok: boolean };
  assert.equal(deletion.ok, false);
  assert.equal(listing.ok, false);
  const malformed = await runtime.sendMessage({ type: 'UPDATE_ONE', payload: { rjCode: 'XJ123456' } }) as { ok: boolean };
  assert.equal(malformed.ok, false);
  assert.equal(await trackingCount(), 1);
});

test('wishlist client negotiates import protocol, appends products and completes progress', async () => {
  const originalUrl = sender.url;
  sender.url = 'https://www.dlsite.com/home/mypage/wishlist';
  try {
    const products = [{ rjCode: 'VJ300002' }, { rjCode: 'BJ300003', title: '追加作品' }];
    const first = await sendRuntimeMessage({ type: 'IMPORT_FAVORITES', payload: { products } });
    assert.equal(first.added, 1);
    assert.equal(first.existing, 1);
    const operation = await waitForOperation(first.operationId);
    assert.equal(operation.success, 2);
    const second = await sendRuntimeMessage({ type: 'IMPORT_FAVORITES', payload: { products } });
    assert.equal(second.added, 0);
    assert.equal(second.existing, 2);
    assert.equal(await trackingCount(), 2);
    const legacy = await runtime.sendMessage({ type: 'IMPORT_FAVORITES', payload: { rjCodes: ['RJ999999'] } });
    assert.deepEqual(legacy, { ok: false, error: '收藏页脚本版本过旧，请刷新 DLsite 收藏页后重新导入' });
    assert.equal(await trackingCount(), 2);
  } finally { sender.url = originalUrl; }
});
