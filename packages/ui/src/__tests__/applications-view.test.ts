import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ApplicationsView } from '../components/applications-view';
import type { ApplicationTask, ApplicationTaskStatus } from '../types';

// A render smoke test: tsc proves the props line up but says nothing about the
// component actually rendering. Static markup needs no DOM, so it runs in the
// same node-environment suite as everything else.
const task = (status: ApplicationTaskStatus, over: Partial<ApplicationTask> = {}): ApplicationTask => ({
  _id: `id-${status}`, externalJobId: `job-${status}`, title: `Engineer ${status}`,
  company: 'Acme', status, attempts: 1, maxAttempts: 2,
  createdAt: new Date().toISOString(), ...over,
});

const render = (tasks: ApplicationTask[]) =>
  renderToStaticMarkup(
    createElement(ApplicationsView, { tasks, onRetryTask: () => {}, onCancelTask: () => {} }),
  );

describe('ApplicationsView', () => {
  it('renders every status without throwing', () => {
    const all: ApplicationTaskStatus[] = ['queued', 'running', 'succeeded', 'failed', 'skipped', 'needs_review', 'cancelled'];
    const html = render(all.map((s) => task(s)));
    expect(html).toContain('Engineer needs_review');
    expect(html).toContain('Acme');
  });

  it('tells the user when nothing has run yet', () => {
    expect(render([])).toContain('No applications yet');
  });

  it('warns above the table when an application may already be submitted', () => {
    const html = render([task('needs_review', { submitAttemptedAt: new Date().toISOString() })]);
    expect(html).toMatch(/may already have reached the employer/i);
    expect(html).toContain('review-warning');
  });

  it('does not warn when nothing needs review', () => {
    const html = render([task('succeeded'), task('queued')]);
    expect(html).not.toContain('review-warning');
  });

  it('offers Cancel for waiting work and Retry for finished failures', () => {
    expect(render([task('queued')])).toContain('Cancel');
    expect(render([task('failed')])).toContain('Retry');
  });

  it('labels a needs_review retry differently from an ordinary one', () => {
    // "Retry anyway" is the deliberate friction: this one may double-apply.
    expect(render([task('needs_review')])).toContain('Retry anyway');
  });

  it('offers no way to re-send a completed application', () => {
    // Retrying a succeeded task would put a second application in front of the
    // same employer, which is the harm the whole needs_review path guards.
    const html = render([task('succeeded')]);
    expect(html).not.toContain('Retry');
  });

  it('offers no action while a worker is mid-application', () => {
    const html = render([task('running')]);
    expect(html).not.toContain('Retry');
    expect(html).not.toContain('Cancel');
  });

  it('shows the failure reason rather than hiding it', () => {
    expect(render([task('failed', { lastError: 'Timed out loading form' })])).toContain('Timed out loading form');
  });
});
