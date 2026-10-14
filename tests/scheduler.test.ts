import assert from 'node:assert/strict';
import test from 'node:test';
import { PriceScheduler } from '@/services/price-scheduler';
import type { FetchPriceResult } from '@/shared/types';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
test('all sources share ten network slots, coalesce IDs, and release slots on failure', async () => {
  let active = 0, peak = 0;
  const gates = new Map<string, ReturnType<typeof deferred<FetchPriceResult>>>();
  const starts: string[] = [];
  const scheduler = new PriceScheduler(async (code) => {
    starts.push(code); active++; peak = Math.max(peak, active);
    const gate = deferred<FetchPriceResult>();
    gates.set(code, gate);
    try { return await gate.promise; } finally { active--; }
  }, 10, 0);
  const first = scheduler.request('RJ100000');
  assert.equal(scheduler.request('RJ100000'), first);
  const pending = [first, ...Array.from({ length: 24 }, (_, i) => scheduler.request(`RJ${100001 + i}`))];
  assert.equal(starts.length, 10);
  while (starts.length < 25 || active) {
    const batch = [...gates.entries()];
    gates.clear();
    for (const [code, gate] of batch) gate.resolve(code === 'RJ100002' ? { status: 'failed', error: 'timeout' } : { status: 'success', lowestPrice: 1 });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  const results = await Promise.all(pending);
  assert.equal(peak, 10);
  assert.equal(starts.length, 25);
  assert.equal(results.filter((r) => r.status === 'failed').length, 1);
  const retry = scheduler.request('RJ100002');
  gates.get('RJ100002')!.resolve({ status: 'success', lowestPrice: 0 });
  assert.equal((await retry).status, 'success');
});
test('throwing fetchers settle independently and do not poison deduplication', async () => {
  let calls = 0;
  const scheduler = new PriceScheduler(async () => { if (++calls === 1) throw new Error('offline'); return { status: 'no_data' }; }, 1, 0);
  assert.equal((await scheduler.request('BJ123456')).status, 'failed');
  assert.equal((await scheduler.request('BJ123456')).status, 'no_data');
});
test('long 429 cooldown avoids issuing subsequent requests', async () => {
  let calls = 0;
  const scheduler = new PriceScheduler(async () => { calls++; return { status: 'failed', error: 'http_429', retryAfterMs: 120000 }; }, 1, 0);
  const first = scheduler.request('RJ123456');
  const next = scheduler.request('VJ123456');
  assert.equal((await first).status, 'failed');
  assert.equal((await next).status, 'failed');
  assert.equal(calls, 1);
});
