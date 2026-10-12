import { useEffect, useRef, useState } from 'react';
import type { PostView, RemotePostFields } from '@meegrow-social/contracts';
import { ARTICLE_BODY_MAX } from '@meegrow-social/contracts';
import { api } from '../lib/api';
import { articleFields, articlePatch, parseSiteIds } from '../lib/remoteArticle';
import { blogOptions } from '../lib/blog';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Textarea } from './ui/Textarea';
import { Modal } from './ui/Modal';

export function RemoteArticleEditor({
  post,
  onChange,
}: {
  post: PostView;
  onChange: (post: PostView) => void;
}) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [fields, setFields] = useState<RemotePostFields>(() => articleFields(post));
  const [categories, setCategories] = useState((fields.categories ?? []).join(', '));
  const [tags, setTags] = useState((fields.tags ?? []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const remote = blogOptions(post)?.remote;
  const enabled = Boolean(remote?.modifiedAt) && !post.platformRemovedAt && !busy;
  const set = (key: keyof RemotePostFields, value: string | number) =>
    setFields((f) => ({ ...f, [key]: value }));
  async function run(action: 'refresh' | 'save' | 'trash') {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let result;
      if (action === 'refresh') result = await api.refreshRemotePost(post.id);
      else if (action === 'trash')
        result = await api.trashRemotePost(post.id, {
          expectedModifiedAt: remote!.modifiedAt,
          confirm: true,
        });
      else {
        const patch = articlePatch(post, {
          ...fields,
          categories: parseSiteIds(categories),
          tags: parseSiteIds(tags),
        });
        if (!Object.keys(patch.fields).length) {
          setNotice('No fields changed.');
          return;
        }
        result = await api.updateRemotePost(post.id, patch);
      }
      if (!mounted.current) return;
      onChange(result.post);
      const next = articleFields(result.post);
      setFields(next);
      setCategories((next.categories ?? []).join(', '));
      setTags((next.tags ?? []).join(', '));
      setNotice(
        action === 'trash'
          ? 'Moved to WordPress trash. Restore it in WordPress.'
          : action === 'refresh'
            ? 'Refreshed from site.'
            : 'Saved and confirmed on the site.',
      );
      setConfirm(false);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : 'The site change could not be confirmed. Refresh from site.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Edit article on site" className="space-y-4 border-t border-hairline pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-body font-semibold">Edit article on site</h2>
        <Button
          variant="outline"
          disabled={busy || Boolean(post.platformRemovedAt)}
          onClick={() => void run('refresh')}
        >
          Refresh from site
        </Button>
      </div>
      {!remote && (
        <p className="text-sm text-muted">
          Refresh from site to load the current article before editing.
        </p>
      )}
      <p className="text-sm text-muted">
        Save changes the WordPress article immediately. Refresh discards unsaved edits.
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <fieldset disabled={!enabled} className="min-w-0 space-y-3">
        <label className="block text-sm">
          Title
          <Input
            value={fields.title ?? ''}
            maxLength={300}
            onChange={(e) => set('title', e.target.value)}
          />
        </label>
        <label className="block text-sm">
          {remote?.bodyFormat === 'html' ? 'Body — HTML source from WordPress' : 'Body — Markdown'}
          <Textarea
            value={fields.body ?? ''}
            maxLength={ARTICLE_BODY_MAX}
            disabled={!enabled || remote?.bodyTruncated}
            onChange={(e) => set('body', e.target.value)}
            className="min-h-80 font-mono"
          />
        </label>
        {remote?.bodyTruncated && (
          <p className="text-sm text-muted">
            Body editing is disabled: the stored copy is truncated. Edit the complete body in
            WordPress.
          </p>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          <label className="block text-sm">
            Excerpt
            <Textarea
              value={fields.excerpt ?? ''}
              maxLength={2000}
              onChange={(e) => set('excerpt', e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Slug
            <Input
              value={fields.slug ?? ''}
              maxLength={200}
              onChange={(e) => set('slug', e.target.value)}
            />
          </label>
          <label className="block text-sm">
            Site status
            <select
              className="block h-11 w-full rounded-sm border border-muted-soft bg-canvas px-3 md:h-8"
              value={fields.status ?? 'future'}
              onChange={(e) => set('status', e.target.value)}
            >
              {remote?.status === 'future' && (
                <option value="future" disabled>
                  Scheduled on site (unchanged)
                </option>
              )}
              <option value="draft">Draft</option>
              <option value="publish">Published</option>
              <option value="pending">Pending review</option>
              <option value="private">Private</option>
            </select>
          </label>
          <label className="block text-sm">
            Featured image attachment ID (0 removes)
            <Input
              type="number"
              min={0}
              step={1}
              value={fields.featuredImage ?? 0}
              onChange={(e) => set('featuredImage', Number(e.target.value))}
            />
          </label>
          <label className="block text-sm">
            Category IDs (comma separated)
            <Input value={categories} onChange={(e) => setCategories(e.target.value)} />
          </label>
          <label className="block text-sm">
            Tag IDs (comma separated)
            <Input value={tags} onChange={(e) => setTags(e.target.value)} />
          </label>
        </div>
        <p className="text-caption text-muted">
          Use existing term and attachment IDs from WordPress. Empty category or tag lists remove
          the current assignments.
        </p>
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => void run('save')}>Save on site</Button>
          <Button variant="outline" onClick={() => setConfirm(true)}>
            Move to trash on site
          </Button>
        </div>
      </fieldset>
      {confirm && (
        <Modal
          title="Move article to WordPress trash?"
          onClose={() => {
            if (!busy) setConfirm(false);
          }}
        >
          <p className="text-sm">
            This moves this article to the WordPress trash. It can be restored there. The stored
            copy remains in Blog.
          </p>
          <div className="mt-4 flex gap-3">
            <Button variant="outline" disabled={busy} onClick={() => setConfirm(false)}>
              Keep article
            </Button>
            <Button disabled={busy} onClick={() => void run('trash')}>
              Confirm move to trash
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
