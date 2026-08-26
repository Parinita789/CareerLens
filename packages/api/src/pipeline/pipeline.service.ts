import { Injectable, ConflictException } from '@nestjs/common';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';
import { UserModel, Limiter } from '@job-agent/shared';

// Read the global "allow bot to submit" toggle from UserModel.settings. Falls
// back to false (dry-run) on any error — safe default. Read fresh on every
// spawn so flipping the UI switch takes effect immediately.
async function readAllowAutoSubmit(): Promise<boolean> {
  try {
    const user = await UserModel.findOne().lean();
    return ((user as any)?.settings?.allowAutoSubmit as boolean) === true;
  } catch {
    return false;
  }
}

export interface PipelineState {
  running: boolean;
  phase: string | null;
  command: string | null;
  error: string | null;
  lastRunAt: string | null;
  logs: string[];
}

const SCRAPER_DIR_RESOLVER = () => path.resolve(process.cwd(), '../scraper');

const PHASE_LIST = [
  {
    id: 'scrape',
    label: 'Scrape + Score',
    name: 'scrape + score',
    cmd: 'npx',
    args: ['tsx', 'src/scrape-and-score.ts'],
  },
  {
    id: 'gmail-alerts',
    label: 'Gmail Alerts',
    name: 'gmail alerts',
    cmd: 'npx',
    // Deliberately NOT --watch here. The phase runner waits for each process to
    // exit before starting the next one, so a watcher would pin the pipeline as
    // "running" until the timeout and starve any phase queued behind it. This
    // runs one Gmail fetch and exits; the always-on watcher is still available
    // as the standalone `npm run scraper:gmail-alerts` script.
    args: ['tsx', 'src/gmail-alerts.ts'],
  },
  {
    id: 'apply',
    label: 'Auto Apply',
    name: 'auto apply',
    cmd: 'npx',
    args: ['tsx', 'src/auto-apply.ts'],
  },
];

const COMMANDS: Record<
  string,
  { label: string; phases: { name: string; cmd: string; args: string[] }[] }
> = {
  pipeline: {
    label: 'Full Pipeline',
    phases: [
      { name: 'scrape + score', cmd: 'npx', args: ['tsx', 'src/scrape-and-score.ts'] },
      { name: 'auto apply', cmd: 'npx', args: ['tsx', 'src/auto-apply.ts'] },
    ],
  },
  scrape: {
    label: 'Scrape + Score',
    phases: [{ name: 'scrape + score', cmd: 'npx', args: ['tsx', 'src/scrape-and-score.ts'] }],
  },
  apply: {
    label: 'Auto Apply',
    phases: [{ name: 'auto apply', cmd: 'npx', args: ['tsx', 'src/auto-apply.ts'] }],
  },
};

// Auto-apply parks on a filled form waiting for the user to review and submit,
// so a phase legitimately runs for a long time.
const PHASE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

// Each concurrent auto-apply opens its own maximised, non-headless Chromium and
// holds it for up to 30 minutes awaiting review. Two is enough to keep working
// while one waits on you, without burying the screen or the machine.
const MAX_CONCURRENT_AUTO_APPLY = 2;

@Injectable()
export class PipelineService {
  // Every live child. runSelectedPhases deliberately lets an auto-apply run
  // alongside an already-running pipeline, so a single-slot handle got
  // clobbered by the second spawn: Stop would kill the auto-apply and orphan
  // the scrape, and whichever child exited first would clear the handle for the
  // one still running, leaving Stop with nothing to kill.
  private activeChildren = new Set<ChildProcess>();
  // Bounds how many auto-apply browsers can be open at once.
  private readonly autoApplyLimiter = new Limiter(MAX_CONCURRENT_AUTO_APPLY);
  private cancelled = false;

  private state: PipelineState = {
    running: false,
    phase: null,
    command: null,
    error: null,
    lastRunAt: null,
    logs: [],
  };

  private maxLogs = 500;

  getStatus(): PipelineState {
    return { ...this.state, logs: [...this.state.logs] };
  }

  getLogs(since: number = 0): { logs: string[]; total: number } {
    return {
      logs: this.state.logs.slice(since),
      total: this.state.logs.length,
    };
  }

  getAvailableCommands(): { id: string; label: string }[] {
    return Object.entries(COMMANDS).map(([id, c]) => ({ id, label: c.label }));
  }

