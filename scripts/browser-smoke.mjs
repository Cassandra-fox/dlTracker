// Production-extension smoke test using Chromium's debugging pipe and an isolated profile.
// DLwatcher fetch is stubbed inside this test worker; no personal profile or site account is used.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

const executable = process.argv[2];
if (!executable) throw new Error('Usage: node scripts/browser-smoke.mjs <Chromium executable>');
await mkdir('test-results', { recursive: true });
const profile = await mkdtemp(path.resolve('test-results/profile-'));
const child = spawn(executable, [
  '--headless=new', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update',
  '--enable-unsafe-extension-debugging', '--remote-debugging-pipe',
  '--user-data-dir=' + profile, 'about:blank',
], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
const pending = new Map();
let sequence = 0, buffer = '';
function command(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    child.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
child.stdio[4].setEncoding('utf8');
child.stdio[4].on('data', (data) => {
  buffer += data;
  for (;;) {
    const end = buffer.indexOf('\0');
    if (end < 0) break;
    const text = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (!text) continue;
    const message = JSON.parse(text);
    const item = pending.get(message.id);
    if (!item) continue;
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  }
});
child.on('error', (error) => {
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
  pending.clear();
});
async function evaluate(sessionId, expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function until(action, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await action();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Browser condition timed out');
}

try {
  console.log('Browser:', (await command('Browser.getVersion')).product);
  const { id } = await command('Extensions.loadUnpacked', { path: path.resolve('dist') });
  const origin = 'chrome-extension://' + id;
  const worker = await until(async () => (await command('Target.getTargets')).targetInfos.find((target) => target.type === 'service_worker' && target.url.startsWith(origin)));
  const workerSession = (await command('Target.attachToTarget', { targetId: worker.targetId, flatten: true })).sessionId;
  await evaluate(workerSession, `globalThis.fetch = async () => Response.json({productName: 'Smoke test', lowestPrice: {priceInfo: {price: 100, regularPrice: 200, discountRate: 50}}})`);
  const page = await command('Target.createTarget', { url: origin + '/src/options/index.html' });
  const pageSession = (await command('Target.attachToTarget', { targetId: page.targetId, flatten: true })).sessionId;
  await until(() => evaluate(pageSession, "document.readyState === 'complete' && !!document.getElementById('table-body')"));
  const request = (message) => evaluate(pageSession, 'chrome.runtime.sendMessage(' + JSON.stringify(message) + ')');
  assert.deepEqual(await request({ type: 'GET_IMPORT_PROTOCOL' }), { ok: true, data: { version: 2 } });
  const imported = await request({ type: 'IMPORT_FAVORITES', payload: { products: [{ rjCode: 'RJ900001' }, { rjCode: 'VJ900002' }] } });
  assert.equal(imported.ok, true);
  assert.equal(imported.data.added, 2);
  await until(async () => {
    const result = await request({ type: 'GET_OPERATION', payload: { id: imported.data.operationId } });
    return result.data?.status === 'completed' && result.data.success === 2;
  });
  let records = (await request({ type: 'LIST_RECORDS' })).data;
  assert.equal(records.length, 2);
  assert.ok(records.every((record) => record.lowestPrice === 100));
  const record = records.find((item) => item.rjCode === 'RJ900001');
  assert.equal((await request({ type: 'SAVE_NOTE', payload: { rjCode: record.rjCode, note: 'persist across worker termination', revision: record.noteRevision, trackingToken: record.trackingToken } })).ok, true);

  // Commit one result, keep another request pending, then forcibly terminate the worker.
  await evaluate(workerSession, `globalThis.fetch = async (url, options) => {
    if (String(url).includes('VJ900002')) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 60000);
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, {once: true});
    });
    return Response.json({lowestPrice: {priceInfo: {price: 50, regularPrice: 200, discountRate: 75}}});
  }`);
  const update = await request({ type: 'UPDATE_ALL_FAVORITES' });
  await until(async () => {
    const result = await request({ type: 'GET_OPERATION', payload: { id: update.data.operationId } });
    return result.data?.completed === 1;
  });
  await command('ServiceWorker.enable', {}, pageSession);
  await command('Target.detachFromTarget', { sessionId: workerSession });
  await command('ServiceWorker.stopAllWorkers', {}, pageSession);
  const lost = await request({ type: 'GET_OPERATION', payload: { id: update.data.operationId } });
  assert.equal(lost.data, null);
  records = (await request({ type: 'LIST_RECORDS' })).data;
  assert.equal(records.find((item) => item.rjCode === 'RJ900001').lowestPrice, 50);
  assert.equal(records.find((item) => item.rjCode === 'RJ900001').note, 'persist across worker termination');
  assert.equal(records.find((item) => item.rjCode === 'VJ900002').lowestPrice, 100);

  // Refresh the real options UI, then capture it for inspection.
  await evaluate(pageSession, "document.getElementById('refresh').click()");
  await until(() => evaluate(pageSession, "document.querySelectorAll('tbody tr').length === 2"));
  await command('Emulation.setDeviceMetricsOverride', { width: 1500, height: 900, deviceScaleFactor: 1, mobile: false }, pageSession);
  const screenshot = await command('Page.captureScreenshot', { format: 'png' }, pageSession);
  await writeFile(path.join(profile, 'options.png'), Buffer.from(screenshot.data, 'base64'));

  const deletion = await request({ type: 'DELETE_TRACKED', payload: { rjCodes: ['RJ900001'] } });
  assert.equal(deletion.data.deleted, 1);
  assert.equal((await request({ type: 'GET_STATS' })).data.favorites, 1);
  const csv = await request({ type: 'EXPORT_CSV' });
  assert.ok(csv.data.csv.includes('VJ900002'));
  assert.ok(!csv.data.csv.includes('RJ900001'));
  console.log('PASS: production load, real IndexedDB, notes, partial commit, worker interruption, delete, stats and CSV.');
  console.log('Isolated test artifacts:', profile);
} finally {
  await command('Browser.close').catch(() => {});
  child.stdio[3].end();
  child.stdio[4].destroy();
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Browser closed')); }
  pending.clear();
  child.kill();
}
