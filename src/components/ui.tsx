import type { ReactNode } from 'react';

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-scout-purple" role="status">
      <span className="h-6 w-6 animate-spin rounded-full border-4 border-scout-purple border-t-transparent" />
      <span className="font-bold">{label}</span>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="card text-center">
      <h3 className="text-lg">{title}</h3>
      {children && <p className="mt-2 text-gray-600">{children}</p>}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="card border-scout-red/40 bg-scout-red/5 text-scout-red" role="alert">
      <p className="font-bold">Something went wrong</p>
      <p className="mt-1 text-sm">{message}</p>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    confirmed: 'bg-scout-green/15 text-scout-green',
    pending_approval: 'bg-scout-yellow/30 text-yellow-800',
    rejected: 'bg-scout-red/15 text-scout-red',
    cancelled: 'bg-gray-200 text-gray-600',
  };
  const label = status.replace(/_/g, ' ');
  return <span className={`badge ${map[status] ?? 'bg-gray-100 text-gray-700'}`}>{label}</span>;
}
