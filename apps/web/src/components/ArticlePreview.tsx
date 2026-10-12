import { articlePreviewText } from '../lib/blog';

/** All content is escaped by React. No HTML parser, innerHTML, embeds or remote image loads. */
export function ArticlePreview({ body, html }: { body: string; html: boolean }) {
  return (
    <section aria-label="Article body" className="min-w-0 space-y-3">
      <h2 className="text-body font-semibold">Body preview</h2>
      <p className="text-caption text-muted">
        Text preview. Site styling, embedded media and links are omitted.
      </p>
      <div className="whitespace-pre-wrap break-words rounded-md border border-hairline p-4 text-sm [overflow-wrap:anywhere]">
        {html ? articlePreviewText(body) || '(No visible body text)' : body || '(No body)'}
      </div>
      <details className="min-w-0">
        <summary className="cursor-pointer text-sm font-medium underline">
          {html ? 'Stored HTML source' : 'Stored Markdown source'}
        </summary>
        <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-soft p-3 text-caption [overflow-wrap:anywhere]">
          {body}
        </pre>
      </details>
    </section>
  );
}
