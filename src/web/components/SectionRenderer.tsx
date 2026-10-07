import { useMemo, useState } from 'react';
import type { ExplainerSection, QuizQuestion } from '../../core/types';
import { Markdown } from '../lib/markdown';
import { highlightCode } from '../lib/highlight';
import { DiagramView } from './DiagramView';

export interface SectionRendererProps {
  section: ExplainerSection;
  /** Position among the diagram sections, so Mermaid SVGs can be matched on export. */
  diagramIndex?: number;
  onOpenFile?: (path: string, startLine?: number, endLine?: number) => void;
}

export function SectionRenderer({ section, diagramIndex = 0, onOpenFile }: SectionRendererProps) {
  switch (section.type) {
    case 'prose':
      return (
        <section className="card" id={section.id}>
          <h3>
            {section.title}
            {section.level === 'deep' ? <span className="badge">background</span> : null}
          </h3>
          <Markdown markdown={section.markdown} />
        </section>
      );
    case 'callout':
      return (
        <section className={`callout callout-${section.variant}`} id={section.id}>
          <h4>{section.title}</h4>
          <Markdown markdown={section.markdown} />
        </section>
      );
    case 'diagram':
      return (
        <section className="card" id={section.id}>
          <h3>{section.title}</h3>
          <DiagramView diagram={section.diagram} index={diagramIndex} />
          {section.caption ? <p className="caption">{section.caption}</p> : null}
        </section>
      );
    case 'code':
      return (
        <section className="card" id={section.id}>
          <h3>{section.title}</h3>
          <CodeBlock
            code={section.code}
            language={section.language}
            highlights={section.highlights}
            file={section.file}
            startLine={section.startLine}
            onOpenFile={onOpenFile}
          />
          {section.caption ? <p className="caption">{section.caption}</p> : null}
        </section>
      );
    case 'list':
      return (
        <section className="card" id={section.id}>
          <h3>{section.title}</h3>
          <dl className="term-list">
            {section.items.map((item, index) => (
              <div className="term" key={index}>
                <dt>
                  <Markdown markdown={item.term} />
                </dt>
                <dd>
                  <Markdown markdown={item.detail} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      );
    case 'steps':
      return (
        <section className="card" id={section.id}>
          <h3>{section.title}</h3>
          <ol className="steps">
            {section.steps.map((step, index) => (
              <li key={index}>
                <strong>{step.label}</strong>
                <Markdown markdown={step.detail} />
              </li>
            ))}
          </ol>
        </section>
      );
    case 'table':
      return (
        <section className="card" id={section.id}>
          <h3>{section.title}</h3>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {section.headers.map((header, index) => (
                    <th key={index}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex}>
                        <Markdown markdown={cell} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      );
    case 'quiz':
      return <Quiz title={section.title} questions={section.questions} id={section.id} />;
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Code
 * ------------------------------------------------------------------ */

interface CodeBlockProps {
  code: string;
  language?: string;
  highlights?: number[];
  file?: string;
  startLine?: number;
  onOpenFile?: (path: string, startLine?: number, endLine?: number) => void;
  showLineNumbers?: boolean;
}

export function CodeBlock({ code, language, highlights, file, startLine = 1, onOpenFile, showLineNumbers }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const { html } = useMemo(() => highlightCode(code, language), [code, language]);
  const lines = useMemo(() => {
    // Re-split highlighted HTML on newlines so we can attach line numbers and
    // highlight rows without breaking multi-line spans.
    return html.split('\n');
  }, [html]);
  const highlightSet = useMemo(() => new Set(highlights ?? []), [highlights]);
  const withNumbers = showLineNumbers ?? true;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard may be unavailable */
    }
  };

  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span className="code-meta">
          {file ? (
            <button type="button" className="link-button" onClick={() => onOpenFile?.(file, startLine)} title={`Open ${file}`}>
              {file}
              {startLine > 1 ? `:${startLine}` : ''}
            </button>
          ) : (
            <span className="muted">{language ?? 'code'}</span>
          )}
        </span>
        <button type="button" className="ghost-button" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="code">
        <code>
          {lines.map((line, index) => {
            const lineNumber = startLine + index;
            const isHighlighted = highlightSet.has(index + 1) || highlightSet.has(lineNumber);
            return (
              <span className={`code-line${isHighlighted ? ' highlighted' : ''}`} key={index}>
                {withNumbers ? <span className="code-lineno">{lineNumber}</span> : null}
                <span className="code-text" dangerouslySetInnerHTML={{ __html: line || ' ' }} />
              </span>
            );
          })}
        </code>
      </pre>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Quiz
 * ------------------------------------------------------------------ */

function Quiz({ title, questions, id }: { title: string; questions: QuizQuestion[]; id: string }) {
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [score, setScore] = useState({ correct: 0, answered: 0 });

  const choose = (question: QuizQuestion, index: number) => {
    if (answers[question.id] !== undefined) return;
    setAnswers((previous) => ({ ...previous, [question.id]: index }));
    setScore((previous) => ({ correct: previous.correct + (index === question.answer ? 1 : 0), answered: previous.answered + 1 }));
  };

  return (
    <section className="card quiz" id={id}>
      <h3>
        {title}
        {score.answered > 0 ? (
          <span className="score">
            {score.correct}/{score.answered} correct
          </span>
        ) : null}
      </h3>
      <p className="caption">Pick an answer to see whether you were right. Nothing is scored or sent anywhere.</p>
      {questions.map((question, questionIndex) => {
        const chosen = answers[question.id];
        return (
          <div className="quiz-question" key={question.id}>
            <p className="quiz-prompt">
              <span className="quiz-number">Q{questionIndex + 1}</span>
              {question.question}
            </p>
            <div className="quiz-options">
              {question.options.map((option, optionIndex) => {
                const isChosen = chosen === optionIndex;
                const isAnswer = optionIndex === question.answer;
                const revealed = chosen !== undefined;
                const className = [
                  'quiz-option',
                  revealed && isAnswer ? 'correct' : '',
                  revealed && isChosen && !isAnswer ? 'incorrect' : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <button type="button" className={className} key={optionIndex} onClick={() => choose(question, optionIndex)} disabled={revealed}>
                    {option}
                  </button>
                );
              })}
            </div>
            {chosen !== undefined ? (
              <p className={`quiz-feedback ${chosen === question.answer ? 'correct' : 'incorrect'}`}>
                <strong>{chosen === question.answer ? 'Correct. ' : 'Not quite. '}</strong>
                {question.explanation}
              </p>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
