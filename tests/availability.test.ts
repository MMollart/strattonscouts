import { describe, it, expect } from 'vitest';
import {
  conflictingResourceIds,
  findBookingConflict,
  checkAvailability,
} from '@shared/availability';
import type { ConflictEdge } from '@shared/availability';

// Seed-equivalent conflict edges: self-conflicts + Whole Venue relationships.
const edges: ConflictEdge[] = [
  { resource_id: 'whole', conflicts_with_id: 'whole' },
  { resource_id: 'main', conflicts_with_id: 'main' },
  { resource_id: 'small', conflicts_with_id: 'small' },
  { resource_id: 'camping', conflicts_with_id: 'camping' },
  { resource_id: 'field', conflicts_with_id: 'field' },
  // Whole venue <-> everything (bidirectional)
  { resource_id: 'whole', conflicts_with_id: 'main' },
  { resource_id: 'main', conflicts_with_id: 'whole' },
  { resource_id: 'whole', conflicts_with_id: 'small' },
  { resource_id: 'small', conflicts_with_id: 'whole' },
  { resource_id: 'whole', conflicts_with_id: 'camping' },
  { resource_id: 'camping', conflicts_with_id: 'whole' },
  { resource_id: 'whole', conflicts_with_id: 'field' },
  { resource_id: 'field', conflicts_with_id: 'whole' },
];

describe('conflict matrix', () => {
  it('a resource always conflicts with itself', () => {
    expect(conflictingResourceIds('main', edges).has('main')).toBe(true);
  });

  it('Whole Venue conflicts with all individual resources', () => {
    const set = conflictingResourceIds('whole', edges);
    for (const r of ['main', 'small', 'camping', 'field']) {
      expect(set.has(r)).toBe(true);
    }
  });

  it('individual resources do not conflict by default', () => {
    const set = conflictingResourceIds('main', edges);
    expect(set.has('small')).toBe(false);
    expect(set.has('field')).toBe(false);
  });

  it('conflicts are bidirectional (Main Hall sees Whole Venue)', () => {
    expect(conflictingResourceIds('main', edges).has('whole')).toBe(true);
  });
});

const window = { startsAt: '2026-05-01T10:00:00Z', endsAt: '2026-05-01T12:00:00Z' };

describe('booking conflict detection', () => {
  it('blocks Main Hall when Whole Venue is booked (AC09)', () => {
    const conflict = findBookingConflict({
      resourceId: 'main',
      ...window,
      conflicts: edges,
      activeBookings: [{ resource_id: 'whole', starts_at: '2026-05-01T09:00:00Z', ends_at: '2026-05-01T13:00:00Z' }],
    });
    expect(conflict).toBe('whole');
  });

  it('blocks Whole Venue when Main Hall is booked', () => {
    const conflict = findBookingConflict({
      resourceId: 'whole',
      ...window,
      conflicts: edges,
      activeBookings: [{ resource_id: 'main', starts_at: '2026-05-01T11:00:00Z', ends_at: '2026-05-01T12:00:00Z' }],
    });
    expect(conflict).toBe('main');
  });

  it('allows Main Hall + Small Hall simultaneously', () => {
    const conflict = findBookingConflict({
      resourceId: 'small',
      ...window,
      conflicts: edges,
      activeBookings: [{ resource_id: 'main', starts_at: '2026-05-01T10:00:00Z', ends_at: '2026-05-01T12:00:00Z' }],
    });
    expect(conflict).toBeNull();
  });

  it('allows the same resource at non-overlapping times', () => {
    const conflict = findBookingConflict({
      resourceId: 'main',
      ...window,
      conflicts: edges,
      activeBookings: [{ resource_id: 'main', starts_at: '2026-05-01T12:00:00Z', ends_at: '2026-05-01T14:00:00Z' }],
    });
    expect(conflict).toBeNull();
  });

  it('respects configured conflicts (kitchen <-> small)', () => {
    const configured = [...edges, { resource_id: 'kitchen', conflicts_with_id: 'small' }, { resource_id: 'small', conflicts_with_id: 'kitchen' }];
    const conflict = findBookingConflict({
      resourceId: 'kitchen',
      ...window,
      conflicts: configured,
      activeBookings: [{ resource_id: 'small', starts_at: '2026-05-01T10:00:00Z', ends_at: '2026-05-01T12:00:00Z' }],
    });
    expect(conflict).toBe('small');
  });
});

describe('availability with closures', () => {
  it('reports closure when an admin block overlaps', () => {
    const result = checkAvailability({
      resourceId: 'main',
      ...window,
      conflicts: edges,
      activeBookings: [],
      closures: [{ resource_id: 'main', starts_at: '2026-05-01T00:00:00Z', ends_at: '2026-05-02T00:00:00Z' }],
    });
    expect(result.available).toBe(false);
    expect(result.reason).toBe('closure');
  });

  it('reports available when nothing conflicts', () => {
    const result = checkAvailability({
      resourceId: 'main',
      ...window,
      conflicts: edges,
      activeBookings: [],
      closures: [],
    });
    expect(result.available).toBe(true);
  });
});
