import { DLWATCHER_BASE, REQUEST_TIMEOUT_MS } from '@/shared/constants';
import { normalizeProductId } from '@/shared/product';
import type { FetchPriceResult } from '@/shared/types';
import { safeNumber } from '@/shared/utils';
import { PriceScheduler } from './price-scheduler';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parsePriceResponse(raw: unknown): FetchPriceResult {
  const json = object(raw);
  if (!json) return { status: 'failed', error: 'invalid_response:价格响应不是对象' };
  if (!('lowestPrice' in json)) return { status: 'failed', error: 'invalid_response:缺少价格结构' };
  if (json.lowestPrice === null) return { status: 'no_data' };
  const lowest = object(json.lowestPrice);
  if (!lowest) return { status: 'failed', error: 'invalid_response:价格结构不合法' };
  if (lowest.priceInfo === null) return { status: 'no_data' };
  const priceInfo = object(lowest.priceInfo);
  if (!priceInfo) return { status: 'failed', error: 'invalid_response:缺少 priceInfo' };
  if (priceInfo.price === null) return { status: 'no_data' };
  const price = safeNumber(priceInfo.price);
  if (price === undefined) return { status: 'failed', error: 'invalid_response:价格数值不合法' };
  const discount = safeNumber(priceInfo.discountRate);
  return {
    status: 'success', lowestPrice: price,
    title: typeof json.productName === 'string' ? json.productName.slice(0, 2000) : undefined,
    regularPrice: safeNumber(priceInfo.regularPrice),
    discountRate: discount !== undefined && discount <= 100 ? discount : undefined,
  };
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number {
  if (value === null) return 30_000;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(1000, delay) : 30_000;
}

// Deliberately private: all production callers must use the shared scheduler.
async function fetchPrice(code: string): Promise<FetchPriceResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // IndexedDB owns our cache policy; do not replay a browser-cached HTTP error
    // when the user refreshes to retry. Upstream/CDN caching remains server-owned.
    const response = await fetch(`${DLWATCHER_BASE}/${code}.json`, { signal: controller.signal, cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) return {
      status: 'failed', error: `http_${response.status}:上游请求失败`,
      ...(response.status === 429 ? { retryAfterMs: retryAfterMilliseconds(response.headers.get('Retry-After')) } : {}),
    };
    let raw: unknown;
    try { raw = await response.json(); }
    catch {
      return { status: 'failed', error: controller.signal.aborted ? 'timeout:请求超时' : 'invalid_response:无法解析 JSON' };
    }
    return parsePriceResponse(raw);
  } catch {
    return { status: 'failed', error: controller.signal.aborted ? 'timeout:请求超时' : 'network:网络请求失败' };
  } finally { clearTimeout(timer); }
}

const scheduler = new PriceScheduler(fetchPrice);
export function requestDlwatcherPrice(code: string): Promise<FetchPriceResult> {
  const normalized = normalizeProductId(code);
  if (!normalized) return Promise.resolve({ status: 'failed', error: 'invalid_product:无效作品编号' });
  return scheduler.request(normalized);
}
