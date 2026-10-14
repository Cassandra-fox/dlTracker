import { beginAttempt, commitAttempt, getPriceRecord, listTracking, observeProduct } from '@/db/repository';
import type { ProductInput } from '@/shared/product';
import { hasPrice, isCacheFresh } from '@/shared/price';
import { MAX_CONCURRENT_REQUESTS } from '@/shared/constants';
import type { FavoriteRecord, Operation, OperationItem, PriceRecord } from '@/shared/types';
import { nowIso } from '@/shared/utils';
import { requestDlwatcherPrice } from '@/services/dlwatcher';
import { notifyDataChanged } from './events';

const writesInFlight = new Map<string, Promise<OperationItem>>();
export async function updatePrice(code: string, token: string | null): Promise<OperationItem> {
  const key = `${code}:${token ?? 'cache'}`;
  const existing = writesInFlight.get(key);
  if (existing) return existing;
  const work = (async (): Promise<OperationItem> => {
    try {
      const attempt = await beginAttempt(code, token);
      if (!attempt) return { rjCode: code, status: 'skipped' };
      const result = await requestDlwatcherPrice(code);
      if (!await commitAttempt(attempt, result)) return { rjCode: code, status: 'skipped' };
      return { rjCode: code, status: result.status, ...(result.status === 'failed' ? { error: result.error } : {}) };
    } catch (error) {
      return { rjCode: code, status: 'failed', error: `storage:${error instanceof Error ? error.message : '保存失败'}` };
    }
  })();
  writesInFlight.set(key, work);
  try { return await work; }
  finally { if (writesInFlight.get(key) === work) writesInFlight.delete(key); }
}

export async function getOrFetchPrice(input: ProductInput): Promise<PriceRecord | null> {
  const { record, tracking } = await observeProduct(input);
  const retryMissingPrice = !hasPrice(record) && record.lastAttemptResult === 'failed';
  // A fresh page visit may retry a failed initial lookup, including tracked items.
  // Saved tracked prices still require an explicit management-page update.
  if ((tracking || isCacheFresh(record)) && !retryMissingPrice) return record;
  await updatePrice(input.rjCode, tracking?.trackingToken ?? null);
  return await getPriceRecord(input.rjCode) ?? null;
}

interface StoredOperation { operation: Operation; key: string }
const operations = new Map<string, StoredOperation>();
let keepAlive: ReturnType<typeof setInterval> | undefined;
let activeOperations = 0;
function prune(): void {
  for (const [id, { operation }] of operations) {
    if (operation.finishedAt && Date.now() - Date.parse(operation.finishedAt) > 5 * 60_000) operations.delete(id);
  }
  const completed = [...operations.values()].filter(({ operation }) => operation.status === 'completed');
  for (const entry of completed.slice(0, Math.max(0, completed.length - 10))) operations.delete(entry.operation.id);
}
export function getOperation(id: string): Operation | null {
  prune();
  const operation = operations.get(id)?.operation;
  return operation ? { ...operation, items: operation.status === 'completed' ? operation.items : [] } : null;
}

export function startOperation(targets: FavoriteRecord[], onlyMissing = false): string {
  prune();
  const distinct = [...new Map(targets.map((item) => [item.rjCode, item])).values()];
  const key = JSON.stringify([onlyMissing, distinct.map((item) => `${item.rjCode}:${item.trackingToken}`).sort()]);
  for (const entry of operations.values()) if (entry.key === key && entry.operation.status === 'running') return entry.operation.id;
  const operation: Operation = {
    id: crypto.randomUUID(), status: 'running', total: distinct.length, completed: 0,
    success: 0, noData: 0, failed: 0, skipped: 0, items: [], startedAt: nowIso(),
  };
  operations.set(operation.id, { operation, key });
  activeOperations++;
  if (!keepAlive) keepAlive = setInterval(() => { void chrome.runtime.getPlatformInfo().catch(() => {}); }, 25_000);
  void runOperation(operation, distinct, onlyMissing);
  return operation.id;
}

async function runOperation(operation: Operation, targets: FavoriteRecord[], onlyMissing: boolean): Promise<void> {
  let cursor = 0;
  // Only ten worker promises; each pulls its next item after persistence and settlement.
  const worker = async (): Promise<void> => {
    while (cursor < targets.length) {
      const target = targets[cursor++];
      let item: OperationItem;
      try {
        if (onlyMissing && hasPrice(await getPriceRecord(target.rjCode))) item = { rjCode: target.rjCode, status: 'skipped' };
        else item = await updatePrice(target.rjCode, target.trackingToken);
      } catch (error) {
        item = { rjCode: target.rjCode, status: 'failed', error: error instanceof Error ? error.message : '操作失败' };
      }
      operation.items.push(item);
      operation.completed++;
      if (item.status === 'no_data') operation.noData++;
      else operation[item.status]++;
    }
  };
  try { await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_REQUESTS, targets.length) }, worker)); }
  finally {
    operation.status = 'completed';
    operation.finishedAt = nowIso();
    notifyDataChanged();
    if (--activeOperations === 0 && keepAlive) { clearInterval(keepAlive); keepAlive = undefined; }
  }
}

export async function startUpdate(codes?: string[]): Promise<string> {
  const selected = codes ? new Set(codes) : null;
  return startOperation((await listTracking()).filter((item) => !selected || selected.has(item.rjCode)));
}