  getAvailablePhases(): { id: string; label: string }[] {
    return PHASE_LIST.map((p) => ({ id: p.id, label: p.label }));
  }

  async runCommand(commandId: string): Promise<void> {
    if (this.state.running) {
      throw new ConflictException('A command is already running');
    }

    const command = COMMANDS[commandId];
    if (!command) {
      throw new Error(`Unknown command: ${commandId}`);
    }

    this.state = {
      running: true,
      phase: command.phases[0].name,
      command: command.label,
      error: null,
      lastRunAt: null,
      logs: [],
    };

    this.addLog(`--- ${command.label} started ---`);

    const scraperDir = SCRAPER_DIR_RESOLVER();

    // run in background
    this.runPhasesSequentially(command.phases, scraperDir);
  }

  async runSelectedPhases(
    phaseIds: string[],
    scrapeSources?: string[],
    applyPlatforms?: string[],
    applyLimit?: number,
    applyJobIds?: string[],
  ): Promise<void> {
    // The `running` check must be reached without an intervening await. Reading
    // the auto-submit setting first yielded the event loop, so a burst of
    // simultaneous requests could all observe running === false, all take the
    // sequential path below, and each overwrite this.state — resetting the log
    // buffer and command label. The DB read now happens after a path is chosen.
    if (this.state.running) {
      // Allow auto-apply to run concurrently with scraping
      const isAutoApply = phaseIds.length === 1 && phaseIds[0] === 'apply';
      if (!isAutoApply) {
        throw new ConflictException('A command is already running');
      }
      const allowAutoSubmit = await readAllowAutoSubmit();
      // Spawn independently without blocking the running pipeline
      console.log('[Pipeline] Running Auto Apply concurrently with:', this.state.command);
      const phase = PHASE_LIST.find((p) => p.id === 'apply')!;
      const args = [...phase.args];
      if (applyPlatforms && applyPlatforms.length > 0)
        args.push(`--platforms=${applyPlatforms.join(',')}`);
      if (applyLimit) args.push(`--limit=${applyLimit}`);
      if (applyJobIds && applyJobIds.length > 0) args.push(`--jobs=${applyJobIds.join(',')}`);
      args.push(`--submit=${allowAutoSubmit}`);
      const scraperDir = SCRAPER_DIR_RESOLVER();
      const queued = this.autoApplyLimiter.inFlight >= MAX_CONCURRENT_AUTO_APPLY;
      this.addLog(
        queued
          ? `--- Auto Apply queued (${MAX_CONCURRENT_AUTO_APPLY} already running) ---`
          : '--- Auto Apply started (concurrent) ---',
      );
      // Through the limiter: each spawn drives its own visible Chromium that
      // stays open for review, so N clicks used to mean N browsers. Ten clicks
      // measured at ~80 Chrome processes and ~3 GB. Extra requests now wait for
      // a slot rather than piling on.
      this.autoApplyLimiter
        .run(() => this.spawnWithLogs(phase.cmd, args, scraperDir))
        .then(() => {
          this.addLog('--- Auto Apply completed ---');
        })
        .catch((err) => {
          this.addLog(`ERROR: Auto Apply failed — ${(err as Error).message}`);
        });
      return;
    }

    // Claim the slot synchronously, before any await. The guard above is only
    // meaningful if nothing can pass it twice, and `running` was previously not
    // set until after the DB read below — so two simultaneous requests could
    // both see false, both proceed, and each overwrite this.state.
    this.state.running = true;
    try {
      return await this.startSequential(
        phaseIds,
        scrapeSources,
        applyPlatforms,
        applyLimit,
        applyJobIds,
      );
    } catch (err) {
      // Release the claim, or a rejected request wedges the pipeline forever.
      this.state.running = false;
      throw err;
    }
  }

