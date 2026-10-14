import type { FetchPriceResult, PriceRecord } from './types';
import { CACHE_TTL_MS, DLWATCHER_BASE } from './constants';
import { safeNumber } from './utils';

export function emptyPrice(rjCode: string, now: string): PriceRecord {
  return { rjCode, title: rjCode, lowestPrice: null, dlwatcherUrl: `${DLWATCHER_BASE}/${rjCode}/`, isFavorite: false, createdAt: now, updatedAt: now };
}
export function hasPrice(record?: PriceRecord): boolean {
  return record !== undefined && safeNumber(record.lowestPrice) !== undefined;
}
export function isCacheFresh(record: PriceRecord, now = Date.now()): boolean {
  const stamp = record.lastAttemptResult === 'no_data' ? record.lastAttemptFinishedAt : record.lastSuccessAt;
  const age = now - Date.parse(stamp ?? '');
  return age >= 0 && age < CACHE_TTL_MS;
}
export function mergePriceResult(record: PriceRecord, result: FetchPriceResult, now: string): PriceRecord {
  const next = { ...record, lastAttemptResult: result.status, lastAttemptFinishedAt: now, updatedAt: now, lastErrorCode: undefined as string | undefined };
  if (result.status === 'failed') next.lastErrorCode = result.error;
  if (result.status === 'success') {
    next.lastSuccessAt = now;
    if (!hasPrice(record) || result.lowestPrice < record.lowestPrice!) {
      next.lowestPrice = result.lowestPrice;
      next.regularPrice = result.regularPrice;
      next.discountRate = result.discountRate;
    }
    if ((!record.title || record.title === record.rjCode) && result.title) next.title = result.title;
  }
  return next;
}
export function priceStatus(record: PriceRecord): string {
  const available = hasPrice(record);
  if (record.lastAttemptResult === 'failed') return available ? '已获取 · 本次更新失败' : '获取失败';
  if (record.lastAttemptResult === 'no_data') return available ? '已获取 · 本次无有效价格' : '无有效价格数据';
  if (record.lastAttemptAt && !record.lastAttemptFinishedAt) return available ? '已获取 · 最近尝试未完成' : '待获取';
  return available ? '已获取' : '待获取';
}

export function priceFailureMessage(error?: string): string {
  if (error?.startsWith('http_404:')) return 'DLwatcher 暂未提供该作品的价格文件（HTTP 404），可刷新页面重试';
  if (error?.startsWith('http_429:') || error?.startsWith('rate_limited:')) return 'DLwatcher 请求受限，请稍后刷新页面重试';
  const httpStatus = error?.match(/^http_(\d{3}):/)?.[1];
  const reason = httpStatus ? `HTTP ${httpStatus}`
    : error?.startsWith('timeout:') ? '请求超时'
    : error?.startsWith('network:') ? '网络错误'
    : error?.startsWith('invalid_response:') ? '价格响应格式异常' : undefined;
  return `史低获取失败${reason ? `（${reason}）` : ''}，可刷新页面重试`;
}
