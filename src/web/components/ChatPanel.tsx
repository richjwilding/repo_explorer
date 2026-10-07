import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatSession, Citation } from '../../core/types';
import type { AgentStep } from '../../core/agent/explorer';
import { api, query, streamPost } from '../lib/api';
import { Markdown } from '../lib/markdown';
import { relativeTime, shortPath } from '../lib/format';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  citations?: Citation[];
  /** Evidence the agent went and fetched before answering. */
  steps?: AgentStep[];
  streaming?: boolean;
}

interface ChatListEntry {
  id: string;
  title: string;
  updatedAt: string;
  turns: number;
  preview: string;
}

export interface ChatPanelProps {
  repoId: string;
  providerLabel: string;
  seedQuestion?: string | null;
  onSeedConsumed?: () => void;
  onOpenFile: (path: string, startLine?: number, endLine?: number) => void;
}

export function ChatPanel({ repoId, providerLabel, seedQuestion, onSeedConsumed, onOpenFile }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [sessions, setSessions] = useState<ChatListEntry[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const stream = useRef<{ cancel(): void } | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const data = await api.get<{ chats: ChatListEntry[] }>(`/api/repos/${repoId}/chats`);
      setSessions(data.chats);
    } catch {
      /* ignore */
    }
  }, [repoId]);

  useEffect(() => {
    setMessages([]);
    setSessionId(undefined);
    void refreshSessions();
    void api
      .get<{ suggestions: string[] }>(`/api/repos/${repoId}/questions`)
      .then((data) => setSuggestions(data.suggestions))
      .catch(() => setSuggestions([]));
    return () => stream.current?.cancel();
  }, [repoId, refreshSessions]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Local models can take a minute to produce the first token; a static
  // "Thinking…" reads as a hang, so show that time is passing.
  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    const timer = setInterval(() => setElapsed((previous) => previous + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  const send = useCallback(
    (question: string) => {
      const text = question.trim();
      if (!text || busy) return;
      setDraft('');
      setError(null);
      setBusy(true);
      setStatus('Searching the repository');
      setMessages((previous) => [
        ...previous,
        { role: 'user', content: text },
        { role: 'assistant', content: '', streaming: true },
      ]);

      let assistantText = '';
      stream.current = streamPost(
        `/api/repos/${repoId}/chat`,
        { question: text, sessionId },
        (event) => {
          if (event.type === 'token') {
            assistantText += String(event.delta ?? '');
            setMessages((previous) => {
              const next = [...previous];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') next[next.length - 1] = { ...last, content: assistantText, streaming: true };
              return next;
            });
          } else if (event.type === 'step') {
            const step = event.step as AgentStep;
            setMessages((previous) => {
              const next = [...previous];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                next[next.length - 1] = { ...last, steps: [...(last.steps ?? []), step] };
              }
              return next;
            });
          } else if (event.type === 'status') {
            setStatus(String(event.message ?? ''));
          } else if (event.type === 'citations') {
            const citations = (event.citations ?? []) as Citation[];
            setMessages((previous) => {
              const next = [...previous];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') next[next.length - 1] = { ...last, citations };
              return next;
            });
          } else if (event.type === 'done') {
            setSessionId(String(event.sessionId ?? '') || undefined);
            // Belt and braces: an empty answer must never look like a hang.
            if (!assistantText.trim()) {
              const message = `No answer was produced. Try again, or switch model in the top bar.`;
              setMessages((previous) => {
                const next = [...previous];
                const last = next[next.length - 1];
                if (last && last.role === 'assistant') next[next.length - 1] = { ...last, content: message, streaming: false };
                return next;
              });
            } else {
              setMessages((previous) => {
                const next = [...previous];
                const last = next[next.length - 1];
                if (last && last.role === 'assistant') next[next.length - 1] = { ...last, streaming: false };
                return next;
              });
            }
            setBusy(false);
            setStatus(null);
            void refreshSessions();
          } else if (event.type === 'error') {
            setError(String(event.message ?? 'Something went wrong.'));
            setBusy(false);
            setStatus(null);
            setMessages((previous) => previous.filter((message, index) => !(index === previous.length - 1 && message.streaming)));
          }
        },
      );
    },
    [busy, refreshSessions, repoId, sessionId],
  );

  const loadSession = useCallback(
    async (id: string) => {
      try {
        const data = await api.get<{ chat: ChatSession | null }>(`/api/repos/${repoId}/chat${query({ id })}`);
        if (!data.chat) return;
        setSessionId(data.chat.id);
        setMessages(
          data.chat.turns.map((turn) => ({ role: turn.role, content: turn.content, citations: turn.citations })),
        );
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    },
    [repoId],
  );

  const startNew = useCallback(() => {
    stream.current?.cancel();
    setMessages([]);
    setSessionId(undefined);
    setError(null);
    setBusy(false);
  }, []);

  const emptyState = messages.length === 0;
  const visibleSuggestions = useMemo(() => suggestions.slice(0, 6), [suggestions]);

  // A question handed over from another view (e.g. "Ask about this file").
  const seedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!seedQuestion || seedRef.current === seedQuestion) return;
    seedRef.current = seedQuestion;
    send(seedQuestion);
    onSeedConsumed?.();
  }, [seedQuestion, send, onSeedConsumed]);

  return (
    <div className="chat-layout">
      <aside className="chat-sidebar">
        <button type="button" className="primary-button" onClick={startNew}>
          New conversation
        </button>
        <ul className="chat-list">
          {sessions.map((session) => (
            <li key={session.id}>
              <button type="button" className={session.id === sessionId ? 'active' : ''} onClick={() => void loadSession(session.id)}>
                <span className="chat-title">{session.title}</span>
                <span className="chat-sub">
                  {session.turns} turns · {relativeTime(session.updatedAt)}
                </span>
              </button>
            </li>
          ))}
          {sessions.length === 0 ? <li className="muted pad">No saved conversations yet.</li> : null}
        </ul>
      </aside>

      <div className="chat-main">
        <div className="chat-scroll" ref={scroller}>
          {emptyState ? (
            <div className="chat-empty">
              <h2>Ask the codebase</h2>
              <p className="muted">
                Answers are grounded in retrieved code from this repository and cite the exact files and lines. Model: {providerLabel}.
              </p>
              <div className="suggestion-grid">
                {visibleSuggestions.map((suggestion) => (
                  <button type="button" className="suggestion" key={suggestion} onClick={() => send(suggestion)}>
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {messages.map((message, index) => (
            <div className={`message ${message.role}`} key={index}>
              <div className="message-body">
                {message.content ? (
                  <Markdown markdown={message.content} />
                ) : (
                  <p className="muted">
                    {status ?? 'Thinking…'}
                    {busy ? ` · ${elapsed}s` : ''}
                  </p>
                )}
                {message.steps && message.steps.length > 0 ? (
                  <details className="chat-steps" open={message.streaming === true}>
                    <summary>
                      Investigated with {message.steps.length} tool {message.steps.length === 1 ? 'call' : 'calls'}
                    </summary>
                    <ol>
                      {message.steps.map((step, stepIndex) => (
                        <li key={stepIndex} className={step.failed ? 'muted' : undefined}>
                          <code>{step.tool}</code> {step.summary}
                          {step.thought ? <span className="muted"> — {step.thought}</span> : null}
                        </li>
                      ))}
                    </ol>
                  </details>
                ) : null}
                {message.citations && message.citations.length > 0 ? (
                  <div className="citations">
                    <span className="citations-label">Sources</span>
                    {message.citations.map((citation, citationIndex) => (
                      <button
                        type="button"
                        className="citation"
                        key={`${citation.path}-${citationIndex}`}
                        title={citation.snippet || citation.path}
                        onClick={() => onOpenFile(citation.path, citation.startLine, citation.endLine)}
                      >
                        {shortPath(citation.path, 2)}:{citation.startLine}
                        {citation.endLine ? `-${citation.endLine}` : ''}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          ))}

          {error ? <div className="error-banner">{error}</div> : null}
        </div>

        <form
          className="chat-input"
          onSubmit={(event) => {
            event.preventDefault();
            send(draft);
          }}
        >
          <textarea
            value={draft}
            placeholder="Why does the reindex sweep retry three times? (⌘/Ctrl + Enter to send)"
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                send(draft);
              }
            }}
          />
          <div className="chat-input-actions">
            {status ? <span className="muted">{status}</span> : <span className="muted">Answers cite real files — click a citation to open it.</span>}
            <button type="submit" className="primary-button" disabled={busy || draft.trim().length === 0}>
              {busy ? 'Answering…' : 'Send'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
