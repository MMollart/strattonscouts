import { Link } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { Spinner, ErrorState, EmptyState } from '../components/ui';
import { formatGBP } from '@shared/pricing';

interface ResourceListItem {
  id: string;
  name: string;
  slug: string;
  description: string;
  requires_approval: boolean;
  pricing_model: string;
  prices: { category: string; amount_pence: number; is_free: boolean }[];
  primary_image_key: string | null;
}

export default function Resources() {
  const { data, loading, error } = useApi<ResourceListItem[]>('/resources');

  return (
    <div>
      <h1 className="text-3xl">Our resources</h1>
      <p className="mt-2 text-gray-600">Browse everything available to hire at Stratton Scouts.</p>

      {loading && <Spinner />}
      {error && <div className="mt-6"><ErrorState message={error} /></div>}
      {data && data.length === 0 && <div className="mt-6"><EmptyState title="No resources available yet" /></div>}

      {data && data.length > 0 && (
        <div className="mt-8 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {data.map((r) => {
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
