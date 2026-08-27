import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiQuery, ApiOkResponse } from '@nestjs/swagger';
import { PipelineService } from './pipeline.service';
import { ApplicationTaskService } from './application-task.service';
import { RunPhasesDto } from './dto/run-phases.dto';
import { AutoApplyDto } from './dto/auto-apply.dto';

@ApiTags('pipeline')
@Controller('pipeline')
export class PipelineController {
  constructor(
    private readonly pipelineService: PipelineService,
    private readonly applicationTasks: ApplicationTaskService,
  ) {}

  @Get('commands')
  @ApiOperation({ summary: 'List the preset commands (Full Pipeline, Scrape + Score, Auto Apply) the UI can trigger.' })
  @ApiOkResponse({ description: 'Map of command ID to { label, phases }.' })
  getCommands() {
    return this.pipelineService.getAvailableCommands();
  }

  @Get('phases')
  @ApiOperation({ summary: 'List the individual phases (scrape, gmail-alerts, apply) that can be composed via run-phases.' })
  @ApiOkResponse({ description: 'Array of { id, label }.' })
  getPhases() {
    return this.pipelineService.getAvailablePhases();
  }

  @Post('run-phases')
  @ApiOperation({ summary: 'Run a custom selection of pipeline phases, in order.' })
  @ApiOkResponse({ description: 'Pipeline started — poll GET /pipeline/status and GET /pipeline/logs for progress.' })
  async runPhases(@Body() body: RunPhasesDto) {
    await this.pipelineService.runSelectedPhases(body.phases, body.scrapeSources, body.applyPlatforms, body.applyLimit, body.applyJobIds);
    return { message: 'Pipeline started' };
  }

  @Post('run/:commandId')
  @ApiOperation({ summary: 'Run one of the preset commands from GET /pipeline/commands.' })
  @ApiParam({ name: 'commandId', description: 'A command ID returned by GET /pipeline/commands, e.g. "pipeline", "scrape", "apply".' })
  @ApiOkResponse({ description: 'Pipeline started.' })
  async runCommand(@Param('commandId') commandId: string) {
    await this.pipelineService.runCommand(commandId);
    return { message: `${commandId} started` };
  }

  @Post('run')
  @ApiOperation({ summary: 'Run the full pipeline (scrape + apply). Equivalent to POST /pipeline/run/pipeline.' })
  @ApiOkResponse({ description: 'Pipeline started.' })
  async runPipeline() {
    await this.pipelineService.runCommand('pipeline');
    return { message: 'Pipeline started' };
  }

  @Post('auto-apply')
  @ApiOperation({ summary: 'Auto-apply to a specific set of jobs (used by the "Auto Apply" bulk action in the job table).' })
  @ApiOkResponse({ description: 'Auto-apply started.' })
  async autoApply(@Body() body: AutoApplyDto) {
    await this.pipelineService.runSelectedPhases(['apply'], undefined, undefined, undefined, body.jobIds);
    return { message: `Auto-applying to ${body.jobIds.length} jobs` };
  }

  @Get('tasks')
  @ApiOperation({ summary: 'List application tasks, newest first — one row per job applied to.' })
  @ApiOkResponse({ description: 'Application task queue.' })
  @ApiQuery({ name: 'limit', required: false, description: 'How many to return, newest first. Default 100, max 500.' })
  async listTasks(@Query('limit') limit?: string) {
    const n = Number(limit);
    return this.applicationTasks.list(Number.isFinite(n) && n > 0 ? Math.min(n, 500) : 100);
  }

  @Post('tasks/:id/retry')
  @ApiOperation({
    summary:
      'Requeue one application. This is the only way a needs_review task runs again — those failed after a submit was attempted and are never retried automatically.',
  })
  @ApiOkResponse({ description: 'Task requeued.' })
  async retryTask(@Param('id') id: string) {
    await this.applicationTasks.retry(id);
    return { message: 'Task requeued' };
  }

  @Post('tasks/:id/cancel')
  @ApiOperation({ summary: 'Cancel a queued application before it starts.' })
  @ApiOkResponse({ description: 'Task cancelled.' })
  async cancelTask(@Param('id') id: string) {
    await this.applicationTasks.cancel(id);
    return { message: 'Task cancelled' };
  }

  @Post('stop')
  @ApiOperation({ summary: 'Stop the currently running pipeline process, if any.' })
  @ApiOkResponse({ description: 'Pipeline stopped.' })
  stopPipeline() {
    this.pipelineService.stopPipeline();
    return { message: 'Pipeline stopped' };
  }

  @Get('status')
  @ApiOperation({ summary: 'Get the current pipeline run state (running/phase/command/error/lastRunAt).' })
  @ApiOkResponse({ description: 'Current PipelineState.' })
  getStatus() {
    return this.pipelineService.getStatus();
  }

  @Get('logs')
  @ApiOperation({ summary: 'Get pipeline log lines, optionally only those after a given index (for polling).' })
  @ApiQuery({ name: 'since', required: false, description: 'Only return log lines after this index.' })
  @ApiOkResponse({ description: '{ logs: string[], total: number } — pass `total` back as `since` on the next poll.' })
  getLogs(@Query('since') since?: string) {
    return this.pipelineService.getLogs(since ? parseInt(since, 10) : 0);
  }
}
