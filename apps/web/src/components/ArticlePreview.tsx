import { sanitiseArticle } from '../lib/articleDocument';

/** Third-party HTML is parsed and strictly allowlisted before entering the document view. */
export function ArticlePreview({
  body,
  html,
  compact = false,
}: {
  body: string;
  html: boolean;
  compact?: boolean;
}) {
  return (
    <section aria-label="Article body" className="min-w-0 space-y-3">
      {html ? (
        <div
          className="article-document mx-auto w-full max-w-[70ch]"
          dangerouslySetInnerHTML={{ __html: sanitiseArticle(body) }}
        />
      ) : (
        <div className="whitespace-pre-wrap break-words">{body || '(No body)'}</div>
      )}
      {!compact && (
        <details className="min-w-0">
          <summary className="cursor-pointer text-sm font-medium underline">
            {html ? 'Advanced: stored HTML source (read-only)' : 'Stored Markdown source'}
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface-soft p-3 text-caption [overflow-wrap:anywhere]">
            {body}
          </pre>
        </details>
      )}
    </section>
  );
}
