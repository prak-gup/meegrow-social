import { useMemo, useState } from 'react';
import { useEditor, EditorContent, useEditorState } from '@tiptap/react';
import {
  articleEditorExtensions,
  editorDocument,
  serialiseEditorDocument,
} from '../lib/articleEditorSchema';
import { documentUrl, type Editability } from '../lib/articleDocument';
import { Button } from './ui/Button';
import { Input } from './ui/Input';

export default function RichArticleEditor({
  analysis,
  onChange,
}: {
  analysis: Editability;
  onChange: (html: string | null, error?: string) => void;
}) {
  const extensions = useMemo(articleEditorExtensions, []);
  const baseline = useMemo(() => editorDocument(analysis, extensions), [analysis, extensions]);
  const [urlKind, setUrlKind] = useState<'link' | 'image' | null>(null);
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState('');
  const editor = useEditor({
    extensions,
    content: baseline,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        'aria-label': 'Article rich text editor',
        role: 'textbox',
        'aria-multiline': 'true',
        class: 'article-document min-h-80 p-4 focus:outline-none',
      },
    },
    onUpdate: ({ editor: updated }) => {
      try {
        onChange(serialiseEditorDocument(analysis, baseline, updated.getJSON(), extensions));
      } catch (e) {
        onChange(null, e instanceof Error ? e.message : 'Unable to preserve the original article.');
      }
    },
  });
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e?.isActive('bold'),
      italic: e?.isActive('italic'),
      underline: e?.isActive('underline'),
      strike: e?.isActive('strike'),
      bulletList: e?.isActive('bulletList'),
      orderedList: e?.isActive('orderedList'),
      blockquote: e?.isActive('blockquote'),
      code: e?.isActive('code'),
      codeBlock: e?.isActive('codeBlock'),
      heading: [2, 3, 4].find((level) => e?.isActive('heading', { level })) ?? 0,
    }),
  });
  if (!editor) return <p role="status">Loading document editor…</p>;
  const tool = (label: string, action: () => void, active?: boolean, disabled = false) => (
    <button
      type="button"
      key={label}
      aria-label={label}
      title={label}
      aria-pressed={active}
      disabled={disabled}
      className="h-11 shrink-0 whitespace-nowrap rounded-sm border border-hairline px-3 text-sm hover:bg-surface-soft aria-pressed:bg-surface-strong disabled:opacity-40"
      onClick={action}
    >
      {label}
    </button>
  );
  function applyUrl() {
    const safe = documentUrl(url);
    if (!safe) {
      setUrlError('Enter a full HTTP or HTTPS URL.');
      return;
    }
    if (urlKind === 'image') editor!.chain().focus().setImage({ src: safe, alt: '' }).run();
    else editor!.chain().focus().extendMarkRange('link').setLink({ href: safe }).run();
    setUrlKind(null);
    setUrlError('');
  }
  return (
    <div className="min-w-0 rounded-md border border-hairline">
      <div
        role="group"
        aria-label="Article formatting"
        className="flex max-w-full gap-1 overflow-x-auto border-b border-hairline p-2"
      >
        <select
          aria-label="Paragraph style"
          className="h-11 shrink-0 rounded-sm border border-hairline bg-canvas px-2"
          value={state?.heading ?? 0}
          onChange={(e) => {
            const level = Number(e.target.value);
            if (!level) editor.chain().focus().setParagraph().run();
            else
              editor
                .chain()
                .focus()
                .setHeading({ level: level as 2 | 3 | 4 })
                .run();
          }}
        >
          <option value={0}>Paragraph</option>
          <option value={2}>Heading 2</option>
          <option value={3}>Heading 3</option>
          <option value={4}>Heading 4</option>
        </select>
        {tool('Bold', () => editor.chain().focus().toggleBold().run(), state?.bold)}
        {tool('Italic', () => editor.chain().focus().toggleItalic().run(), state?.italic)}
        {tool('Underline', () => editor.chain().focus().toggleUnderline().run(), state?.underline)}
        {tool('Strikethrough', () => editor.chain().focus().toggleStrike().run(), state?.strike)}
        {tool('Add / edit link', () => {
          setUrlKind('link');
          setUrl(editor.getAttributes('link').href ?? '');
        })}
        {tool('Remove link', () =>
          editor.chain().focus().extendMarkRange('link').unsetLink().run(),
        )}
        {tool(
          'Bullet list',
          () => editor.chain().focus().toggleBulletList().run(),
          state?.bulletList,
        )}
        {tool(
          'Numbered list',
          () => editor.chain().focus().toggleOrderedList().run(),
          state?.orderedList,
        )}
        {tool('Quote', () => editor.chain().focus().toggleBlockquote().run(), state?.blockquote)}
        {tool('Code', () => editor.chain().focus().toggleCode().run(), state?.code)}
        {tool('Code block', () => editor.chain().focus().toggleCodeBlock().run(), state?.codeBlock)}
        {tool('Horizontal rule', () => editor.chain().focus().setHorizontalRule().run())}
        {tool('Image URL', () => {
          setUrlKind('image');
          setUrl('');
        })}
        {tool('Insert table', () =>
          editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
        )}
        {tool(
          'Add table row',
          () => editor.chain().focus().addRowAfter().run(),
          undefined,
          !editor.can().addRowAfter(),
        )}
        {tool(
          'Add table column',
          () => editor.chain().focus().addColumnAfter().run(),
          undefined,
          !editor.can().addColumnAfter(),
        )}
        {tool(
          'Delete table',
          () => editor.chain().focus().deleteTable().run(),
          undefined,
          !editor.can().deleteTable(),
        )}
        {tool('Undo', () => editor.chain().focus().undo().run(), undefined, !editor.can().undo())}
        {tool('Redo', () => editor.chain().focus().redo().run(), undefined, !editor.can().redo())}
      </div>
      {urlKind && (
        <div className="space-y-2 border-b border-hairline p-3">
          <label className="block text-sm">
            {urlKind === 'image' ? 'Image URL' : 'Link URL'}
            <Input
              autoFocus
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyUrl();
                }
              }}
            />
          </label>
          {urlError && <p role="alert">{urlError}</p>}
          <div className="flex gap-2">
            <Button onClick={applyUrl}>Apply URL</Button>
            <Button variant="outline" onClick={() => setUrlKind(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      <EditorContent editor={editor} />
      <p className="border-t border-hairline p-3 text-caption text-muted">
        Typing shortcuts: ## heading, - list, &gt; quote, **bold**. Locked blocks are preserved;
        undo if a region is removed.
      </p>
    </div>
  );
}
