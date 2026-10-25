import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * The booking being put together: resources added with "Add to booking",
 * all for one time, sent as one booking at checkout. Kept in this browser
 * (so it survives moving between pages and reloads) until it is booked or
 * cleared.
 */
export interface Basket {
  /** The time every resource in the booking is for (UTC ISO). */
  window: { startsAt: string; endsAt: string } | null;
  resourceIds: string[];
}

interface BasketContextValue extends Basket {
  /** Add a resource for this time. A different time moves everything in the booking to it. */
  add: (resourceId: string, window: { startsAt: string; endsAt: string }) => void;
  remove: (resourceId: string) => void;
  setWindow: (window: { startsAt: string; endsAt: string }) => void;
  clear: () => void;
}

const KEY = 'ss_basket';
const EMPTY: Basket = { window: null, resourceIds: [] };

function load(): Basket {
  try {
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Basket) : EMPTY;
    return Array.isArray(parsed.resourceIds) ? parsed : EMPTY;
  } catch {
    return EMPTY;
  }
}

const BasketContext = createContext<BasketContextValue | null>(null);

export function BasketProvider({ children }: { children: ReactNode }) {
  const [basket, setBasket] = useState<Basket>(load);

  useEffect(() => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(basket));
    } catch {
      // Storage may be unavailable (private browsing); the basket still works for this visit.
    }
  }, [basket]);

  const add = useCallback((resourceId: string, w: { startsAt: string; endsAt: string }) => {
    setBasket((b) => ({ window: w, resourceIds: b.resourceIds.includes(resourceId) ? b.resourceIds : [...b.resourceIds, resourceId] }));
  }, []);
  const remove = useCallback((resourceId: string) => {
    setBasket((b) => {
      const resourceIds = b.resourceIds.filter((id) => id !== resourceId);
      return resourceIds.length ? { ...b, resourceIds } : EMPTY;
    });
  }, []);
  const setWindow = useCallback((w: { startsAt: string; endsAt: string }) => setBasket((b) => ({ ...b, window: w })), []);
  const clear = useCallback(() => setBasket(EMPTY), []);

  const value = useMemo(() => ({ ...basket, add, remove, setWindow, clear }), [basket, add, remove, setWindow, clear]);
  return <BasketContext.Provider value={value}>{children}</BasketContext.Provider>;
}

export function useBasket(): BasketContextValue {
  const ctx = useContext(BasketContext);
  if (!ctx) throw new Error('useBasket must be used inside BasketProvider');
  return ctx;
}
