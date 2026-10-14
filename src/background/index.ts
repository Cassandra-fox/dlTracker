import { appendTrackedProducts, cleanExpiredCache, listTrackedRecords, removeTrackedProducts, saveTrackingNote, trackingCount } from '@/db/repository';
import { parseRequest } from '@/shared/validation';
import type { RuntimeRequest } from '@/shared/types';
import { getOperation, getOrFetchPrice, startOperation, startUpdate } from './operations';
import { notifyDataChanged } from './events';
import { recordsToCsv } from './csv';
import { IMPORT_PROTOCOL_VERSION } from '@/shared/constants';

function authorize(request: RuntimeRequest, sender: chrome.runtime.MessageSender): void {
  if (sender.id !== chrome.runtime.id) throw new Error('消息来源无效');
  const url = sender.url ?? '';
  if (url === chrome.runtime.getURL('src/options/index.html') || url === chrome.runtime.getURL('src/popup/index.html')) return;
  const origin = new URL(url).origin;
  if (origin === 'https://www.dlsite.com' && ['GET_IMPORT_PROTOCOL', 'GET_OR_FETCH_PRICE', 'IMPORT_FAVORITES', 'GET_OPERATION'].includes(request.type)) return;
  throw new Error('该页面不能执行此操作');
}

async function handle(request: RuntimeRequest): Promise<unknown> {
  switch (request.type) {
    case 'GET_IMPORT_PROTOCOL': return { version: IMPORT_PROTOCOL_VERSION };
    case 'GET_OR_FETCH_PRICE': return getOrFetchPrice(request.payload);
    case 'IMPORT_FAVORITES': {
      const { targets, ...counts } = await appendTrackedProducts(request.payload.products);
      const operationId = startOperation(targets, true);
      notifyDataChanged();
      return { ...counts, operationId };
    }
    case 'LIST_RECORDS': return listTrackedRecords();
    case 'UPDATE_ONE': return { operationId: await startUpdate([request.payload.rjCode]) };
    case 'UPDATE_SELECTED': return { operationId: await startUpdate(request.payload.rjCodes) };
    case 'UPDATE_ALL_FAVORITES': return { operationId: await startUpdate() };
    case 'GET_OPERATION': return getOperation(request.payload.id);
    case 'DELETE_TRACKED': {
      const deleted = await removeTrackedProducts(request.payload.rjCodes);
      notifyDataChanged();
      return { deleted };
    }
    case 'SAVE_NOTE': {
      const { rjCode, note, revision, trackingToken } = request.payload;
      const favorite = await saveTrackingNote(rjCode, note, revision, trackingToken);
      notifyDataChanged();
      return favorite;
    }
    case 'GET_STATS': return { favorites: await trackingCount() };
    case 'EXPORT_CSV': return { csv: recordsToCsv(await listTrackedRecords()) };
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (raw && typeof raw === 'object' && 'type' in raw && raw.type === 'DATA_CHANGED') return false;
  void (async () => {
    try {
      const request = parseRequest(raw);
      authorize(request, sender);
      sendResponse({ ok: true, data: await handle(request) });
    } catch (error) {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : '后台处理失败' });
    }
  })();
  return true;
});

// Content scripts initiate page lookups. A second tabs.onUpdated lookup could
// retry immediately after a fast failure, duplicating one page visit's request.
void cleanExpiredCache().catch((error: unknown) => console.error('[DLTracker] 缓存清理失败', error));
