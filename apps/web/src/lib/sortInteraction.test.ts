import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Window } from 'happy-dom';
import { SortSelect } from '../components/ui/SortSelect';
import { Table } from '../components/ui/Table';
import { useUrlSort } from './useUrlSort';

const options = [
  { value: 'name', label: 'Name A–Z' },
  { value: 'count', label: 'Most accounts' },
];
function Fixture() {
  const [sort, setSort] = useUrlSort('sort', options, 'name');
  const location = useLocation();
  return React.createElement(
    'div',
    {},
    React.createElement(SortSelect, { value: sort, onChange: setSort, options }),
    React.createElement(Table<{ id: string }>, {
      rows: [{ id: 'a' }],
      rowKey: (r) => r.id,
      sort: { key: sort, dir: sort === 'name' ? 'asc' : 'desc' },
      onSort: setSort,
      columns: [
        { key: 'name', header: 'Name', sortKey: 'name', cell: () => 'Acme' },
        { key: 'count', header: 'Accounts', sortKey: 'count', cell: () => 3 },
      ],
    }),
    React.createElement('output', {}, location.search),
  );
}
afterEach(() => vi.unstubAllGlobals());
describe('shared sort control and headers', () => {
  it('keeps URL, selected label and header in sync through native changes and header clicks', async () => {
    const window = new Window({ url: 'http://localhost/' });
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', window.document);
    vi.stubGlobal('navigator', window.navigator);
    vi.stubGlobal('React', React);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const container = window.document.createElement('div');
    window.document.body.append(container);
    const root = createRoot(container as unknown as HTMLElement);
    try {
      await act(async () =>
        root.render(
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/?filter=healthy&sort=invalid'] },
            React.createElement(Fixture),
          ),
        ),
      );
      const select = container.querySelector('select')!;
      expect(select.value).toBe('name');
      expect(container.querySelector('label .sr-only')?.textContent).toBe('Sort');
      expect(container.querySelector('th')?.getAttribute('aria-sort')).toBe('ascending');
      await act(async () => {
        select.value = 'count';
        select.dispatchEvent(new window.Event('change', { bubbles: true }));
      });
      expect(container.querySelector('output')?.textContent).toBe('?filter=healthy&sort=count');
      expect(container.querySelectorAll('th')[1]?.getAttribute('aria-sort')).toBe('descending');
      await act(async () =>
        container
          .querySelector('th button')!
          .dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
      );
      expect(select.value).toBe('name');
      expect(container.querySelector('output')?.textContent).toBe('?filter=healthy&sort=name');
      expect(container.querySelector('th')?.getAttribute('aria-sort')).toBe('ascending');
    } finally {
      await act(async () => root.unmount());
      await window.happyDOM.close();
    }
  });
});
