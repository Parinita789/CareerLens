import { Controller, Get, Post, Put, Patch, Param, Body } from '@nestjs/common';
import { JobsService } from './jobs.service';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get()
  getAllJobs() {
    return this.jobsService.getAllJobs();
  }

  @Get('cover-letters')
  getCoverLetters() {
    return this.jobsService.getJobsWithCoverLetters();
  }

  @Get(':id')
  getJobById(@Param('id') id: string) {
    return this.jobsService.getJobById(id);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body()
    body: {
      status: string;
      reason?: string;
      interview_round?: string;
      accepted_outcome?: string;
    },
  ) {
    return this.jobsService.updateJobStatus(
      id,
      body.status,
      body.reason,
      body.interview_round,
      body.accepted_outcome,
    );
  }

  @Post(':id/cover-letter')
  async generateCoverLetter(@Param('id') id: string) {
    return this.jobsService.generateCoverLetter(id);
  }

  @Put(':id/cover-letter')
  async updateCoverLetter(@Param('id') id: string, @Body() body: { content: string }) {
    return this.jobsService.updateCoverLetter(id, body.content);
  }

  @Post('adhoc-cover-letter')
  async createAdhocCoverLetter(
    @Body() body: { description: string; title?: string; company?: string },
  ) {
    return this.jobsService.createAdhocCoverLetter(body);
  }

  @Post('manual')
  async addManualJob(
    @Body()
    body: {
      title: string;
      company: string;
      url?: string;
      source?: string;
      status?: string;
      interview_round?: string;
      accepted_outcome?: string;
    },
  ) {
    return this.jobsService.addManualJob(body);
  }
}
