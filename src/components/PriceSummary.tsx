import { formatGBP, type PriceBreakdown } from '@shared/pricing';

const UNIT: Record<PriceBreakdown['quantity_unit'], [string, string]> = {
  hour: ['hour', 'hours'],
  night: ['night', 'nights'],
  booking: ['booking', 'bookings'],
};

/** The server-calculated price breakdown for a booking or quote. */
export function PriceSummary({ price, loading, error }: { price: PriceBreakdown | null; loading?: boolean; error?: string | null }) {
  if (error) return <p className="text-sm font-bold text-scout-red" role="alert">{error}</p>;
  if (!price) return <p className="text-sm text-gray-500">{loading ? 'Calculating price…' : 'Choose dates to see the price.'}</p>;
  // A booking of several resources lists each one's price.
  const lines: (PriceBreakdown & { resource_name?: string })[] = price.lines && price.lines.length > 1 ? price.lines : [price];
  return (
    <dl className="space-y-1 text-sm" aria-live="polite">
      {lines.map((line, i) => (
        <div key={i} className="flex justify-between gap-3">
          <dt>
            {line.resource_name && <span className="font-bold">{line.resource_name}: </span>}
            {describe(line)}
          </dt>
          <dd>{formatGBP(line.base_amount_pence)}</dd>
        </div>
      ))}
      {price.discount_pence > 0 && (
        <div className="flex justify-between text-scout-green">
          <dt>{price.discount_label ?? 'Discount'}</dt>
          <dd>−{formatGBP(price.discount_pence)}</dd>
        </div>
      )}
      <div className="flex justify-between border-t border-gray-200 pt-1 text-lg">
        <dt className="font-bold">Total</dt>
        <dd className="font-black text-scout-purple">{formatGBP(price.total_pence)}</dd>
      </div>
    </dl>
  );
}

/** How one resource's price is worked out, e.g. "2 hours × £10.00". */
function describe(price: PriceBreakdown): string {
  const [one, many] = UNIT[price.quantity_unit];
  const how = price.pricing_model === 'free'
    ? 'Free of charge'
    : price.pricing_model === 'fixed'
      ? 'Fixed price'
      : `${price.quantity} ${price.quantity === 1 ? one : many} × ${formatGBP(price.unit_price_pence)}`;
  return `${how}${price.source === 'organisation_rate' ? ' (organisation rate)' : price.source === 'organisation_free' ? ' (organisation arrangement)' : ''}`;
}
