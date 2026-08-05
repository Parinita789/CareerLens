import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { PipelineService } from './pipeline.service';

@Controller('pipeline')
export class PipelineController {
  constructor(private readonly pipelineService: PipelineService) {}

  @Get('commands')
  getCommands() {
    return this.pipelineService.getAvailableCommands();
  }

  @Get('phases')
  getPhases() {
    return this.pipelineService.getAvailablePhases();
  }

  @Post('run-phases')
  async runPhases(@Body() body: { phases: string[]; scrapeSources?: string[]; applyPlatforms?: string[]; applyLimit?: number; applyJobIds?: string[] }) {
    await this.pipelineService.runSelectedPhases(body.phases, body.scrapeSources, body.applyPlatforms, body.applyLimit, body.applyJobIds);
    return { message: 'Pipeline started' };
  }

  @Post('run/:commandId')
  async runCommand(@Param('commandId') commandId: string) {
    await this.pipelineService.runCommand(commandId);
    return { message: `${commandId} started` };
  }

  // keep old endpoint working
  @Post('run')
  async runPipeline() {
    await this.pipelineService.runCommand('pipeline');
    return { message: 'Pipeline started' };
  }

  @Post('auto-apply')
  async autoApply(@Body() body: { jobIds: string[] }) {
    await this.pipelineService.runSelectedPhases(['apply'], undefined, undefined, undefined, body.jobIds);
    return { message: `Auto-applying to ${body.jobIds.length} jobs` };
  }

  @Post('stop')
  stopPipeline() {
    this.pipelineService.stopPipeline();
    return { message: 'Pipeline stopped' };
  }

  @Get('status')
  getStatus() {
    return this.pipelineService.getStatus();
  }

  @Get('logs')
  getLogs(@Query('since') since?: string) {
    return this.pipelineService.getLogs(since ? parseInt(since, 10) : 0);
  }
}
