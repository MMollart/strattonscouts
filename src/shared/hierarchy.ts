/**
 * Resource hierarchy (Whole Venue > Indoor > Main Hall). A resource blocks
 * everything above and below it, never its siblings. The server enforces this
 * in SQL (functions/_lib/availability-sql.ts); these helpers let the booking
 * page explain it.
 */

export interface HierarchyNode {
  id: string;
  parent_id: string | null;
}

/** Ids above `id`, nearest first. Stops at a loop rather than spinning. */
export function ancestorIds(id: string, nodes: HierarchyNode[]): string[] {
  const parentOf = new Map(nodes.map((n) => [n.id, n.parent_id]));
  const result: string[] = [];
  let current = parentOf.get(id) ?? null;
  while (current && current !== id && !result.includes(current)) {
    result.push(current);
    current = parentOf.get(current) ?? null;
  }
  return result;
}

/** True when `id` would end up above itself if its parent became `parentId`. */
export function wouldCreateLoop(id: string, parentId: string | null, nodes: HierarchyNode[]): boolean {
  if (!parentId) return false;
  return parentId === id || ancestorIds(parentId, nodes).includes(id);
}

/**
 * How `other` relates to `id`: 'parent' if it is above (it includes `id`),
 * 'child' if it is below (part of `id`), or null for unrelated resources
 * such as siblings, which can be booked independently.
 */
export function hierarchyRelation(
  id: string,
  other: string,
  ancestorsOf: (id: string) => string[],
): 'parent' | 'child' | null {
  if (ancestorsOf(id).includes(other)) return 'parent';
  if (ancestorsOf(other).includes(id)) return 'child';
  return null;
}

export interface BlockedBy {
  /** The resource that is booked or closed. */
  name: string;
  /** How it relates to the resource being booked. */
  relation: 'self' | 'parent' | 'child';
}

/** Why a time is unavailable, naming the parent or child that causes it. */
export function blockedMessage(kind: 'booked' | 'closed', by: BlockedBy | undefined): string {
  if (!by || by.relation === 'self') {
    return kind === 'closed' ? 'the venue is closed for some of this time.' : 'this clashes with an existing booking.';
  }
  const what = kind === 'closed' ? 'is closed' : 'is booked';
  return by.relation === 'parent'
    ? `${by.name} ${what} at this time, and it includes this resource.`
    : `${by.name} ${what} at this time, and it is part of this resource.`;
}
