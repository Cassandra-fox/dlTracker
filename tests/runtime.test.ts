import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IMPORT_PROTOCOL_VERSION } from '@/shared/constants';
import { sendRuntimeMessage } from '@/shared/runtime';
import type { RuntimeRequest } from '@/shared/types';

const request = { type: 'IMPORT_FAVORITES', payload: { products: [{ rjCode: 'RJ123456' }] } } as const;
function mockRuntime(sendMessage: (message: RuntimeRequest) => Promise<unknown>): void {
  Object.defineProperty(globalThis, 'chrome', { configurable: true, value: { runtime: { sendMessage } } });
}

for (const [label, response] of [
  ['legacy worker', { ok: false, error: '未知请求类型' }],
  ['missing response', undefined],
  ['incompatible version', { ok: true, data: { version: 1 } }],
  ['missing protocol data', { ok: true }],
] as const) {
  test(`import stops before mutation for ${label}`, async () => {
    const messages: RuntimeRequest[] = [];
    mockRuntime(async (message) => { messages.push(message); return response; });
    await assert.rejects(sendRuntimeMessage({ ...request, payload: { products: [...request.payload.products] } }), /重新加载 DLTracker.*刷新 DLsite 收藏页/);
    assert.deepEqual(messages, [{ type: 'GET_IMPORT_PROTOCOL' }]);
  });
}

test('invalidated extension context gives reload instructions without importing', async () => {
  const messages: RuntimeRequest[] = [];
  mockRuntime(async (message) => { messages.push(message); throw new Error('Extension context invalidated.'); });
  await assert.rejects(sendRuntimeMessage({ ...request, payload: { products: [...request.payload.products] } }), /重新加载 DLTracker/);
  assert.deepEqual(messages, [{ type: 'GET_IMPORT_PROTOCOL' }]);
});

test('compatible imports retain products and recheck the worker on every user action', async () => {
  const messages: RuntimeRequest[] = [];
  const data = { added: 1, existing: 0, reused: 0, operationId: 'operation' };
  let version = IMPORT_PROTOCOL_VERSION;
  mockRuntime(async (message) => {
    messages.push(message);
    return { ok: true, data: message.type === 'GET_IMPORT_PROTOCOL' ? { version } : data };
  });
  assert.deepEqual(await sendRuntimeMessage({ ...request, payload: { products: [...request.payload.products] } }), data);
  assert.deepEqual(messages, [{ type: 'GET_IMPORT_PROTOCOL' }, request]);
  version = 1;
  await assert.rejects(sendRuntimeMessage({ ...request, payload: { products: [...request.payload.products] } }), /重新加载 DLTracker/);
  assert.equal(messages.length, 3);
  assert.equal(messages[2].type, 'GET_IMPORT_PROTOCOL');
});
