import { Injectable } from '@nestjs/common';
import { ApplicationTaskModel } from '@job-agent/shared';

/**
 * Links this worker process to the ApplicationTask row it is executing.
 *
 * A worker process handles exactly one task, so holding the id in a
 * process-scoped singleton is safe here — unlike QuestionAnswererService, which
 * had to be re-tagged per job because one process applied to many.
 *
 * When no task id is set — a plain `npm run auto-apply` from the terminal, or a
 * batch run — every method is a no-op, so the CLI keeps working untouched.
 */
@Injectable()
export class ApplyTaskContextService {
  private taskId: string | null = null;

  setTaskId(taskId: string | null): void {
    this.taskId = taskId;
  }

  /**
   * Called immediately before the Submit click. This is what makes retrying
   * safe: a task that failed *after* this stamp may already have reached the
   * employer, so it is never retried automatically.
   */
  async markSubmitAttempted(): Promise<void> {
    if (!this.taskId) return;
    await ApplicationTaskModel.findByIdAndUpdate(this.taskId, {
      $set: { submitAttemptedAt: new Date() },
    }).catch(() => {
      /* never block an application on bookkeeping */
    });
  }

  /**
   * Record the outcome from inside the worker, which knows what actually
   * happened. If the process dies before this runs, the API reconciles the row
   * from the child's exit instead.
   */
  async markFinished(status: 'succeeded' | 'failed' | 'skipped', lastError?: string): Promise<void> {
    if (!this.taskId) return;
    await ApplicationTaskModel.findByIdAndUpdate(this.taskId, {
      $set: { status, finishedAt: new Date(), ...(lastError ? { lastError: lastError.slice(0, 500) } : {}) },
    }).catch(() => {
      /* the reaper will pick it up */
    });
  }
}
