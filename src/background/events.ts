export function notifyDataChanged(): void {
  // No open extension page is a normal situation.
  void chrome.runtime.sendMessage({ type: 'DATA_CHANGED' }).catch(() => {});
}
