import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyPrice, isCacheFresh, mergePriceResult, priceFailureMessage, priceStatus } from '@/shared/price';
import { recordsToCsv } from '@/background/csv';
import { parsePriceResponse, retryAfterMilliseconds } from '@/services/dlwatcher';
import { toCsvCell } from '@/shared/utils';

test('minimum and related metadata remain one snapshot; failures retain old data', () => {
  const initial = { ...emptyPrice('RJ123456', '2026-01-01T00:00:00Z'), currentPrice: 900 };
  const first = mergePriceResult(initial, { status: 'success', lowestPrice: 100, regularPrice: 1000, discountRate: 90 }, '2026-01-01T00:01:00Z');
  const higher = mergePriceResult(first, { status: 'success', lowestPrice: 200, regularPrice: 800, discountRate: 75 }, '2026-01-01T00:02:00Z');
  assert.deepEqual([higher.lowestPrice, higher.regularPrice, higher.discountRate, higher.currentPrice], [100, 1000, 90, 900]);
  const failure = mergePriceResult(higher, { status: 'failed', error: 'timeout' }, '2026-01-01T00:03:00Z');
  assert.equal(failure.lowestPrice, 100);
  assert.equal(failure.lastSuccessAt, higher.lastSuccessAt);
  assert.match(priceStatus(failure), /失败/);
  const lower = mergePriceResult(failure, { status: 'success', lowestPrice: 0 }, '2026-01-01T00:04:00Z');
  assert.equal(lower.lowestPrice, 0);
  assert.equal(lower.discountRate, undefined);
});
test('failed attempts do not extend successful cache TTL', () => {
  const now = Date.parse('2026-01-03T00:00:00Z');
  const record = { ...emptyPrice('RJ123456', '2026-01-01T00:00:00Z'), lowestPrice: 100, lastSuccessAt: '2026-01-01T00:00:00Z' };
  assert.equal(isCacheFresh(mergePriceResult(record, { status: 'failed', error: 'http_500' }, new Date(now).toISOString()), now), false);
});

test('page failures explain the cause and allow refresh without management or tracking', () => {
  for (const [error, cause] of [
    ['http_404:上游请求失败', 'HTTP 404'], ['http_503:上游请求失败', 'HTTP 503'],
    ['network:网络请求失败', '网络错误'], ['timeout:请求超时', '请求超时'],
    ['invalid_response:无法解析 JSON', '价格响应格式异常'], ['http_429:上游请求失败', '请求受限'],
  ]) {
    const message = priceFailureMessage(error);
    assert.ok(message.includes(cause));
    assert.ok(message.includes('刷新页面重试'));
    assert.ok(!message.includes('管理页'));
  }
});
test('remote schema separates valid empty price, invalid responses and zero price', () => {
  assert.equal(parsePriceResponse({ lowestPrice: null }).status, 'no_data');
  assert.equal(parsePriceResponse({ lowestPrice: { priceInfo: { price: 0 } } }).status, 'success');
  for (const raw of [null, [], {}, '<html>', { lowestPrice: { priceInfo: { price: -1 } } }, { lowestPrice: { priceInfo: { price: '100' } } }]) {
    assert.equal(parsePriceResponse(raw).status, 'failed');
  }
  assert.equal(retryAfterMilliseconds('12'), 12000);
  assert.equal(retryAfterMilliseconds('invalid'), 30000);
});
test('CSV includes notes and empty prices, escapes CR/LF, quotes and formulas', () => {
  assert.equal(toCsvCell('a\rb'), '"a\rb"');
  assert.equal(toCsvCell('=1+1'), '"\'=1+1"');
  const csv = recordsToCsv([{ ...emptyPrice('VJ123456', '2026-01-01'), isFavorite: true, note: '一行,"内容"\n第二行', noteRevision: 0, trackingToken: 'x', addedAt: '2026-01-01' }]);
  assert.ok(csv.startsWith('\uFEFF作品编号'));
  assert.ok(csv.includes('备注'));
  assert.ok(csv.includes('"一行,""内容""\n第二行"'));
  assert.ok(csv.includes('待获取'));
});
