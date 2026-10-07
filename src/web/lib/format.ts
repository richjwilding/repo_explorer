/** Small presentation helpers shared across the UI. */

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value.toLocaleString();
}

export function formatLoc(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1000)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

export function shortPath(filePath: string, segments = 3): string {
  const parts = filePath.split('/');
  if (parts.length <= segments) return filePath;
  return `…/${parts.slice(-segments).join('/')}`;
}

export function dirName(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index === -1 ? '' : filePath.slice(0, index);
}

export function baseName(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index === -1 ? filePath : filePath.slice(index + 1);
}

export const TONE_ORDER = ['primary', 'accent', 'success', 'muted', 'danger'] as const;

export function kindTone(kind: string): string {
  switch (kind) {
    case 'api':
    case 'service':
      return 'primary';
    case 'ui':
    case 'app':
    case 'library':
      return 'accent';
    case 'data':
      return 'success';
    case 'infra':
    case 'tooling':
    case 'docs':
    case 'test':
      return 'muted';
    default:
      return 'primary';
  }
}

export const KIND_LABELS: Record<string, string> = {
  api: 'API',
  service: 'Service',
  ui: 'UI',
  app: 'App',
  library: 'Library',
  cli: 'CLI',
  data: 'Data',
  infra: 'Infra',
  tooling: 'Tooling',
  docs: 'Docs',
  test: 'Tests',
  unknown: 'Module',
};
