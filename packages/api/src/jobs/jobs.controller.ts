import { Controller, Get, Post, Put, Patch, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiOkResponse } from '@nestjs/swagger';
import { JobsService } from './jobs.service';
import { UpdateJobStatusDto } from './dto/update-job-status.dto';
import { UpdateCoverLetterDto } from './dto/update-cover-letter.dto';
import { CreateAdhocCoverLetterDto } from './dto/create-adhoc-cover-letter.dto';
import { AddManualJobDto } from './dto/add-manual-job.dto';

@ApiTags('jobs')
@Controller('jobs')
export class JobsController {
  constructor(private readonly jobsService: JobsService) {}

  @Get()
  @ApiOperation({ summary: 'List all tracked jobs, sorted by fit score.' })
  @ApiOkResponse({ description: 'Array of job records.' })
  getAllJobs() {
    return this.jobsService.getAllJobs();
  }

  @Get('cover-letters')
  @ApiOperation({ summary: 'List every job that has a generated cover letter.' })
  @ApiOkResponse({ description: 'Array of jobs with their latest cover letter attached.' })
  getCoverLetters() {
    return this.jobsService.getJobsWithCoverLetters();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a single job by its external ID.' })
  @ApiParam({ name: 'id', description: 'Job externalId.' })
  @ApiOkResponse({ description: 'The job record, with its latest cover letter attached if one exists.' })
  getJobById(@Param('id') id: string) {
    return this.jobsService.getJobById(id);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Update a job\'s tracked status (move it between Queue/Applied/Interviewing/etc).' })
  @ApiParam({ name: 'id', description: 'Job externalId.' })
  @ApiOkResponse({ description: 'The updated job record.' })
  updateStatus(@Param('id') id: string, @Body() body: UpdateJobStatusDto) {
    return this.jobsService.updateJobStatus(
      id,
      body.status,
      body.reason,
      body.interview_round,
      body.accepted_outcome,
    );
  }

  @Post(':id/cover-letter')
  @ApiOperation({ summary: 'Generate a new cover letter for this job (overwrites the current one).' })
  @ApiParam({ name: 'id', description: 'Job externalId.' })
  @ApiOkResponse({ description: 'The generated cover letter (raw LLM draft and humanized final text).' })
  async generateCoverLetter(@Param('id') id: string) {
    return this.jobsService.generateCoverLetter(id);
  }

  @Put(':id/cover-letter')
  @ApiOperation({ summary: 'Manually edit and save a job\'s cover letter text.' })
  @ApiParam({ name: 'id', description: 'Job externalId.' })
  @ApiOkResponse({ description: 'The saved cover letter content.' })
  async updateCoverLetter(@Param('id') id: string, @Body() body: UpdateCoverLetterDto) {
    return this.jobsService.updateCoverLetter(id, body.content);
  }

  @Post('adhoc-cover-letter')
  @ApiOperation({ summary: 'Generate a cover letter from a pasted job description, without a tracked job.' })
  @ApiOkResponse({ description: 'A new draft-status job plus its generated cover letter.' })
  async createAdhocCoverLetter(@Body() body: CreateAdhocCoverLetterDto) {
    return this.jobsService.createAdhocCoverLetter(body);
  }

  @Post('manual')
  @ApiOperation({ summary: 'Manually add a job that wasn\'t found by the scraper.' })
  @ApiOkResponse({ description: 'The created job record.' })
  async addManualJob(@Body() body: AddManualJobDto) {
    return this.jobsService.addManualJob(body);
  }
}
