import type { Operation, RequestFor, RuntimeProtocol, RuntimeResponse } from './types';
import { sleep } from './utils';
import { IMPORT_PROTOCOL_VERSION } from './constants';

async function checkImportProtocol(): Promise<void> {
  // A rebuilt content script can be loaded while the previous worker still runs.
  // Never fall back to rjCodes: the legacy import can remove existing tracking.
  let response: RuntimeResponse<RuntimeProtocol['GET_IMPORT_PROTOCOL']['data']> | undefined;
  try { response = await chrome.runtime.sendMessage({ type: 'GET_IMPORT_PROTOCOL' }); }
  catch { /* An invalidated context or unavailable worker also requires a reload. */ }
  if (!response?.ok || response.data?.version !== IMPORT_PROTOCOL_VERSION) {
    throw new Error('扩展页面与后台版本不一致或后台不可用。请在扩展管理页重新加载 DLTracker，再刷新 DLsite 收藏页后重试');
  }
}

export async function sendRuntimeMessage<K extends keyof RuntimeProtocol>(message: RequestFor<K>): Promise<RuntimeProtocol[K]['data']> {
  if (message.type === 'IMPORT_FAVORITES') await checkImportProtocol();
  const response: RuntimeResponse<RuntimeProtocol[K]['data']> | undefined = await chrome.runtime.sendMessage(message);
  if (!response) throw new Error('后台未响应，请重新打开页面后重试');
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
export async function waitForOperation(id: string, onProgress?: (operation: Operation) => void): Promise<Operation> {
  for (;;) {
    const operation = await sendRuntimeMessage({ type: 'GET_OPERATION', payload: { id } });
    if (!operation) throw new Error('任务已中断或结果已过期；已保存的数据保留，可主动重新更新');
    onProgress?.(operation);
    if (operation.status === 'completed') return operation;
    await sleep(750);
  }
}
export function operationSummary(operation: Operation): string {
  return `已完成 ${operation.completed}/${operation.total}：成功 ${operation.success}，失败 ${operation.failed}，无有效价格 ${operation.noData}，跳过 ${operation.skipped}`;
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : '操作失败'; }