  private async startSequential(
    phaseIds: string[],
    scrapeSources?: string[],
    applyPlatforms?: string[],
    applyLimit?: number,
    applyJobIds?: string[],
  ): Promise<void> {
    const allowAutoSubmit = await readAllowAutoSubmit();

    const phases = phaseIds
      .map((id) => {
        const phase = PHASE_LIST.find((p) => p.id === id);
        if (!phase) return null;
        if (id === 'scrape' && scrapeSources && scrapeSources.length > 0) {
          return { ...phase, args: [...phase.args, `--sources=${scrapeSources.join(',')}`] };
        }
        if (id === 'apply') {
          const args = [...phase.args];
          if (applyPlatforms && applyPlatforms.length > 0)
            args.push(`--platforms=${applyPlatforms.join(',')}`);
          if (applyLimit) args.push(`--limit=${applyLimit}`);
          if (applyJobIds && applyJobIds.length > 0) args.push(`--jobs=${applyJobIds.join(',')}`);
          args.push(`--submit=${allowAutoSubmit}`);
          return { ...phase, args };
        }
        return phase;
      })
      .filter(Boolean) as typeof PHASE_LIST;

    if (phases.length === 0) {
      throw new Error('No valid phases selected');
    }

    const label =
      phases.length === PHASE_LIST.length
        ? 'Full Pipeline'
        : phases.map((p) => p.label).join(' + ');

    this.state = {
      running: true,
      phase: phases[0].name,
      command: label,
      error: null,
      lastRunAt: null,
      logs: [],
    };

    this.addLog(`--- ${label} started ---`);

    const scraperDir = SCRAPER_DIR_RESOLVER();
    this.runPhasesSequentially(phases, scraperDir);
  }

  stopPipeline(): void {
    // A concurrent auto-apply can still be alive after the pipeline itself has
    // finished, so don't bail purely on `running`.
    if (!this.state.running && this.activeChildren.size === 0) return;
    this.cancelled = true;

    // Snapshot: the force-kill below must target exactly what was alive at stop
    // time, never something spawned during the 3s grace period.
    const children = [...this.activeChildren];
    for (const child of children) child.kill('SIGTERM');
    if (children.length > 0) {
      setTimeout(() => {
        // Still in the set means 'close' never fired — it ignored SIGTERM.
        for (const child of children) {
          if (this.activeChildren.has(child)) child.kill('SIGKILL');
        }
      }, 3000);
    }
    this.addLog('--- Pipeline stopped by user ---');
    this.state.running = false;
    this.state.phase = null;
    this.state.error = 'Stopped by user';
    this.state.lastRunAt = new Date().toISOString();
  }

  private addLog(line: string) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false });
    this.state.logs.push(`[${timestamp}] ${line}`);
    if (this.state.logs.length > this.maxLogs) {
      this.state.logs = this.state.logs.slice(-this.maxLogs);
    }
  }

  private async runPhasesSequentially(
    phases: { name: string; cmd: string; args: string[] }[],
    cwd: string,
  ): Promise<void> {
    this.cancelled = false;

    for (const phase of phases) {
      if (this.cancelled) return;

      this.state.phase = phase.name;
      this.addLog(`Phase: ${phase.name}`);

      try {
        await this.spawnWithLogs(phase.cmd, phase.args, cwd);
        if (this.cancelled) return;
        this.addLog(`Phase "${phase.name}" completed`);
      } catch (err) {
        if (this.cancelled) return;
        const msg = (err as Error).message;
        this.state.error = `${phase.name} failed: ${msg}`;
        this.addLog(`ERROR: ${phase.name} failed — ${msg}`);
        this.state.running = false;
        this.state.phase = null;
        return;
      }
    }

    this.state.running = false;
    this.state.phase = null;
    this.state.lastRunAt = new Date().toISOString();
    this.addLog(`--- ${this.state.command} completed ---`);
  }

  private spawnWithLogs(cmd: string, args: string[], cwd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, FORCE_COLOR: '0' },
      });

      this.activeChildren.add(child);

      // Cleared on exit. Previously this timer was never cancelled, so every
      // spawn left a 2-hour handle holding the child in a closure — even for
      // runs that finished in seconds.
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, PHASE_TIMEOUT_MS);

      const settle = () => {
        clearTimeout(timeout);
        this.activeChildren.delete(child);
      };

      child.stdout.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          this.addLog(line);
          process.stdout.write(`[pipeline] ${line}\n`);
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n').filter(Boolean);
        for (const line of lines) {
          this.addLog(`[stderr] ${line}`);
          process.stderr.write(`[pipeline] ${line}\n`);
        }
      });

      child.on('close', (code) => {
        settle();
        if (timedOut) {
          reject(new Error('Timed out after 2 hours'));
        } else if (this.cancelled || code === 0) {
          resolve();
        } else {
          reject(new Error(`Process exited with code ${code}`));
        }
      });

      child.on('error', (err) => {
        settle();
        reject(err);
      });
    });
  }
}
