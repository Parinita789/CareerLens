import { Injectable, Logger } from '@nestjs/common';
import { ApplicationTaskModel, JobModel, type ApplicationTaskStatus } from '@job-agent/shared';
import { decideAfterAbandonedRun, decideAfterFailure } from './application-task.policy';

/** Terminal states: a task here will not be picked up again by the dispatcher. */
const TERMINAL: ApplicationTaskStatus[] = ['succeeded', 'needs_review', 'cancelled'];

/**
 * Owns the application queue: what is pending, who claimed it, how it ended, and
 * whether it may be retried. Deliberately knows nothing about processes —
 * PipelineService owns spawning and the child lifecycle.
 */
@Injectable()
export class ApplicationTaskService {
  private readonly logger = new Logger(ApplicationTaskService.name);
  private readonly workerId = `api-${process.pid}`;

  /**
   * Queue one task per job. Jobs that already have live work queued are skipped,
   * so clicking Apply twice does not apply twice.
   */
  async enqueue(externalJobIds: string[], submit: boolean): Promise<{ queued: number; skipped: number }> {
    const live = await ApplicationTaskModel.find({
      externalJobId: { $in: externalJobIds },
      status: { $in: ['queued', 'running'] },
    })
      .select('externalJobId')
      .lean();
    const alreadyLive = new Set(live.map((t: any) => t.externalJobId));

    const fresh = externalJobIds.filter((id) => !alreadyLive.has(id));
    if (fresh.length === 0) return { queued: 0, skipped: externalJobIds.length };

    // The Job document keys on externalId; `id` is Mongo's own _id virtual.
    const jobs = await JobModel.find({ externalId: { $in: fresh } })
      .select('externalId title company')
      .lean();
    const byId = new Map(jobs.map((j: any) => [j.externalId, j]));

    await ApplicationTaskModel.insertMany(
      fresh.map((id) => ({
        externalJobId: id,
        title: byId.get(id)?.title,
        company: byId.get(id)?.company,
        submit,
        status: 'queued' as const,
      })),
    );
    return { queued: fresh.length, skipped: externalJobIds.length - fresh.length };
  }

  /**
   * Atomically take the oldest queued task. findOneAndUpdate is atomic in
   * MongoDB, so two workers racing here cannot claim the same row — this single
   * operation is what makes the collection a queue.
   */
  async claimNext(): Promise<any | null> {
    return ApplicationTaskModel.findOneAndUpdate(
      { status: 'queued' },
      {
        $set: { status: 'running', claimedAt: new Date(), claimedBy: this.workerId, startedAt: new Date() },
        $inc: { attempts: 1 },
      },
      { sort: { createdAt: 1 }, new: true },
    ).lean();
  }

  async setPid(taskId: string, pid: number | undefined): Promise<void> {
    if (pid === undefined) return;
    await ApplicationTaskModel.findByIdAndUpdate(taskId, { $set: { pid } }).catch(() => {});
  }

  /**
   * Settle a task once its worker process has exited.
   *
   * The worker records its own outcome when it can. This handles the case it
   * cannot: a crash, a kill, or a hang reaped by the timeout, where the row is
   * still 'running' and the truth has to be inferred from the job itself.
   */
  async reconcileAfterExit(taskId: string): Promise<void> {
    const task: any = await ApplicationTaskModel.findById(taskId).lean();
    if (!task || TERMINAL.includes(task.status)) return;

    if (task.status === 'running') {
      // The worker never got to write an outcome. If the job came out applied,
      // it succeeded regardless of how the process ended.
      const job: any = await JobModel.findOne({ externalId: task.externalJobId })
        .select('status')
        .lean();
      if (decideAfterAbandonedRun(job?.status) === 'succeeded') {
        await ApplicationTaskModel.findByIdAndUpdate(taskId, {
          $set: { status: 'succeeded', finishedAt: new Date() },
        });
        return;
      }
      await ApplicationTaskModel.findByIdAndUpdate(taskId, {
        $set: { status: 'failed', finishedAt: new Date(), lastError: 'Worker exited without recording an outcome' },
      });
      task.status = 'failed';
    }

    await this.decideRetry(taskId);
  }

  /**
   * A failed task is requeued only when it is provably safe to run again.
   *
   * submitAttemptedAt is stamped immediately before the Submit click, so a task
   * that failed with it set may already have reached the employer. Retrying
   * would apply twice to a real company, so those are parked for a human
   * instead — never retried automatically.
   */
  private async decideRetry(taskId: string): Promise<void> {
    const task: any = await ApplicationTaskModel.findById(taskId).lean();
    if (!task || task.status !== 'failed') return;

    const outcome = decideAfterFailure(task);
    if (outcome.status === 'needs_review') {
      this.logger.warn(
        `Task ${taskId} failed after a submit was attempted — parking for review rather than retrying`,
      );
      await ApplicationTaskModel.findByIdAndUpdate(taskId, {
        $set: {
          status: 'needs_review',
          lastError: (task.lastError ? task.lastError + ' — ' : '') + outcome.reason,
        },
      });
      return;
    }

    if (outcome.status === 'queued') {
      await ApplicationTaskModel.findByIdAndUpdate(taskId, {
        $set: { status: 'queued' },
        $unset: { claimedAt: '', claimedBy: '', pid: '', finishedAt: '' },
      });
    }
  }

  /**
   * On boot, any task still marked running was claimed by a process that no
   * longer exists — the API died mid-application. Settle those rather than
   * leaving them stuck running forever.
   */
  async reapAbandoned(): Promise<number> {
    const stuck: any[] = await ApplicationTaskModel.find({ status: 'running' }).select('_id').lean();
    for (const t of stuck) await this.reconcileAfterExit(String(t._id));
    if (stuck.length) this.logger.log(`Reaped ${stuck.length} task(s) abandoned by a previous process`);
    return stuck.length;
  }

  async list(limit = 100): Promise<any[]> {
    return ApplicationTaskModel.find().sort({ createdAt: -1 }).limit(limit).lean();
  }

  async pendingCount(): Promise<number> {
    return ApplicationTaskModel.countDocuments({ status: 'queued' });
  }

  /** Manual retry — the only way a needs_review task can run again. */
  async retry(taskId: string): Promise<void> {
    await ApplicationTaskModel.findByIdAndUpdate(taskId, {
      $set: { status: 'queued', attempts: 0 },
      $unset: { claimedAt: '', claimedBy: '', pid: '', finishedAt: '', lastError: '', submitAttemptedAt: '' },
    });
  }

  async cancel(taskId: string): Promise<void> {
    await ApplicationTaskModel.findOneAndUpdate(
      { _id: taskId, status: 'queued' },
      { $set: { status: 'cancelled', finishedAt: new Date() } },
    );
  }

  /**
   * A running task whose worker the user killed. Deliberately not routed through
   * the failure path: that would count an attempt and requeue it, so pressing
   * Stop would start the very application it just killed.
   */
  async markStopped(taskId: string): Promise<void> {
    await ApplicationTaskModel.findOneAndUpdate(
      { _id: taskId, status: { $nin: TERMINAL } },
      { $set: { status: 'cancelled', finishedAt: new Date(), lastError: 'Stopped by user' } },
    ).catch(() => {});
  }

  /** Drop everything still waiting — used when the user presses Stop. */
  async cancelAllQueued(): Promise<number> {
    const res = await ApplicationTaskModel.updateMany(
      { status: 'queued' },
      { $set: { status: 'cancelled', finishedAt: new Date() } },
    );
    return res.modifiedCount ?? 0;
  }
}
