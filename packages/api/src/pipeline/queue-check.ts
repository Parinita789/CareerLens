import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.join(__dirname, '../../../.env') });
import { connectToDatabase, disconnectDatabase, ApplicationTaskModel } from '@job-agent/shared';
import { ApplicationTaskService } from './application-task.service';
import { PipelineService } from './pipeline.service';

// Integration check for the application queue, against the real MongoDB.
//
// Not a vitest test: it needs a live database, and the unit suite is meant to
// stay dependency-free. The pure retry rules — the ones deciding whether a real
// employer receives a second application — live in
// __tests__/application-task.policy.test.ts and are covered there.
//
// Rows created here are namespaced and deleted at the end, and the worker spawn
// is stubbed, so no browser opens and no application is ever sent.

const PREFIX = '__qcheck_';
const P = `${PREFIX}${Date.now()}_`;
let fails = 0;
const check = (name: string, ok: boolean, extra = '') => {
  if (!ok) fails++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
};
const mine = { externalJobId: { $regex: `^${P}` } };

async function queueChecks(svc: ApplicationTaskService) {
  console.log('\n  Queue semantics\n');
  const ids = [P + 'a', P + 'b', P + 'c'];

  const r1 = await svc.enqueue(ids, false);
  check('enqueue creates one task per job', r1.queued === 3 && r1.skipped === 0, JSON.stringify(r1));

  // Clicking Apply twice must not apply twice.
  const r2 = await svc.enqueue(ids, false);
  check('re-enqueue of in-flight jobs is skipped', r2.queued === 0 && r2.skipped === 3, JSON.stringify(r2));

  // The claim is the queue: findOneAndUpdate is atomic, so racing callers
  // cannot be handed the same row.
  const claims = await Promise.all([svc.claimNext(), svc.claimNext(), svc.claimNext(), svc.claimNext()]);
  const got = claims.filter(Boolean).map((t: any) => String(t._id));
  check('4 concurrent claims yield 3 distinct tasks', got.length === 3 && new Set(got).size === 3,
    `${got.length} claimed, ${new Set(got).size} distinct`);
  check('claiming counts an attempt', claims.filter(Boolean).every((t: any) => t.attempts === 1));

  await ApplicationTaskModel.findByIdAndUpdate(got[0], { $set: { status: 'failed' } });
  await svc.reconcileAfterExit(got[0]);
  const a0: any = await ApplicationTaskModel.findById(got[0]).lean();
  check('failure before submit is requeued', a0.status === 'queued', a0.status);

  // The rule that matters: a task that failed after a submit was attempted may
  // already have reached the employer, so it is parked rather than retried.
  await ApplicationTaskModel.findByIdAndUpdate(got[1], {
    $set: { status: 'failed', submitAttemptedAt: new Date() },
  });
  await svc.reconcileAfterExit(got[1]);
  const a1: any = await ApplicationTaskModel.findById(got[1]).lean();
  check('failure AFTER submit is parked, never requeued', a1.status === 'needs_review', a1.status);

  await ApplicationTaskModel.findByIdAndUpdate(got[2], { $set: { status: 'running' } });
  await svc.reapAbandoned();
  const a2: any = await ApplicationTaskModel.findById(got[2]).lean();
  check('task abandoned by a dead process is reaped', a2.status !== 'running', a2.status);

  await svc.retry(got[1]);
  const a3: any = await ApplicationTaskModel.findById(got[1]).lean();
  check('manual retry requeues and clears the submit stamp',
    a3.status === 'queued' && !a3.submitAttemptedAt && a3.attempts === 0);

  const cancelled = await svc.cancelAllQueued();
  check('Stop drains everything still waiting', cancelled >= 1, String(cancelled));

  // Leave nothing queued for the dispatcher section to pick up.
  await ApplicationTaskModel.deleteMany(mine);
}

