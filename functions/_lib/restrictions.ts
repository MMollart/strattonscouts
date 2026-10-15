import type { Env } from './http';
import { BLOCKED_SET_SQL } from './availability-sql';
import { evaluateRestrictions, type AvailabilityRule, type RuleViolation } from '@shared/availability-rules';

/**
 * A resource's booking restrictions. Recurring closed periods propagate like
 * exceptional closures (up and down the resource hierarchy: a closed rule on
 * the Whole Venue applies to every hall, and one on a hall applies to the
 * Whole Venue); opening hours apply only to the resource they are set on.
 */
export async function loadRestrictions(env: Env, resourceId: string) {
  const [resource, rules] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare('SELECT min_notice_minutes, max_advance_days FROM resources WHERE id = ?').bind(resourceId),
    env.DB.prepare(
      `SELECT ar.id, ar.resource_id, ar.rule_type, ar.days_of_week, ar.start_time, ar.end_time, ar.valid_from, ar.valid_to, ar.label
       FROM availability_rules ar
       WHERE ar.is_active = 1 AND (
         ar.resource_id = ?
         OR (ar.rule_type = 'closed' AND ar.resource_id IN (${BLOCKED_SET_SQL}))
       )`,
    ).bind(resourceId, resourceId, resourceId, resourceId),
  ]);
  const r = resource.results[0] as { min_notice_minutes: number | null; max_advance_days: number | null } | undefined;
  return {
    minNoticeMinutes: r?.min_notice_minutes ?? null,
    maxAdvanceDays: r?.max_advance_days ?? null,
    rules: rules.results as unknown as AvailabilityRule[],
  };
}

export async function checkRestrictions(env: Env, resourceId: string, startsAt: string, endsAt: string): Promise<RuleViolation[]> {
  const r = await loadRestrictions(env, resourceId);
  return evaluateRestrictions({ startsAt, endsAt, now: Date.now(), ...r });
}
