import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/react';
import { Window } from 'happy-dom';
import {
  articleEditorExtensions,
  editorDocument,
  serialiseEditorDocument,
} from './articleEditorSchema';
import { analyseEditability } from './articleDocument';
import { articleFixtures } from './articleFixtures';
import { articlePatch } from './remoteArticle';
import type { PostView } from '@meegrow-social/contracts';

const window = new Window({
  settings: {
    disableJavaScriptEvaluation: true,
    disableJavaScriptFileLoading: true,
    disableCSSFileLoading: true,
    disableIframePageLoading: true,
  },
});
beforeAll(() => {
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('navigator', window.navigator);
  vi.stubGlobal('DOMParser', window.DOMParser);
  vi.stubGlobal('Node', window.Node);
  vi.stubGlobal('HTMLElement', window.HTMLElement);
  vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('MutationObserver', window.MutationObserver);
  vi.stubGlobal('getComputedStyle', window.getComputedStyle.bind(window));
  vi.stubGlobal('requestAnimationFrame', window.requestAnimationFrame.bind(window));
  vi.stubGlobal('cancelAnimationFrame', window.cancelAnimationFrame.bind(window));
});
afterAll(() => {
  vi.unstubAllGlobals();
  void window.happyDOM.close();
});

describe('actual TipTap HTML parse/serialise round-trip', () => {
  it.each(articleFixtures)('sends no body after opening: %s', (html) => {
    const analysis = analyseEditability(html);
    const extensions = articleEditorExtensions();
    const baseline = editorDocument(analysis, extensions);
    const serialised = serialiseEditorDocument(
      analysis,
      baseline,
      structuredClone(baseline),
      extensions,
    );
    expect(serialised).toBe(html);
    const post = {
      caption: html,
      options: {
        kind: 'wordpress',
        remote: {
          modifiedAt: '2026-10-12T00:00:00.000Z',
          bodyFormat: 'html',
          bodyTruncated: false,
        },
      },
    } as PostView;
    expect(articlePatch(post, { body: serialised }).fields).toEqual({});
  });
  it.each(articleFixtures)('actual editor state sends nothing on opening: %s', (html) => {
    const analysis = analyseEditability(html);
    const extensions = articleEditorExtensions();
    const baseline = editorDocument(analysis, extensions);
    const editor = new Editor({
      extensions,
      content: baseline,
      element: window.document.createElement('div') as unknown as HTMLElement,
    });
    try {
      expect(serialiseEditorDocument(analysis, baseline, editor.getJSON(), extensions)).toBe(html);
    } finally {
      editor.destroy();
    }
  });
  it('changes a text node while retaining all protected bytes and neighboring regions', () => {
    const html = articleFixtures[4];
    const analysis = analyseEditability(html);
    const extensions = articleEditorExtensions();
    const baseline = editorDocument(analysis, extensions);
    const edited = structuredClone(baseline);
    edited.content![0].content![0].content![0].text = 'Edited introduction';
    expect(serialiseEditorDocument(analysis, baseline, edited, extensions)).toBe(
      html.replace('Before gallery', 'Edited introduction'),
    );
  });
  it('preserves unedited Gutenberg comments but uses Classic HTML for an edited region', () => {
    const html =
      '<!-- wp:paragraph --><p>Hello</p><!-- /wp:paragraph -->\n<!-- wp:paragraph --><p>Untouched</p><!-- /wp:paragraph -->';
    const analysis = analyseEditability(html);
    expect(analysis.classicOnEdit).toBe(true);
    const extensions = articleEditorExtensions();
    const baseline = editorDocument(analysis, extensions);
    const edited = structuredClone(baseline);
    edited.content![0].content![0].content![0].text = 'Changed';
    expect(serialiseEditorDocument(analysis, baseline, edited, extensions)).toBe(
      '<p>Changed</p>\n<!-- wp:paragraph --><p>Untouched</p><!-- /wp:paragraph -->',
    );
  });
  it('changes only the selected text, preserving entities and other markup spelling', () => {
    const html =
      '<p>Hello &copy; &nbsp; नमस्ते 😀 <strong>friend</strong></p><table><thead><tr><th>Title</th></tr></thead><tbody><tr><td>Value</td></tr></tbody></table>';
    const analysis = analyseEditability(html);
    const extensions = articleEditorExtensions();
    const baseline = editorDocument(analysis, extensions);
    const edited = structuredClone(baseline);
    edited.content![0].content![0].content![0].text =
      edited.content![0].content![0].content![0].text!.replace('Hello', 'Welcome');
    expect(serialiseEditorDocument(analysis, baseline, edited, extensions)).toBe(
      html.replace('Hello', 'Welcome'),
    );
  });
  it('rejects deleting a locked node and removes no body from a truncated stored copy', () => {
    const analysis = analyseEditability(articleFixtures[4]);
    const extensions = articleEditorExtensions();
    const baseline = editorDocument(analysis, extensions);
    const edited = structuredClone(baseline);
    edited.content!.splice(1, 1);
    expect(() => serialiseEditorDocument(analysis, baseline, edited, extensions)).toThrow(
      'removed or reordered',
    );
    const post = {
      caption: 'partial',
      options: {
        kind: 'wordpress',
        remote: { modifiedAt: '2026-10-12T00:00:00.000Z', bodyTruncated: true },
      },
    } as PostView;
    expect(articlePatch(post, { body: 'replacement' }).fields).toEqual({});
  });
});
