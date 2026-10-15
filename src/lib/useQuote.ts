import { useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { PriceBreakdown } from '@shared/pricing';

export type Quote = PriceBreakdown & { category_id: string };

/** Live server-side price for a prospective booking (debounced). */
export function useQuote(args: {
  resourceId?: string;
  window: { startsAt: string; endsAt: string } | null;
  organisationId?: string | null;
  onBehalfOfUserId?: string;
}): { quote: Quote | null; loading: boolean; error: string | null } {
  const [quote, setQuote] = useState<Quote | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { resourceId, organisationId, onBehalfOfUserId } = args;
  const startsAt = args.window?.startsAt;
  const endsAt = args.window?.endsAt;

  useEffect(() => {
    if (!resourceId || !startsAt || !endsAt) {
      setQuote(null);
      return;
    }
    let current = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .post<Quote>('/pricing/quote', {
          resource_id: resourceId,
          starts_at: startsAt,
          ends_at: endsAt,
          organisation_id: organisationId || null,
          ...(onBehalfOfUserId ? { on_behalf_of_user_id: onBehalfOfUserId } : {}),
        })
        .then((q) => {
          if (!current) return;
          setQuote(q);
          setError(null);
        })
        .catch((e) => {
          if (!current) return;
          setQuote(null);
          setError(e instanceof ApiError ? e.message : 'Could not calculate the price');
        })
        .finally(() => current && setLoading(false));
    }, 300);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [resourceId, startsAt, endsAt, organisationId, onBehalfOfUserId]);

  return { quote, loading, error };
}
