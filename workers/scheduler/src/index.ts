import type { Env } from '../../../functions/_lib/http';
import { expireProvisionalBookings } from '../../../functions/_lib/provisional';

/**
 * Scheduled Worker for Release 2 background jobs. Cloudflare Pages Functions
 * cannot run on a cron, so this small Worker shares the Pages project's D1
 * database and library code and runs on a Cron Trigger (see wrangler.toml).
 *
 * Every job here must be idempotent: a run can overlap the previous one or be
 * retried by Cloudflare.
 */
export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      expireProvisionalBookings(env).then((n) => {
        if (n) console.log(`[scheduler] expired ${n} provisional booking(s)`);
      }),
    );
  },
};