async function dispatcherChecks(svc: ApplicationTaskService) {
  console.log('\n  Dispatcher\n');
  const pipeline: any = new PipelineService(svc);
  const spawned: string[][] = [];
  let concurrent = 0;
  let peak = 0;
  // Stands in for a worker that starts, takes a moment, then exits without
  // recording an outcome — the crash path the API has to reconcile.
  pipeline.spawnWithLogs = async (_cmd: string, args: string[]) => {
    spawned.push(args);
    concurrent++;
    peak = Math.max(peak, concurrent);
    await new Promise((r) => setTimeout(r, 120));
    concurrent--;
  };

  const ids = ['d1', 'd2', 'd3', 'd4', 'd5'].map((n) => P + n);
  await svc.enqueue(ids, false);
  await pipeline.dispatch();
  await new Promise((r) => setTimeout(r, 1500));

  // Each task fails (the stub records nothing), is requeued once, and runs
  // again: 5 jobs x maxAttempts 2.
  check('every application ran once per attempt', spawned.length === 10, `${spawned.length}/10`);
  check('never exceeded the concurrency cap of 2', peak <= 2, `peak ${peak}`);

  const first = spawned[0] ?? [];
  const jobsFlag = first.find((x) => x.startsWith('--jobs=')) ?? '';
  check('one job per worker process', !!jobsFlag && !jobsFlag.includes(','), jobsFlag);
  check('task id threaded to the worker', first.some((x) => /^--task=[a-f0-9]{24}$/.test(x)));
  check('submit flag passed explicitly', first.includes('--submit=false'));

  const sent = spawned.map((s) => s.find((x) => x.startsWith('--jobs='))!.split('=')[1]);
  check('all five jobs were dispatched', new Set(sent).size === 5, String(new Set(sent).size));
  const runs = [...new Set(sent)].map((j) => sent.filter((x) => x === j).length);
  check('each job retried exactly once after failing', runs.every((n) => n === 2), JSON.stringify(runs));

  const rows: any[] = await ApplicationTaskModel.find(mine).lean();
  check('all tasks reached a settled state', rows.length === 5 && rows.every((r) => r.status === 'failed'),
    JSON.stringify(rows.map((r) => r.status)));
  check('attempts stopped at maxAttempts', rows.every((r) => r.attempts === 2),
    JSON.stringify(rows.map((r) => r.attempts)));
}

