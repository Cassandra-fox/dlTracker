import { errorMessage, operationSummary, sendRuntimeMessage, waitForOperation } from '@/shared/runtime';

const favoritesEl = document.getElementById('favorites')!;
const statusEl = document.getElementById('status')!;
const update = document.getElementById('update-favorites') as HTMLButtonElement;
function run(action: () => Promise<void>): void { void action().catch((error: unknown) => { statusEl.textContent = errorMessage(error); }); }
async function loadStats(): Promise<void> {
  const stats = await sendRuntimeMessage({ type: 'GET_STATS' });
  favoritesEl.textContent = String(stats.favorites);
}
document.getElementById('open-options')?.addEventListener('click', () => run(() => chrome.runtime.openOptionsPage()));
update.addEventListener('click', () => run(async () => {
  update.disabled = true;
  try {
    statusEl.textContent = '正在更新本地追踪作品...';
    const { operationId } = await sendRuntimeMessage({ type: 'UPDATE_ALL_FAVORITES' });
    await waitForOperation(operationId, (operation) => { statusEl.textContent = operationSummary(operation); });
  } finally { update.disabled = false; await loadStats(); }
}));
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (message && typeof message === 'object' && 'type' in message && message.type === 'DATA_CHANGED') run(loadStats);
});
window.addEventListener('focus', () => run(loadStats));
run(loadStats);
