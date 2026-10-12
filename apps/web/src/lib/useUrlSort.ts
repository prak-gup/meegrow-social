import { useSearchParams } from 'react-router-dom';

export function validSort<T extends string>(
  value: string | null,
  options: readonly { value: T }[],
  fallback: T,
): T {
  return options.find((option) => option.value === value)?.value ?? fallback;
}

/** Preserve other filters and allow browser back/forward to restore the sort. */
export function useUrlSort<T extends string>(
  key: string,
  options: readonly { value: T }[],
  fallback: T,
): [T, (value: T) => void] {
  const [params, setParams] = useSearchParams();
  const value = validSort(params.get(key), options, fallback);
  return [
    value,
    (next) =>
      setParams((previous) => {
        const updated = new URLSearchParams(previous);
        updated.set(key, validSort(next, options, fallback));
        return updated;
      }),
  ];
}
