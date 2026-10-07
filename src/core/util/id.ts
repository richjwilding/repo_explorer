import crypto from 'node:crypto';

export function sha1(input: string): string {
  return crypto.createHash('sha1').update(input).digest('hex');
}

export function shortHash(input: string, length = 12): string {
  return sha1(input).slice(0, length);
}

/** Deterministic id for a repo path, used for cache directories. */
export function repoId(absPath: string): string {
  return shortHash(absPath, 16);
}

export function uid(prefix = ''): string {
  return `${prefix}${crypto.randomUUID()}`;
}

export function slugify(input: string, maxLength = 60): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || 'untitled';
}

export function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
