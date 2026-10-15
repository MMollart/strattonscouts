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

/**
 * Resources that have something beneath them (Whole Venue, Indoor), in tree
 * order with their depth, for a "show resources in" filter.
 */
export function parentOptions<T extends HierarchyNode>(nodes: T[]): { node: T; depth: number }[] {
  const ids = new Set(nodes.map((n) => n.id));
  const hasChildren = new Set(nodes.map((n) => n.parent_id).filter((p): p is string => !!p && ids.has(p)));
  const out: { node: T; depth: number }[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const node of nodes) {
      const parent = node.parent_id && ids.has(node.parent_id) ? node.parent_id : null;
      if (parent !== parentId || out.some((o) => o.node.id === node.id)) continue;
      if (hasChildren.has(node.id)) {
        out.push({ node, depth });
        visit(node.id, depth + 1);
      }
    }
  };
  visit(null, 0);
  return out;
}

/** True when `id` is `parentId` itself or anywhere beneath it. */
export function isWithin(id: string, parentId: string, ancestorsOf: (id: string) => string[]): boolean {
  return id === parentId || ancestorsOf(id).includes(parentId);
}
