import { Injectable, ConflictException } from '@nestjs/common';
import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';

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
    args: ['tsx', 'src/phase2.ts'],
  },
  {
    id: 'gmail-alerts',
    label: 'Gmail Alerts',
    name: 'gmail alerts',
    cmd: 'npx',
    args: ['tsx', 'src/phase-gmail-alerts.ts', '--watch', '--interval=60'],
  },
  {
    id: 'apply',
    label: 'Auto Apply',
    name: 'auto apply',
    cmd: 'npx',
    args: ['tsx', 'src/phase4.ts'],
  },
];

const COMMANDS: Record<
  string,
  { label: string; phases: { name: string; cmd: string; args: string[] }[] }
> = {
  pipeline: {
    label: 'Full Pipeline',
    phases: [
      { name: 'scrape + score', cmd: 'npx', args: ['tsx', 'src/phase2.ts'] },
      { name: 'cover letters', cmd: 'npx', args: ['tsx', 'src/phase3.ts'] },
      { name: 'auto apply', cmd: 'npx', args: ['tsx', 'src/phase4.ts'] },
    ],
  },
  scrape: {
    label: 'Scrape + Score',
    phases: [{ name: 'scrape + score', cmd: 'npx', args: ['tsx', 'src/phase2.ts'] }],
  },
  'cover-letters': {
    label: 'Generate Cover Letters',
    phases: [{ name: 'cover letters', cmd: 'npx', args: ['tsx', 'src/phase3.ts'] }],
  },
  apply: {
    label: 'Auto Apply',
    phases: [{ name: 'auto apply', cmd: 'npx', args: ['tsx', 'src/phase4.ts'] }],
  },
};

@Injectable()
export class PipelineService {
  private currentChild: ChildProcess | null = null;
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
    if (this.state.running) {
      // Allow auto-apply to run concurrently with scraping
      const isAutoApply = phaseIds.length === 1 && phaseIds[0] === 'apply';
      const isCoverLetters = phaseIds.length === 1 && phaseIds[0] === 'cover-letters';
      if (!isAutoApply && !isCoverLetters) {
        throw new ConflictException('A command is already running');
      }
      // Spawn independently without blocking the running pipeline
      const actionName = isAutoApply ? 'Auto Apply' : 'Cover Letters';
      console.log(`[Pipeline] Running ${actionName} concurrently with:`, this.state.command);
      const phaseId = isAutoApply ? 'apply' : 'cover-letters';
      const phase = PHASE_LIST.find((p) => p.id === phaseId);
      if (!phase) {
        const scraperDir = SCRAPER_DIR_RESOLVER();
        const args = ['tsx', phaseId === 'apply' ? 'src/phase4.ts' : 'src/phase3.ts'];
        if (applyJobIds && applyJobIds.length > 0) args.push(`--jobs=${applyJobIds.join(',')}`);
        if (applyPlatforms && applyPlatforms.length > 0)
          args.push(`--platforms=${applyPlatforms.join(',')}`);
        if (applyLimit) args.push(`--limit=${applyLimit}`);
        this.addLog(`--- ${actionName} started (concurrent) ---`);
        this.spawnWithLogs('npx', args, scraperDir)
          .then(() => {
            this.addLog(`--- ${actionName} completed ---`);
          })
          .catch((err) => {
            this.addLog(`ERROR: ${actionName} failed — ${(err as Error).message}`);
          });
      } else {
        const args = [...phase.args];
        if (applyPlatforms && applyPlatforms.length > 0)
          args.push(`--platforms=${applyPlatforms.join(',')}`);
        if (applyLimit) args.push(`--limit=${applyLimit}`);
        if (applyJobIds && applyJobIds.length > 0) args.push(`--jobs=${applyJobIds.join(',')}`);
        const scraperDir = SCRAPER_DIR_RESOLVER();
        this.addLog(`--- ${actionName} started (concurrent) ---`);
        this.spawnWithLogs(phase.cmd, args, scraperDir)
          .then(() => {
            this.addLog(`--- ${actionName} completed ---`);
          })
          .catch((err) => {
            this.addLog(`ERROR: ${actionName} failed — ${(err as Error).message}`);
          });
      }
      return;
    }

    const phases = phaseIds
      .map((id) => {
        const phase = PHASE_LIST.find((p) => p.id === id);
        if (!phase) return null;
        if (id === 'scrape' && scrapeSources && scrapeSources.length > 0) {
          return { ...phase, args: [...phase.args, `--sources=${scrapeSources.join(',')}`] };
        }
        if (id === 'cover-letters' && applyJobIds && applyJobIds.length > 0) {
          return { ...phase, args: [...phase.args, `--jobs=${applyJobIds.join(',')}`] };
        }
        if (id === 'apply') {
          const args = [...phase.args];
          if (applyPlatforms && applyPlatforms.length > 0)
            args.push(`--platforms=${applyPlatforms.join(',')}`);
          if (applyLimit) args.push(`--limit=${applyLimit}`);
          if (applyJobIds && applyJobIds.length > 0) args.push(`--jobs=${applyJobIds.join(',')}`);
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
    if (!this.state.running) return;
    this.cancelled = true;
    if (this.currentChild) {
      this.currentChild.kill('SIGTERM');
      // Force kill after 3s if still alive
      setTimeout(() => {
        if (this.currentChild) this.currentChild.kill('SIGKILL');
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

      this.currentChild = child;

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
        this.currentChild = null;
        if (this.cancelled) {
          resolve();
        } else if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Process exited with code ${code}`));
        }
      });

      child.on('error', (err) => {
        this.currentChild = null;
        reject(err);
      });

      // timeout after 2 hours (auto-apply needs time for user to fill forms)
      setTimeout(() => {
        child.kill();
        reject(new Error('Timed out after 2 hours'));
      }, 7200000);
    });
  }
}
