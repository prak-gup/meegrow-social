import { Node, generateJSON, generateHTML, type JSONContent, type Extensions } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Image from '@tiptap/extension-image';
import { TableKit } from '@tiptap/extension-table';
import Placeholder from '@tiptap/extension-placeholder';
import { serialiseArticle, patchArticleText, type Editability } from './articleDocument';

const Document = Node.create({
  name: 'doc',
  topNode: true,
  content: '(editableRegion | protectedRegion)+',
});
const EditableRegion = Node.create({
  name: 'editableRegion',
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,
  addAttributes: () => ({ id: { default: null } }),
  parseHTML: () => [{ tag: 'section[data-article-region]' }],
  renderHTML: ({ node }) => ['section', { 'data-article-region': node.attrs.id }, 0],
});
const ProtectedRegion = Node.create({
  name: 'protectedRegion',
  group: 'block',
  atom: true,
  selectable: false,
  draggable: false,
  addAttributes: () => ({
    id: { default: null },
    label: { default: 'WordPress' },
    originalHtml: { default: '' },
  }),
  parseHTML: () => [],
  renderHTML: ({ node }) => [
    'div',
    { class: 'wordpress-block', contenteditable: 'false', role: 'note' },
    `${node.attrs.label} block — edit in WordPress (locked)`,
  ],
});
export function articleEditorExtensions(): Extensions {
  return [
    Document,
    EditableRegion,
    ProtectedRegion,
    StarterKit.configure({
      document: false,
      heading: { levels: [2, 3, 4] },
      link: false,
      underline: false,
    }),
    Link.configure({
      openOnClick: false,
      protocols: ['http', 'https'],
      HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
    }),
    Underline,
    Image.configure({ allowBase64: false }),
    TableKit.configure({ table: { resizable: false } }),
    Placeholder.configure({ placeholder: 'Write your article…', includeChildren: true }),
  ];
}
function plainExtensions(extensions: Extensions): Extensions {
  return extensions
    .filter((ext) => !['doc', 'editableRegion', 'protectedRegion'].includes(ext.name))
    .concat(Node.create({ name: 'doc', topNode: true, content: 'block+' }));
}
export function editorDocument(analysis: Editability, extensions: Extensions): JSONContent {
  return {
    type: 'doc',
    content: analysis.regions.map((region) =>
      region.protected
        ? {
            type: 'protectedRegion',
            attrs: { id: region.id, label: region.label, originalHtml: region.html },
          }
        : {
            type: 'editableRegion',
            attrs: { id: region.id },
            content: generateJSON(region.editorHtml || '<p></p>', plainExtensions(extensions))
              .content,
          },
    ),
  };
}
function textLeaves(node: JSONContent): string[] {
  return node.type === 'text' ? [node.text ?? ''] : (node.content ?? []).flatMap(textLeaves);
}
function textStructure(node: JSONContent): string {
  return JSON.stringify(node, (key, value: unknown) => (key === 'text' ? '__text__' : value));
}
export function serialiseEditorDocument(
  analysis: Editability,
  baseline: JSONContent,
  current: JSONContent,
  extensions: Extensions,
): string {
  return serialiseArticle(
    analysis,
    (current.content ?? []).map((node, i) => {
      const original = baseline.content?.[i];
      const changed = JSON.stringify(node) !== JSON.stringify(original);
      const textOnly = original && textStructure(original) === textStructure(node);
      const region = analysis.regions[i];
      const patched =
        changed && textOnly && region && !region.protected
          ? patchArticleText(region.editorHtml, textLeaves(original), textLeaves(node))
          : null;
      return {
        id: String(node.attrs?.id ?? ''),
        protected: node.type === 'protectedRegion',
        changed,
        html:
          changed && node.type === 'editableRegion'
            ? (patched ??
              generateHTML({ type: 'doc', content: node.content }, plainExtensions(extensions)))
            : '',
      };
    }),
  );
}
