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
  const [one, many] = UNIT[price.quantity_unit];
  return (
    <dl className="space-y-1 text-sm" aria-live="polite">
      <div className="flex justify-between">
        <dt>
          {price.pricing_model === 'free'
            ? 'Free of charge'
            : price.pricing_model === 'fixed'
              ? 'Fixed price'
              : `${price.quantity} ${price.quantity === 1 ? one : many} × ${formatGBP(price.unit_price_pence)}`}
          {price.source === 'organisation_rate' && ' (organisation rate)'}
          {price.source === 'organisation_free' && ' (organisation arrangement)'}
        </dt>
        <dd>{formatGBP(price.base_amount_pence)}</dd>
      </div>
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
