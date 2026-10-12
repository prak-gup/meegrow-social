import { FilterSelect, type FilterSelectProps } from './FilterBar';

/** The same native, keyboard-accessible control used by list filters. */
export function SortSelect({
  label = 'Sort',
  ...props
}: Omit<FilterSelectProps, 'label'> & { label?: string }) {
  return <FilterSelect label={label} {...props} />;
}
