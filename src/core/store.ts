import path from 'node:path';
import fsp from 'node:fs/promises';
import type { AppConfig } from './config.js';
import type { Change, ChatSession, Explainer, RepoModel, RepoRef } from './types.js';
import { readJson, writeJson, ensureDir, pathExists } from './util/fs.js';

export interface RepoRecord {
  repo: RepoRef;
  addedAt: string;
  lastOpenedAt: string;
  lastAnalyzedAt: string | null;
  commitCount: number | null;
  head: string | null;
}

export interface IndexSnapshot {
  version: number;
  repoId: string;
  generatedAt: string;
  chunkCount: number;
  chunks: { id: string; path: string; language: string; kind: string; symbol?: string; startLine: number; endLine: number; text: string }[];
}

/**
 * File-backed store. Everything lives under ~/.repo-explorer so a user can
 * inspect, back up, or delete their data without touching the repositories
 * themselves. The app never writes into the analysed repo.
 */
export class Store {
  constructor(private readonly cfg: AppConfig) {}

  private get dataDir(): string {
    return this.cfg.dataDir;
  }

  repoDir(repoId: string): string {
    return path.join(this.dataDir, 'repos', repoId);
  }

  private async readDirJson<T>(dir: string, id: string): Promise<T | null> {
    return readJson<T>(path.join(dir, `${sanitize(id)}.json`));
  }

  private async writeDirJson(dir: string, id: string, value: unknown): Promise<void> {
    await writeJson(path.join(dir, `${sanitize(id)}.json`), value);
  }

  /* ---------------- repo registry ---------------- */

  async listRepos(): Promise<RepoRecord[]> {
    const records = (await readJson<RepoRecord[]>(path.join(this.dataDir, 'repos.json'))) ?? [];
    return records.sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
  }

  async upsertRepo(record: RepoRecord): Promise<void> {
    const records = (await readJson<RepoRecord[]>(path.join(this.dataDir, 'repos.json'))) ?? [];
    const index = records.findIndex((r) => r.repo.id === record.repo.id);
    if (index >= 0) records[index] = record;
    else records.push(record);
    await writeJson(path.join(this.dataDir, 'repos.json'), records);
  }

  async getRepo(repoId: string): Promise<RepoRecord | null> {
    const records = (await readJson<RepoRecord[]>(path.join(this.dataDir, 'repos.json'))) ?? [];
    return records.find((r) => r.repo.id === repoId) ?? null;
  }

  async forgetRepo(repoId: string): Promise<void> {
    const records = (await readJson<RepoRecord[]>(path.join(this.dataDir, 'repos.json'))) ?? [];
    await writeJson(
      path.join(this.dataDir, 'repos.json'),
      records.filter((r) => r.repo.id !== repoId),
    );
    await fsp.rm(this.repoDir(repoId), { recursive: true, force: true });
  }

  /* ---------------- analysis ---------------- */

  async readModel(repoId: string): Promise<RepoModel | null> {
    return readJson<RepoModel>(path.join(this.repoDir(repoId), 'model.json'));
  }

  async writeModel(repoId: string, model: RepoModel): Promise<void> {
    await writeJson(path.join(this.repoDir(repoId), 'model.json'), model);
  }

  /* ---------------- search index ---------------- */

  async readIndex(repoId: string): Promise<IndexSnapshot | null> {
    return readJson<IndexSnapshot>(path.join(this.repoDir(repoId), 'index.json'));
  }

  async writeIndex(repoId: string, snapshot: IndexSnapshot): Promise<void> {
    await writeJson(path.join(this.repoDir(repoId), 'index.json'), snapshot);
  }

  /* ---------------- explainers ---------------- */

  async readExplainer(repoId: string, explainerId: string): Promise<Explainer | null> {
    return this.readDirJson<Explainer>(path.join(this.repoDir(repoId), 'explainers'), explainerId);
  }

  async writeExplainer(repoId: string, explainer: Explainer): Promise<void> {
    await this.writeDirJson(path.join(this.repoDir(repoId), 'explainers'), explainer.id, explainer);
  }

  async listExplainers(repoId: string): Promise<{ id: string; title: string; kind: string; generatedAt: string; target: string }[]> {
    const dir = path.join(this.repoDir(repoId), 'explainers');
    try {
      const entries = await fsp.readdir(dir);
      const out: { id: string; title: string; kind: string; generatedAt: string; target: string }[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const explainer = await readJson<Explainer>(path.join(dir, entry));
        if (!explainer) continue;
        out.push({
          id: explainer.id,
          title: explainer.title,
          kind: explainer.kind,
          generatedAt: explainer.generatedAt,
          target: explainer.target.label,
        });
      }
      return out.sort((a, b) => b.generatedAt.localeCompare(a.generatedAt));
    } catch {
      return [];
    }
  }

  async deleteExplainer(repoId: string, explainerId: string): Promise<void> {
    await fsp.rm(path.join(this.repoDir(repoId), 'explainers', `${sanitize(explainerId)}.json`), { force: true });
  }

  /* ---------------- changes ---------------- */

  async readChange(repoId: string, changeId: string): Promise<Change | null> {
    return this.readDirJson<Change>(path.join(this.repoDir(repoId), 'changes'), changeId);
  }

  async writeChange(repoId: string, change: Change): Promise<void> {
    await this.writeDirJson(path.join(this.repoDir(repoId), 'changes'), change.id, change);
  }

  /* ---------------- chat ---------------- */

  async listChats(repoId: string): Promise<ChatSession[]> {
    const dir = path.join(this.repoDir(repoId), 'chats');
    try {
      const entries = await fsp.readdir(dir);
      const sessions: ChatSession[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const session = await readJson<ChatSession>(path.join(dir, entry));
        if (session) sessions.push(session);
      }
      return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    } catch {
      return [];
    }
  }

  async readChat(repoId: string, chatId: string): Promise<ChatSession | null> {
    return this.readDirJson<ChatSession>(path.join(this.repoDir(repoId), 'chats'), chatId);
  }

  async writeChat(repoId: string, session: ChatSession): Promise<void> {
    await this.writeDirJson(path.join(this.repoDir(repoId), 'chats'), session.id, session);
  }

  async deleteChat(repoId: string, chatId: string): Promise<void> {
    await fsp.rm(path.join(this.repoDir(repoId), 'chats', `${sanitize(chatId)}.json`), { force: true });
  }

  /* ---------------- exports ---------------- */

  async writeExport(filename: string, contents: string): Promise<string> {
    await ensureDir(this.cfg.exportDir);
    const file = path.join(this.cfg.exportDir, filename);
    await fsp.writeFile(file, contents, 'utf8');
    return file;
  }

  async exists(p: string): Promise<boolean> {
    return pathExists(p);
  }
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 180);
}
