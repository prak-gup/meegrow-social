import { useCallback, useEffect, useRef, useState } from 'react';
import type { OverviewView } from '@meegrow-social/contracts';
import { api } from './api';

/** A cached overview is reused for this long before a quiet re-fetch. */
const STALE_MS = 30_000;

/**
 * The cross-client overview the sidebar reads (per-client account counts and attention markers,
 * and the nav badges). One fetch for the whole shell, shared by the desktop rail and the drawer.
 * It fails silently: without it the sidebar simply shows no counts. `refresh()` is for moments the
 * numbers matter (the switcher opening); `refreshIfStale()` is for navigation and tab focus.
 */
export function useSidebarOverview(scope: string | null) {
  const [overview, setOverview] = useState<OverviewView | null>(null);
  const last = useRef(0);
  const inflight = useRef(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    if (inflight.current) return;
    inflight.current = true;
    try {
      const ov = await api.overview();
      if (alive.current) {
        setOverview(ov);
        last.current = Date.now();
      }
    } catch {
      /* keep whatever we had */
    } finally {
      inflight.current = false;
    }
  }, []);

  const refreshIfStale = useCallback(() => {
    if (Date.now() - last.current > STALE_MS) void refresh();
  }, [refresh]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // On mount and whenever the active client changes (a switch can change what is failing).
  useEffect(() => {
    void refresh();
  }, [refresh, scope]);

  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && refreshIfStale();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refreshIfStale]);

  return { overview, refresh, refreshIfStale };
}
