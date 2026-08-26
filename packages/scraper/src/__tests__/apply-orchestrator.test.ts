import { describe, it, expect } from 'vitest';
import { ApplyOrchestratorService } from '../apply/apply-orchestrator.service';
import type { GreenhouseApplyService } from '../apply/greenhouse/greenhouse-apply.service';
import type { EasyApplyService } from '../apply/easy-apply.service';
import type { LinkedInProbeService } from '../sourcing/linkedin-probe.service';
import type { QuestionAnswererService } from '../answer-resolution/question-answerer.service';

// QuestionAnswererService is a process-wide singleton and auto-apply applies every job
// in one process, so whichever job is set when a question is answered is the job
// that question gets filed under. These tests pin that down at the one entry point
// every application path goes through.
function build(opts: { probe?: any; onApply?: () => void } = {}) {
  const events: string[] = [];
  const answerer = {
    setCurrentJob(job: { id: string }) {
      events.push(`set:${job.id}`);
    },
    clearCurrentJob() {
      events.push('clear');
    },
  } as unknown as QuestionAnswererService;

  const greenhouse = {
    async apply() {
      events.push('greenhouse');
      opts.onApply?.();
      return { success: true };
    },
  } as unknown as GreenhouseApplyService;

  const easy = {
    async applyViaEasyApply() {
      events.push('easy');
      opts.onApply?.();
      return { success: true };
    },
  } as unknown as EasyApplyService;

  const probe = {
    async probeLinkedInApplyTarget() {
      return opts.probe ?? { kind: 'easy_apply' };
    },
    classifyAts() {
      return 'greenhouse';
    },
  } as unknown as LinkedInProbeService;

  return { orchestrator: new ApplyOrchestratorService(greenhouse, easy, probe, answerer), events };
}

const job = (source: string, id = 'job-1') =>
  ({ id, title: 'Software Engineer', company: 'Acme', url: 'https://x', source }) as any;

describe('ApplyOrchestratorService job attribution', () => {
  it('tags answers with the job before the Greenhouse path runs', async () => {
    const { orchestrator, events } = build();
    await orchestrator.applyToJob({} as any, job('greenhouse'), false);
    expect(events).toEqual(['set:job-1', 'greenhouse', 'clear']);
  });

  it('tags answers on the Easy Apply path too', async () => {
    const { orchestrator, events } = build();
    await orchestrator.applyToJob({} as any, job('linkedin'), false);
    expect(events).toEqual(['set:job-1', 'easy', 'clear']);
  });

  it('tags answers when LinkedIn reroutes to an external ATS', async () => {
    // This path never reached the old setCurrentJob call, which sat after the
    // Easy Apply button check inside EasyApplyService.
    const { orchestrator, events } = build({
      probe: { kind: 'external', url: 'https://boards.greenhouse.io/x/jobs/1', host: 'boards.greenhouse.io' },
    });
    await orchestrator.applyToJob({} as any, job('linkedin'), false);
    expect(events).toEqual(['set:job-1', 'greenhouse', 'clear']);
  });

  it('clears the job even when the application throws', async () => {
    const { orchestrator, events } = build({
      onApply: () => {
        throw new Error('page closed');
      },
    });
    await expect(orchestrator.applyToJob({} as any, job('greenhouse'), false)).rejects.toThrow('page closed');
    expect(events).toEqual(['set:job-1', 'greenhouse', 'clear']);
  });

  it('does not let one job keep claiming the next job\'s answers', async () => {
    const { orchestrator, events } = build();
    await orchestrator.applyToJob({} as any, job('linkedin', 'job-1'), false);
    await orchestrator.applyToJob({} as any, job('greenhouse', 'job-2'), false);
    // The regression: job-2's answers were logged under job-1 because nothing on
    // the Greenhouse path ever re-tagged them.
    expect(events).toEqual(['set:job-1', 'easy', 'clear', 'set:job-2', 'greenhouse', 'clear']);
  });
});
