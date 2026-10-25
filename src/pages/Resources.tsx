import { Link, useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { Spinner, ErrorState, EmptyState } from '../components/ui';
import { formatGBP } from '@shared/pricing';
import { isWithin } from '@shared/hierarchy';

interface ResourceListItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  requires_approval: boolean;
  pricing_model: string;
  prices: { category: string; pricing_model: string; amount_pence: number; is_free: boolean }[];
  primary_image_key: string | null;
  parent_id: string | null;
  ancestor_ids: string[];
}

interface Group { id: string; name: string; slug: string; depth: number }

export default function Resources() {
  const { data, loading, error } = useApi<ResourceListItem[]>('/resources');
  const { data: groupData } = useApi<Group[]>('/resources/groups');
  const groups = groupData ?? [];
  const [params, setParams] = useSearchParams();

  // Filter to a group such as Indoor (bookable or not): the group itself and everything beneath it.
  const within = groups.find((g) => g.slug === params.get('within')) ?? null;
  const choose = (slug: string | null) => setParams(slug ? { within: slug } : {}, { replace: true });
  const shown = (data ?? []).filter((r) => !within || isWithin(r.id, within.id, (id) => data?.find((x) => x.id === id)?.ancestor_ids ?? []));

  return (
    <div>
      <h1 className="text-3xl">Our resources</h1>
      <p className="mt-2 text-gray-600">Browse everything available to hire at Stratton Scouts.</p>

      {loading && <Spinner />}
      {error && <div className="mt-6"><ErrorState message={error} /></div>}
      {data && data.length === 0 && <div className="mt-6"><EmptyState title="No resources available yet" /></div>}

      {groups.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Show resources in">
          <button type="button" aria-pressed={!within} className={!within ? 'btn-primary' : 'btn-secondary'} onClick={() => choose(null)}>
            All resources
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              aria-pressed={within?.id === g.id}
              className={within?.id === g.id ? 'btn-primary' : 'btn-secondary'}
              onClick={() => choose(g.slug)}
            >
              {g.name}
            </button>
          ))}
        </div>
      )}

      {data && data.length > 0 && shown.length === 0 && <div className="mt-8"><EmptyState title="Nothing to book in this group right now" /></div>}

      {data && data.length > 0 && (
        <div className="mt-8 grid gap-6 md:grid-cols-2 lg:grid-cols-3" aria-live="polite">
          {shown.map((r) => {
            const scoutPrice = r.prices.find((p) => p.category === 'scouts');
            return (
              <Link key={r.id} to={`/resources/${r.slug}`} className="card transition-shadow hover:shadow-md">
                <div className="aspect-video overflow-hidden rounded-xl bg-scout-off-white">
                  {r.primary_image_key ? (
                    <img src={`/api/images/${r.primary_image_key}`} alt={r.name} className="h-full w-full object-cover" />
                  ) : (
                    <div className="grid h-full place-items-center text-scout-purple/40 font-black text-2xl">{r.name}</div>
                  )}
                </div>
                <h2 className="mt-4 text-xl text-scout-purple">{r.name}</h2>
                <p className="mt-1 line-clamp-2 text-sm text-gray-600">{r.description}</p>
                <div className="mt-3 flex items-center justify-between">
                  <span className="text-sm font-bold">
                    {scoutPrice ? (scoutPrice.is_free ? 'Free for Scouts' : `From ${formatGBP(scoutPrice.amount_pence)}`) : ''}
                  </span>
                  {r.requires_approval && <span className="badge bg-scout-yellow/30 text-yellow-800">Approval required</span>}
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
