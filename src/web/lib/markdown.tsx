import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

const ALLOWED_TAGS = [
  'p', 'br', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'ul', 'ol', 'li', 'a',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span',
];

/**
 * Markdown → safe HTML.
 *
 * Every markdown string in this app originates either from our own templates or
 * from a language model, so raw HTML is escaped before parsing and the result is
 * sanitised again afterwards.
 */
export function markdownToHtml(markdown: string): string {
  if (!markdown) return '';
  const escaped = markdown.replace(/</g, '&lt;');
  let html: string;
  try {
    html = marked.parse(escaped, { async: false }) as string;
  } catch {
    html = `<p>${escaped}</p>`;
  }
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href', 'title', 'target', 'rel'],
  });
}

export interface MarkdownProps {
  markdown: string;
  className?: string;
}

export function Markdown({ markdown, className }: MarkdownProps) {
  return <div className={className ? `prose ${className}` : 'prose'} dangerouslySetInnerHTML={{ __html: markdownToHtml(markdown) }} />;
}
