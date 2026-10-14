import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closeDb } from '@/db/index';
import { appendTrackedProducts, getPriceRecord, getTracking, listTrackedRecords, removeTrackedProducts } from '@/db/repository';
import { getOperation, getOrFetchPrice, startOperation, startUpdate, updatePrice } from '@/background/operations';
import { sleep } from '@/shared/utils';

Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
  runtime: { getPlatformInfo: async () => ({}), sendMessage: async () => undefined },
} });
const calls: string[] = [];
let mode: 'mixed' | 'offline' = 'mixed';
globalThis.fetch = async (input) => {
  const url = String(input);
  calls.push(url);
  if (mode === 'offline') throw new Error('offline');
  const id = url.match(/([RBV]J\d+)\.json/)?.[1];
  await sleep(5);
  if (id === 'RJ200002') return new Response('server error', { status: 500 });
  if (id === 'RJ200003') return Response.json({ lowestPrice: null });
  return Response.json({ productName: '远程标题', lowestPrice: { priceInfo: { price: 100, regularPrice: 200, discountRate: 50 } } });
};
after(async () => { await closeDb(); });
async function completed(id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const operation = getOperation(id)!;
    if (operation.status === 'completed') return operation;
    await sleep(10);
  }
  throw new Error('operation timed out');
}

test('batch settles successes, no data and failures independently, with early persistence', async () => {
  const imported = await appendTrackedProducts(['RJ200001', 'RJ200002', 'RJ200003'].map((rjCode) => ({ rjCode })));
  const id = startOperation(imported.targets);
  assert.equal(startOperation(imported.targets), id);
  const result = await completed(id);
  assert.deepEqual([result.completed, result.success, result.failed, result.noData], [3, 1, 1, 1]);
  assert.equal((await getPriceRecord('RJ200001'))!.lowestPrice, 100);
  assert.equal((await getPriceRecord('RJ200002'))!.lastAttemptResult, 'failed');
  assert.equal((await listTrackedRecords()).length, 3);
  assert.equal(getOperation('missing-operation'), null);
});
test('tracked browsing never fetches; cache browsing coalesces and retains each observation', async () => {
  const before = calls.length;
  await getOrFetchPrice({ rjCode: 'RJ200001', currentPrice: 120 });
  await getOrFetchPrice({ rjCode: 'RJ200002' });
  assert.equal(calls.length, before);
  await Promise.all([
    getOrFetchPrice({ rjCode: 'VJ200001', currentPrice: 150, observedAt: '2026-01-01T00:00:00.000Z' }),
    getOrFetchPrice({ rjCode: 'VJ200001', currentPrice: 120, observedAt: '2026-01-02T00:00:00.000Z' }),
  ]);
  assert.equal(calls.filter((url) => url.includes('VJ200001')).length, 1);
  assert.equal((await getPriceRecord('VJ200001'))!.currentPrice, 120);
  await getOrFetchPrice({ rjCode: 'VJ200001' });
  assert.equal(calls.filter((url) => url.includes('VJ200001')).length, 1);
});
test('single and selected updates keep scope, and failures can be requested again', async () => {
  const before = calls.length;
  const id = await startUpdate(['RJ200001']);
  assert.equal((await completed(id)).total, 1);
  assert.equal(calls.length, before + 1);
  mode = 'offline';
  const favorite = (await getTracking('RJ200001'))!;
  const attempt = await updatePrice(favorite.rjCode, favorite.trackingToken);
  assert.equal(attempt.status, 'failed');
  assert.equal((await getPriceRecord(favorite.rjCode))!.lowestPrice, 100);
  mode = 'mixed';
  assert.equal((await updatePrice(favorite.rjCode, favorite.trackingToken)).status, 'success');
});
test('deleting after task snapshot skips that item instead of restoring tracking', async () => {
  const imported = await appendTrackedProducts([{ rjCode: 'BJ200001' }]);
  await removeTrackedProducts(['BJ200001']);
  const result = await completed(startOperation(imported.targets));
  assert.equal(result.skipped, 1);
  assert.equal(await getTracking('BJ200001'), undefined);
});
