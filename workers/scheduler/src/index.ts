import type { Env } from '../../../functions/_lib/http';
import { expireProvisionalBookings } from '../../../functions/_lib/provisional';
import { retryFailedEmails } from '../../../functions/_lib/email';

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
      (async () => {
        const expired = await expireProvisionalBookings(env);
        if (expired) console.log(`[scheduler] expired ${expired} provisional booking(s)`);
        // FR06: retry emails that failed for a temporary reason.
        const retried = await retryFailedEmails(env);
        if (retried) console.log(`[scheduler] re-sent ${retried} email(s)`);
      })(),
    );
  },
};
