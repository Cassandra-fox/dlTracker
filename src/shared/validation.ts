import { MAX_IMPORT_PRODUCTS, MAX_NOTE_LENGTH } from './constants';
import { normalizeProductId, parseDlsiteProductUrl, uniqueProducts, type ProductInput } from './product';
import type { RuntimeRequest } from './types';
import { noteLength, safeNumber } from './utils';

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('消息格式无效');
  return value as Record<string, unknown>;
}
function code(value: unknown): string {
  const normalized = normalizeProductId(value);
  if (!normalized) throw new Error('无效的作品编号');
  return normalized;
}
function codes(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('作品列表必须是数组');
  return [...new Set(value.map(code))];
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || noteLength(value) > max) throw new Error(`文本格式无效或超过 ${max} 字符`);
  return value;
}
function product(value: unknown): ProductInput {
  const input = object(value);
  const rjCode = code(input.rjCode);
  let parsed: ProductInput | null = null;
  if (input.dlsiteUrl !== undefined) {
    parsed = parseDlsiteProductUrl(text(input.dlsiteUrl, 8192));
    if (!parsed || parsed.rjCode !== rjCode) throw new Error('作品链接与编号不匹配');
  }
  const result: ProductInput = { ...parsed, rjCode };
  if (input.title !== undefined) result.title = text(input.title, 2000);
  if (input.currentPrice !== undefined) {
    const price = safeNumber(input.currentPrice);
    if (price === undefined) throw new Error('当前价格必须是非负有限数值');
    result.currentPrice = price;
  }
  if (input.observedAt !== undefined) {
    const stamp = text(input.observedAt, 64);
    if (!Number.isFinite(Date.parse(stamp)) || Date.parse(stamp) > Date.now() + 60_000) throw new Error('价格观察时间无效');
    result.observedAt = new Date(stamp).toISOString();
  }
  return result;
}

export function parseRequest(value: unknown): RuntimeRequest {
  const request = object(value);
  switch (request.type) {
    case 'GET_IMPORT_PROTOCOL': case 'LIST_RECORDS': case 'UPDATE_ALL_FAVORITES': case 'GET_STATS': case 'EXPORT_CSV':
      return { type: request.type };
    case 'GET_OR_FETCH_PRICE': return { type: request.type, payload: product(request.payload) };
    case 'IMPORT_FAVORITES': {
      const payload = object(request.payload);
      if (payload.products === undefined && 'rjCodes' in payload) throw new Error('收藏页脚本版本过旧，请刷新 DLsite 收藏页后重新导入');
      const input = payload.products;
      if (!Array.isArray(input)) throw new Error('导入列表必须是数组');
      const products = uniqueProducts(input.map(product));
      if (products.length > MAX_IMPORT_PRODUCTS) throw new Error(`单次最多导入 ${MAX_IMPORT_PRODUCTS} 个不同作品，请分批操作`);
      return { type: request.type, payload: { products } };
    }
    case 'UPDATE_ONE': return { type: request.type, payload: { rjCode: code(object(request.payload).rjCode) } };
    case 'UPDATE_SELECTED': case 'DELETE_TRACKED': return { type: request.type, payload: { rjCodes: codes(object(request.payload).rjCodes) } };
    case 'GET_OPERATION': return { type: request.type, payload: { id: text(object(request.payload).id, 100) } };
    case 'SAVE_NOTE': {
      const payload = object(request.payload);
      if (!Number.isInteger(payload.revision) || Number(payload.revision) < 0) throw new Error('备注版本无效');
      return { type: request.type, payload: { rjCode: code(payload.rjCode), note: text(payload.note, MAX_NOTE_LENGTH), revision: payload.revision as number, trackingToken: text(payload.trackingToken, 100) } };
    }
    default: throw new Error('未知请求类型，请刷新扩展页面');
  }
}
