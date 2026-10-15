import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/useApi';
import { Spinner, ErrorState, EmptyState } from '../components/ui';
import AvailabilityCalendar from '../components/AvailabilityCalendar';

interface ResourceOpt {
  id: string;
  name: string;
  slug: string;
  requires_approval: boolean;
}

export default function Availability() {
  const { data: resources, loading, error } = useApi<ResourceOpt[]>('/resources');
  const [params, setParams] = useSearchParams();

  const selected = useMemo(() => {
    if (!resources?.length) return undefined;
    return resources.find((r) => r.slug === params.get('resource')) ?? resources[0];
  }, [resources, params]);

  if (loading) return <Spinner />;
  if (error) return <ErrorState message={error} />;
  if (!resources?.length || !selected) return <EmptyState title="No resources are available to book yet" />;

  return (
    <div>
      <h1 className="text-3xl">Availability</h1>
      <p className="mt-2 text-gray-600">
        See when each space is free. No account is needed to look; you will be asked to log in or register when you book.
      </p>

      <div className="mt-6 max-w-sm">
        <label className="label" htmlFor="resource">Resource</label>
        <select
          id="resource"
          className="input"
          value={selected.slug}
          onChange={(e) => setParams({ resource: e.target.value }, { replace: true })}
        >
          {resources.map((r) => (
            <option key={r.id} value={r.slug}>{r.name}</option>
          ))}
        </select>
        {selected.requires_approval && (
          <p className="mt-2 text-sm text-yellow-800">Bookings for {selected.name} need approval from the venue team.</p>
        )}
      </div>

      <div className="mt-6">
        <AvailabilityCalendar resourceId={selected.id} resourceSlug={selected.slug} resourceName={selected.name} />
      </div>
      <p className="mt-4 text-xs text-gray-500">Availability is confirmed again when you submit a booking.</p>
    </div>
  );
}
