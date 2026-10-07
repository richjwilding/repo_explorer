import type { Component, RepoModel, ClientRepoModel, ClientComponent, FileNode, SymbolRecord, SymbolSummary } from '../core/types.js';

export type { ClientRepoModel, ClientComponent, FileNode };

export function toClientModel(model: RepoModel): ClientRepoModel {
  const { files: _files, imports: _imports, components, symbols: _symbols, calls: _calls, ...rest } = model;
  return {
    ...rest,
    components: components.map(toClientComponent),
  };
}

export function toSymbolSummary(symbol: SymbolRecord): SymbolSummary {
  const { id, path, name, kind, container, exported, line, endLine, loc, reachable, entry, callerCount, calleeCount } = symbol;
  return { id, path, name, kind, container, exported, line, endLine, loc, reachable, entry, callerCount, calleeCount };
}

export function toClientComponent(component: Component): ClientComponent {
  const { files, ...rest } = component;
  return { ...rest, fileCount: files.length };
}

/** One level of the file tree, resolved from the analysed file list. */
export function listDirectory(model: RepoModel, dirPath: string): FileNode[] {
  const prefix = dirPath === '' ? '' : `${dirPath.replace(/\/+$/, '')}/`;
  const directories = new Map<string, number>();
  const files: FileNode[] = [];

  for (const file of model.files) {
    if (prefix && !file.path.startsWith(prefix)) continue;
    const relative = prefix ? file.path.slice(prefix.length) : file.path;
    if (!relative) continue;
    const slash = relative.indexOf('/');
    if (slash === -1) {
      files.push({
        name: relative,
        path: file.path,
        type: 'file',
        size: file.size,
        lines: file.lines,
        language: file.language,
        category: file.category,
      });
    } else {
      const dirName = relative.slice(0, slash);
      const fullDir = `${prefix}${dirName}`;
      directories.set(fullDir, (directories.get(fullDir) ?? 0) + 1);
    }
  }

  const dirs: FileNode[] = [...directories.entries()]
    .map(([fullPath, childCount]) => ({ name: fullPath.split('/').pop() as string, path: fullPath, type: 'directory' as const, childCount }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return [...dirs, ...files.sort((a, b) => a.name.localeCompare(b.name))];
}
