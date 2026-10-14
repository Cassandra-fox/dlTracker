import dayjs from 'dayjs';
export function nowIso(): string { return dayjs().toISOString(); }
export function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
export function noteLength(value: string): number { return [...value].length; }
export function toYen(value?: number | null): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value).toLocaleString('ja-JP')}円` : '-';
}
export function safeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}
export function toCsvCell(raw: string | number | null | undefined): string {
  if (raw === undefined || raw === null) return '';
  const value = String(raw);
  const prefix = /^[=+\-@\t\r\n]/.test(value) ? "'" : '';
  return prefix || /[,"\r\n]/.test(value) ? `"${prefix}${value.replaceAll('"', '""')}"` : value;
}
