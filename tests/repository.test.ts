import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { deleteDB, openDB } from 'idb';
import { closeDb, getDb } from '@/db/index';
import { appendTrackedProducts, beginAttempt, cleanExpiredCache, commitAttempt, getPriceRecord, getTracking, listTrackedRecords, observeProduct, removeTrackedProducts, saveTrackingNote, trackingCount } from '@/db/repository';
import { emptyPrice } from '@/shared/price';

beforeEach(async () => { await closeDb(); await deleteDB('dltracker'); });
afterEach(async () => { await closeDb(); });

test('append is idempotent, keeps absent members and exposes missing prices', async () => {
  await appendTrackedProducts([{ rjCode: 'RJ123456' }, { rjCode: 'BJ123456' }]);
  const original = (await getTracking('RJ123456'))!;
  await saveTrackingNote(original.rjCode, '保留备注', 0, original.trackingToken);
  const result = await appendTrackedProducts([{ rjCode: 'RJ123456' }, { rjCode: 'RJ123456' }]);
  assert.equal(result.added, 0);
  assert.equal(await trackingCount(), 2);
  assert.equal((await getTracking('RJ123456'))!.addedAt, original.addedAt);
  assert.equal((await getTracking('RJ123456'))!.note, '保留备注');
  assert.equal((await listTrackedRecords()).filter((r) => r.lowestPrice === null).length, 2);
  await appendTrackedProducts([]);
  assert.equal(await trackingCount(), 2);
});
test('notes, observed current price and remote result survive overlapping writes', async () => {
  await appendTrackedProducts([{ rjCode: 'RJ123456' }]);
  const favorite = (await getTracking('RJ123456'))!;
  const attempt = (await beginAttempt(favorite.rjCode, favorite.trackingToken))!;
  await Promise.all([
    saveTrackingNote(favorite.rjCode, '用户字段', 0, favorite.trackingToken),
    observeProduct({ rjCode: favorite.rjCode, currentPrice: 150, observedAt: '2026-01-02T00:00:00.000Z' }),
    commitAttempt(attempt, { status: 'success', lowestPrice: 100, discountRate: 50, regularPrice: 200 }),
  ]);
  await observeProduct({ rjCode: favorite.rjCode, currentPrice: 300, observedAt: '2026-01-01T00:00:00.000Z' });
  const record = (await listTrackedRecords())[0];
  assert.equal(record.note, '用户字段');
  assert.equal(record.currentPrice, 150);
  assert.equal(record.lowestPrice, 100);
  await assert.rejects(saveTrackingNote(favorite.rjCode, '旧页面', 0, favorite.trackingToken), /其他页面/);
  await assert.rejects(saveTrackingNote(favorite.rjCode, 'x'.repeat(1001), 1, favorite.trackingToken), /1000/);
  await saveTrackingNote(favorite.rjCode, '', 1, favorite.trackingToken);
  assert.equal((await getTracking(favorite.rjCode))!.note, '');
});
test('out-of-order results preserve the minimum and latest attempt status', async () => {
  await appendTrackedProducts([{ rjCode: 'RJ123456' }]);
  const favorite = (await getTracking('RJ123456'))!;
  const older = (await beginAttempt(favorite.rjCode, favorite.trackingToken))!;
  const newer = (await beginAttempt(favorite.rjCode, favorite.trackingToken))!;
  await commitAttempt(newer, { status: 'success', lowestPrice: 90, regularPrice: 100, discountRate: 10 });
  await commitAttempt(older, { status: 'success', lowestPrice: 80, regularPrice: 200, discountRate: 60 });
  assert.deepEqual([(await getPriceRecord(favorite.rjCode))!.lowestPrice, (await getPriceRecord(favorite.rjCode))!.discountRate], [80, 60]);
  assert.equal(await commitAttempt(older, { status: 'failed', error: 'timeout' }), false);
  assert.equal((await getPriceRecord(favorite.rjCode))!.lastAttemptResult, 'success');
});
test('delete retains cache but clears notes; old tracked responses cannot resurrect membership', async () => {
  await appendTrackedProducts([{ rjCode: 'VJ123456' }]);
  const favorite = (await getTracking('VJ123456'))!;
  await saveTrackingNote(favorite.rjCode, '会删除', 0, favorite.trackingToken);
  const first = (await beginAttempt(favorite.rjCode, favorite.trackingToken))!;
  await commitAttempt(first, { status: 'success', lowestPrice: 100 });
  const stale = (await beginAttempt(favorite.rjCode, favorite.trackingToken))!;
  const successAt = (await getPriceRecord(favorite.rjCode))!.lastSuccessAt;
  assert.equal(await removeTrackedProducts([favorite.rjCode, favorite.rjCode]), 1);
  assert.equal(await trackingCount(), 0);
  assert.equal(await commitAttempt(stale, { status: 'success', lowestPrice: 50 }), false);
  const reimport = await appendTrackedProducts([{ rjCode: favorite.rjCode }]);
  assert.equal(reimport.reused, 1);
  const current = (await getTracking(favorite.rjCode))!;
  assert.notEqual(current.trackingToken, favorite.trackingToken);
  assert.equal(current.note, '');
  assert.equal(await commitAttempt(stale, { status: 'success', lowestPrice: 20 }), false);
  assert.equal((await getPriceRecord(favorite.rjCode))!.lastSuccessAt, successAt);
});
test('cache requests cannot write tracked history after import', async () => {
  await observeProduct({ rjCode: 'RJ123456' });
  const cacheAttempt = (await beginAttempt('RJ123456', null))!;
  await appendTrackedProducts([{ rjCode: 'RJ123456' }]);
  assert.equal(await commitAttempt(cacheAttempt, { status: 'success', lowestPrice: 10 }), false);
  assert.equal((await getPriceRecord('RJ123456'))!.lowestPrice, null);
});
test('cleanup atomically respects tracking and recently refreshed records', async () => {
  const db = await getDb();
  const old = '2020-01-01T00:00:00.000Z';
  for (const code of ['RJ123456', 'RJ123457', 'RJ123458']) await db.put('prices', { ...emptyPrice(code, old), lowestPrice: 20, lastSuccessAt: old });
  await appendTrackedProducts([{ rjCode: 'RJ123456' }]);
  const attempt = (await beginAttempt('RJ123457', null))!;
  await commitAttempt(attempt, { status: 'success', lowestPrice: 10 });
  assert.equal(await cleanExpiredCache(), 1);
  assert.ok(await getPriceRecord('RJ123456'));
  assert.ok(await getPriceRecord('RJ123457'));
  assert.equal(await getPriceRecord('RJ123458'), undefined);
});
test('v2 upgrades preserve both legacy sources, initialise notes and missing-price rows', async () => {
  const legacy = await openDB('dltracker', 2, {
    upgrade(db) {
      const prices = db.createObjectStore('prices', { keyPath: 'rjCode' });
      prices.createIndex('by-isFavorite', 'isFavorite');
      prices.createIndex('by-updatedAt', 'updatedAt');
      prices.createIndex('by-lastChecked', 'lastChecked');
      prices.createIndex('by-lowestPrice', 'lowestPrice');
      db.createObjectStore('favorites', { keyPath: 'rjCode' }).createIndex('by-addedAt', 'addedAt');
      db.createObjectStore('settings', { keyPath: 'key' }).createIndex('by-updatedAt', 'updatedAt');
    },
  });
  await legacy.put('prices', { ...emptyPrice('RJ123456', '2020-01-01'), lowestPrice: 123, isFavorite: true, lastChecked: '2026-01-01' });
  await legacy.put('favorites', { rjCode: 'BJ123456', addedAt: '2021-01-01' });
  legacy.close();
  const upgraded = await getDb();
  assert.equal(upgraded.version, 3);
  assert.equal(upgraded.transaction('prices').store.indexNames.contains('by-isFavorite'), false);
  const records = await listTrackedRecords();
  assert.equal(records.length, 2);
  assert.equal(records.find((r) => r.rjCode === 'RJ123456')!.lowestPrice, 123);
  assert.equal(records.find((r) => r.rjCode === 'RJ123456')!.lastSuccessAt, undefined);
  assert.equal(records.find((r) => r.rjCode === 'BJ123456')!.lowestPrice, null);
  assert.ok(records.every((r) => r.note === '' && !!r.trackingToken));
  await closeDb();
  assert.equal((await listTrackedRecords()).length, 2);
});
