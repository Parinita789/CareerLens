import mongoose from 'mongoose';

/**
 * One queued application to one job.
 *
 * Auto-apply used to be a single process looping over N jobs, so if it died at
 * job 7 of 10 the remaining three left no trace: nothing recorded that they were
 * meant to run, nothing to retry, and no per-job status for the UI to show. Each
 * application is now its own row, claimed atomically by a worker.
 *
 * The collection *is* the queue — claiming is a single findOneAndUpdate from
 * 'queued' to 'running', which is atomic in MongoDB and therefore safe for any
 * number of workers without a broker.
 */
export const APPLICATION_TASK_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'needs_review',
  'cancelled',
] as const;

export type ApplicationTaskStatus = (typeof APPLICATION_TASK_STATUSES)[number];

const applicationTaskSchema = new mongoose.Schema(
  {
    externalJobId: { type: String, required: true, index: true },
    title: String,
    company: String,
    status: { type: String, enum: APPLICATION_TASK_STATUSES, default: 'queued', index: true },

    /** Whether this task is permitted to click the final Submit button. */
    submit: { type: Boolean, default: false },

    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 2 },
    lastError: String,

    /**
     * Stamped immediately *before* the Submit click, and the reason retries are
     * safe. A process that dies after submitting but before recording success
     * would otherwise be retried and apply to the same employer twice. Any task
     * that failed with this set is parked as needs_review instead of retried.
     */
    submitAttemptedAt: Date,

    /** Set while a worker holds the task; used to detect abandoned claims. */
    claimedAt: Date,
    claimedBy: String,
    pid: Number,

    startedAt: Date,
    finishedAt: Date,
  },
  { timestamps: true },
);

// The dispatcher's hot path: oldest queued task first.
applicationTaskSchema.index({ status: 1, createdAt: 1 });

export const ApplicationTaskModel = mongoose.model('ApplicationTask', applicationTaskSchema);
