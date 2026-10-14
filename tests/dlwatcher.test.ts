import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestDlwatcherPrice } from '@/services/dlwatcher';

test('HTTP 404 remains retryable, bypasses browser HTTP cache and recovers on a later request', async () => {
  const requests: Array<{ url: string; cache?: RequestCache }> = [];
  globalThis.fetch = async (input, options) => {
    requests.push({ url: String(input), cache: options?.cache });
    return requests.length <= 2
      ? new Response('<html>Not found</html>', { status: 404, headers: { 'Cache-Control': 'max-age=604800' } })
      : Response.json({ lowestPrice: { priceInfo: { price: 120 } } });
  };
  assert.deepEqual(await requestDlwatcherPrice('bj03054126'), { status: 'failed', error: 'http_404:上游请求失败' });
  assert.equal((await requestDlwatcherPrice('BJ03054126')).status, 'failed');
  const recovered = await requestDlwatcherPrice('BJ03054126');
  assert.equal(recovered.status, 'success');
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.url === 'https://dlwatcher.com/product/BJ03054126.json' && request.cache === 'no-store'));
});
