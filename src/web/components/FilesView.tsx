import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FileNode, SymbolDetail, SymbolSummary } from '../../core/types';
import { api, query } from '../lib/api';
import { CodeBlock } from './SectionRenderer';
import { baseName, formatLoc, formatNumber, shortPath } from '../lib/format';

interface FilePayload {
  path: string;
  language: string;
  content: string;
  lines: number;
  symbols: { name: string; kind: string; exported: boolean; line: number }[];
  chunks: { id: string; symbol?: string; kind: string; startLine: number; endLine: number }[];
}

interface SearchHit {
  path: string;
  symbol?: string;
  kind: string;
  startLine: number;
  endLine: number;
  score: number;
  preview: string;
}

export interface FilesViewProps {
  repoId: string;
  initialPath?: string | null;
  onAskAbout: (question: string) => void;
}

export function FilesView({ repoId, initialPath, onAskAbout }: FilesViewProps) {
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<FileNode[]>([]);
  const [file, setFile] = useState<FilePayload | null>(null);
  const [symbolQuery, setSymbolQuery] = useState('');
  const [symbols, setSymbols] = useState<SymbolSummary[]>([]);
  const [textQuery, setTextQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [mode, setMode] = useState<'symbols' | 'text'>('symbols');
  const [detail, setDetail] = useState<SymbolDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openFile = useCallback(
    async (path: string, startLine?: number) => {
      try {
        const payload = await api.get<FilePayload>(`/api/repos/${repoId}/file${query({ path })}`);
        setFile(payload);
        setDetail(null);
        if (startLine && startLine > 1) {
          requestAnimationFrame(() => {
            document.querySelector(`[data-line="${startLine}"]`)?.scrollIntoView({ block: 'center' });
          });
        }
      } catch (openError) {
        setError(openError instanceof Error ? openError.message : String(openError));
      }
    },
    [repoId],
  );

  useEffect(() => {
    if (initialPath) void openFile(initialPath);
  }, [initialPath, openFile]);

  useEffect(() => {
    void api
      .get<{ path: string; entries: FileNode[] }>(`/api/repos/${repoId}/files${query({ path: dir })}`)
      .then((data) => setEntries(data.entries))
      .catch((listError) => setError(listError instanceof Error ? listError.message : String(listError)));
  }, [repoId, dir]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (mode === 'symbols' && symbolQuery.trim().length >= 2) {
        void api
          .get<{ symbols: SymbolSummary[] }>(`/api/repos/${repoId}/symbols${query({ q: symbolQuery, limit: 60 })}`)
          .then((data) => setSymbols(data.symbols))
          .catch(() => setSymbols([]));
      }
      if (mode === 'text' && textQuery.trim().length >= 3) {
        void api
          .get<{ hits: SearchHit[] }>(`/api/repos/${repoId}/search${query({ q: textQuery, limit: 30 })}`)
          .then((data) => setHits(data.hits))
          .catch(() => setHits([]));
      }
    }, 220);
    return () => clearTimeout(timer);
  }, [mode, repoId, symbolQuery, textQuery]);

  const openSymbol = useCallback(async (id: string) => {
    try {
      const data = await api.get<{ symbol: SymbolDetail }>(`/api/repos/${repoId}/symbol${query({ id })}`);
      setDetail(data.symbol);
      void openFile(data.symbol.path, data.symbol.line);
    } catch {
      /* ignore */
    }
  }, [repoId, openFile]);

  const breadcrumb = useMemo(() => ['', ...dir.split('/').filter(Boolean)], [dir]);
  const searching = mode === 'symbols' ? symbolQuery.trim().length >= 2 : textQuery.trim().length >= 3;

  return (
    <div className="files-layout">
      <aside className="files-sidebar">
        <div className="segmented small">
          <button type="button" className={mode === 'symbols' ? 'active' : ''} onClick={() => setMode('symbols')}>
            Symbols
          </button>
          <button type="button" className={mode === 'text' ? 'active' : ''} onClick={() => setMode('text')}>
            Text
          </button>
        </div>
        {mode === 'symbols' ? (
          <input
            className="search-input"
            placeholder="find a function or class…"
            value={symbolQuery}
            onChange={(event) => setSymbolQuery(event.target.value)}
          />
        ) : (
          <input
            className="search-input"
            placeholder="search the code…"
            value={textQuery}
            onChange={(event) => setTextQuery(event.target.value)}
          />
        )}

        {searching ? (
          <div className="search-results">
            {mode === 'symbols'
              ? symbols.map((symbol) => (
                  <button type="button" className="symbol-row" key={symbol.id} onClick={() => void openSymbol(symbol.id)}>
                    <span className="symbol-name">
                      {symbol.container ? <span className="muted">{symbol.container}.</span> : null}
                      {symbol.name}
                    </span>
                    <span className="symbol-meta">
                      {symbol.kind} · {shortPath(symbol.path, 2)}:{symbol.line}
                      {symbol.entry ? ' · entrypoint' : ''}
                      {symbol.callerCount > 0 ? ` · ${symbol.callerCount} callers` : ''}
                    </span>
                  </button>
                ))
              : hits.map((hit, index) => (
                  <button type="button" className="symbol-row" key={`${hit.path}-${index}`} onClick={() => void openFile(hit.path, hit.startLine)}>
                    <span className="symbol-name">{hit.symbol ?? hit.path}</span>
                    <span className="symbol-meta">
                      {shortPath(hit.path, 2)}:{hit.startLine}-{hit.endLine} · score {hit.score}
                    </span>
                  </button>
                ))}
            {mode === 'symbols' && symbols.length === 0 ? <p className="muted pad">No symbols matched.</p> : null}
            {mode === 'text' && hits.length === 0 ? <p className="muted pad">No matches.</p> : null}
          </div>
        ) : (
          <div className="tree-panel">
            <nav className="breadcrumb">
              {breadcrumb.map((segment, index) => (
                <button
                  type="button"
                  className="link-button"
                  key={`${segment}-${index}`}
                  onClick={() => setDir(breadcrumb.slice(0, index + 1).join('/'))}
                >
                  {index === 0 ? 'root' : segment}
                </button>
              ))}
            </nav>
            <ul className="file-list">
              {dir !== '' ? (
                <li>
                  <button type="button" onClick={() => setDir(dir.split('/').slice(0, -1).join('/'))}>
                    <span className="file-dir">↑ ..</span>
                  </button>
                </li>
              ) : null}
              {entries.map((entry) => (
                <li key={entry.path}>
                  <button type="button" className={file?.path === entry.path ? 'active' : ''} onClick={() => (entry.type === 'directory' ? setDir(entry.path) : void openFile(entry.path))}>
                    <span className={entry.type === 'directory' ? 'file-dir' : 'file-name'}>
                      {entry.type === 'directory' ? `${entry.name}/` : entry.name}
                    </span>
                    <span className="file-meta">
                      {entry.type === 'directory' ? `${entry.childCount}` : `${formatLoc(entry.lines)} lines`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>

      <div className="files-main">
        {error ? <div className="error-banner">{error}</div> : null}
        {!file ? (
          <div className="placeholder">
            <h2>Browse the repository</h2>
            <p className="muted">
              Pick a file, or search by symbol name. Every definition shows how many places call it, which is the quickest way to find the
              load-bearing code.
            </p>
          </div>
        ) : (
          <>
            <div className="file-header">
              <div>
                <h2>{baseName(file.path)}</h2>
                <p className="muted">
                  {file.path} · {formatNumber(file.lines)} lines · {file.language}
                </p>
              </div>
              <button
                type="button"
                className="ghost-button"
                onClick={() => onAskAbout(`Explain what ${file.path} does and how it fits into the system.`)}
              >
                Ask about this file
              </button>
            </div>

            {detail ? (
              <section className="card symbol-detail">
                <h3>
                  {detail.container ? <span className="muted">{detail.container}.</span> : null}
                  {detail.name}
                  <span className="chip">{detail.kind}</span>
                </h3>
                <p className="muted">
                  {detail.path}:{detail.line}-{detail.endLine} · {formatLoc(detail.loc)} lines · {detail.callerCount} callers · {detail.calleeCount} callees
                  {detail.entry ? ' · entrypoint' : ''}
                </p>
                <div className="symbol-columns">
                  <div>
                    <h4>Called by</h4>
                    <ul className="mini-list">
                      {detail.callers.slice(0, 20).map((caller, index) => (
                        <li key={index}>
                          <button type="button" className="link-button" onClick={() => void openFile(caller.path, caller.line)}>
                            {caller.container ? `${caller.container}.` : ''}
                            {caller.name}
                            <span className="muted"> {shortPath(caller.path, 2)}:{caller.line}</span>
                          </button>
                        </li>
                      ))}
                      {detail.callers.length === 0 ? <li className="muted">Nothing resolved calls this.</li> : null}
                    </ul>
                  </div>
                  <div>
                    <h4>Calls</h4>
                    <ul className="mini-list">
                      {detail.callees.slice(0, 20).map((callee, index) => (
                        <li key={index}>
                          {callee.external || !callee.path ? (
                            <span>
                              {callee.name} <span className="muted">{callee.external ? 'external' : 'unresolved'}</span>
                            </span>
                          ) : (
                            <button type="button" className="link-button" onClick={() => void openFile(callee.path as string, callee.line ?? 1)}>
                              {callee.name}
                              <span className="muted"> {shortPath(callee.path, 2)}:{callee.line ?? '?'}</span>
                            </button>
                          )}
                        </li>
                      ))}
                      {detail.callees.length === 0 ? <li className="muted">No resolved calls.</li> : null}
                    </ul>
                  </div>
                </div>
              </section>
            ) : null}

            <CodeBlock
              code={file.content}
              language={file.language}
              onOpenFile={() => undefined}
              showLineNumbers
            />
          </>
        )}
      </div>
    </div>
  );
}
