import type { TrackedRecord } from '@/shared/types';
import { toCsvCell } from '@/shared/utils';
import { priceStatus } from '@/shared/price';

export function recordsToCsv(records: TrackedRecord[]): string {
  const headers = ['作品编号', '标题', 'DLsite链接', '历史最低价', '对应原价', '对应折扣率', '当前价格', '数据状态', '最近尝试结果', '最近成功更新时间', '备注', 'DLwatcher链接'];
  const rows = records.map((r) => [
    r.rjCode, r.title, r.dlsiteUrl, r.lowestPrice, r.regularPrice, r.discountRate, r.currentPrice,
    priceStatus(r), r.lastAttemptResult, r.lastSuccessAt, r.note, r.dlwatcherUrl,
  ].map(toCsvCell).join(','));
  return '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
}