async function entryPointChecks(svc: ApplicationTaskService) {
  console.log('\n  Entry point\n');
  const pipeline: any = new PipelineService(svc);
  let spawned: string[][] = [];
  pipeline.spawnWithLogs = async (_cmd: string, args: string[]) => {
    spawned.push(args);
  };

  // The regression this exists for: auto-apply used to be handled only inside
  // the `state.running` branch, so with nothing else running a click fell
  // through to the sequential path and spawned one batch process for all jobs.
  const ids = ['e1', 'e2', 'e3'].map((n) => P + n);
  await pipeline.runSelectedPhases(['apply'], undefined, undefined, undefined, ids);
  await new Promise((r) => setTimeout(r, 400));
  check('apply with nothing running goes through the queue', spawned.length > 0 &&
    spawned.every((a) => a.some((x) => x.startsWith('--task='))),
    spawned.length ? spawned[0].join(' ') : 'nothing spawned');
  check('never batches several jobs into one worker',
    spawned.every((a) => !(a.find((x) => x.startsWith('--jobs=')) ?? '').includes(',')));
  await ApplicationTaskModel.deleteMany(mine);

  // Stop sets `cancelled`, which only the sequential pipeline ever cleared, so
  // one Stop used to gate the dispatch loop off for good.
  spawned = [];
  pipeline.cancelled = true;
  await pipeline.runSelectedPhases(['apply'], undefined, undefined, undefined, [P + 'e4']);
  await new Promise((r) => setTimeout(r, 400));
  // >= 1 because the stub records no outcome, so the task is also retried once.
  // What matters is that anything dispatched at all.
  check('a previous Stop does not gate later applications off', spawned.length >= 1, String(spawned.length));
  await ApplicationTaskModel.deleteMany(mine);

  // No explicit selection falls back to the batch worker, which owns the
  // "which jobs are eligible" query.
  spawned = [];
  await pipeline.runSelectedPhases(['apply'], undefined, undefined, undefined, undefined);
  await new Promise((r) => setTimeout(r, 300));
  check('un-targeted apply still uses the batch worker',
    spawned.length === 1 && !spawned[0].some((x) => x.startsWith('--task=')),
    spawned.length ? spawned[0].join(' ') : 'nothing spawned');

  // The live auto-submit toggle must win over the value stored at enqueue.
  spawned = [];
  const { UserModel } = await import('@job-agent/shared');
  const user: any = await UserModel.findOne().lean();
  const allowNow = user?.settings?.allowAutoSubmit === true;
  await svc.enqueue([P + 'e5'], true);
  await pipeline.dispatch();
  await new Promise((r) => setTimeout(r, 400));
  const submitFlag = spawned[0]?.find((x) => x.startsWith('--submit=')) ?? '';
  check('submit flag re-reads the live toggle', submitFlag === `--submit=${allowNow}`,
    `${submitFlag} with toggle ${allowNow}`);
  await ApplicationTaskModel.deleteMany(mine);

  // Requeueing a running task would let the dispatcher claim it while its
  // worker is still filling the form — two browsers, one job.
  await svc.enqueue([P + 'e7'], false);
  const running: any = await svc.claimNext();
  let refused = false;
  try {
    await svc.retry(String(running._id));
  } catch {
    refused = true;
  }
  const stillRunning: any = await ApplicationTaskModel.findById(running._id).lean();
  check('refuses to requeue an application that is still running',
    refused && stillRunning.status === 'running', `refused=${refused} status=${stillRunning.status}`);
  await ApplicationTaskModel.deleteMany(mine);

  // A job with no application form is terminal, not a failure to retry.
  await svc.enqueue([P + 'e6'], false);
  const claimed: any = await svc.claimNext();
  await ApplicationTaskModel.findByIdAndUpdate(claimed._id, { $set: { status: 'skipped' } });
  await svc.reconcileAfterExit(String(claimed._id));
  const after: any = await ApplicationTaskModel.findById(claimed._id).lean();
  check('a skipped application is terminal, never retried', after.status === 'skipped', after.status);
}

(async () => {
  await connectToDatabase();
  try {
    // claimNext() takes the oldest queued task, whatever it is. If real work is
    // pending, this check would claim it and mark it failed against a stubbed
    // worker — so refuse to run rather than trash the queue.
    const foreign = await ApplicationTaskModel.countDocuments({
      status: { $in: ['queued', 'running'] },
      externalJobId: { $not: new RegExp(`^${PREFIX}`) },
    });
    if (foreign > 0) {
      console.log(`\n  Refusing to run: ${foreign} real application task(s) are queued or running.`);
      console.log('  This check claims from the live queue; let them finish, or Stop first.\n');
      await disconnectDatabase();
      process.exit(2);
    }

    // Clear rows stranded by an earlier aborted run before starting, not just
    // after finishing: process.exit on failure can kill in-flight continuations
    // and leave tasks mid-state for the next run to trip over.
    const stale = await ApplicationTaskModel.deleteMany({ externalJobId: { $regex: `^${PREFIX}` } });
    if (stale.deletedCount) console.log(`  (cleared ${stale.deletedCount} row(s) from a previous run)`);

    const svc = new ApplicationTaskService();
    await queueChecks(svc);
    await dispatcherChecks(svc);
    await ApplicationTaskModel.deleteMany(mine);
    await entryPointChecks(svc);
  } finally {
    const del = await ApplicationTaskModel.deleteMany({ externalJobId: { $regex: `^${PREFIX}` } });
    console.log(`\n  cleaned up ${del.deletedCount} row(s)`);
    await disconnectDatabase();
  }
  console.log(fails === 0 ? '  all queue checks passed\n' : `  ${fails} FAILED\n`);
  process.exit(fails === 0 ? 0 : 1);
})();
