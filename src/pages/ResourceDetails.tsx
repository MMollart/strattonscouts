import { Link, useParams } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { Spinner, ErrorState } from '../components/ui';
import { formatGBP } from '@shared/pricing';
import { useAuth } from '../lib/auth';
import AvailabilityCalendar from '../components/AvailabilityCalendar';

interface ResourceDetail {
  id: string;
  name: string;
  slug: string;
  description: string;
  pricing_model: string;
  requires_approval: boolean;
  prices: { category: string; label: string; amount_pence: number; is_free: boolean }[];
  images: { id: string; r2_key: string; is_primary: boolean }[];
}

const MODEL_LABEL: Record<string, string> = { hourly: 'per hour', nightly: 'per night', fixed: 'per booking' };

export default function ResourceDetails() {
  const { slug } = useParams();
  const { data, loading, error } = useApi<ResourceDetail>(`/resources/${slug}`, [slug]);
  const { user } = useAuth();

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  if (!data) return null;

  const primary = data.images.find((i) => i.is_primary) ?? data.images[0];

  return (
    <div className="grid gap-8 lg:grid-cols-2">
      <div>
        <div className="aspect-video overflow-hidden rounded-2xl bg-scout-off-white">
          {primary ? (
            <img src={`/api/images/${primary.r2_key}`} alt={data.name} className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full place-items-center text-scout-purple/40 font-black text-3xl">{data.name}</div>
          )}
        </div>
      </div>
      <div>
        <h1 className="text-3xl text-scout-purple">{data.name}</h1>
        {data.requires_approval && (
          <span className="badge mt-2 bg-scout-yellow/30 text-yellow-800">Bookings require approval</span>
        )}
        <p className="mt-4 whitespace-pre-line text-gray-700">{data.description}</p>

        <h2 className="mt-8 text-xl">Pricing ({MODEL_LABEL[data.pricing_model]})</h2>
        <ul className="mt-3 divide-y rounded-xl border">
          {data.prices.map((p) => (
            <li key={p.category} className="flex items-center justify-between px-4 py-3">
              <span>{p.label}</span>
              <span className="font-bold">{p.is_free ? 'Free' : formatGBP(p.amount_pence)}</span>
            </li>
          ))}
        </ul>

        <div className="mt-8 flex gap-4">
          {user ? (
            <Link to={`/book/${data.slug}`} className="btn-primary">Book now</Link>
          ) : (
            <Link to="/login" state={{ from: `/book/${data.slug}` }} className="btn-primary">Log in to book</Link>
          )}
        </div>
      </div>
      <section className="lg:col-span-2" aria-labelledby="availability-heading">
        <h2 id="availability-heading" className="text-xl">Availability</h2>
        <div className="mt-3">
          <AvailabilityCalendar resourceId={data.id} resourceSlug={data.slug} resourceName={data.name} />
        </div>
      </section>
    </div>
  );
}
