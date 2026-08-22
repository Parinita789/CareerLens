import { Controller, Get, Put, Patch, Delete, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiOkResponse } from '@nestjs/swagger';
import { ApplicationFieldsService } from './application-fields.service';
import { UpdateFieldDto } from './dto/update-field.dto';
import { UpdateApplicationFieldsStatusDto } from './dto/update-application-fields-status.dto';

@ApiTags('application-fields')
@Controller('application-fields')
export class ApplicationFieldsController {
  constructor(private readonly service: ApplicationFieldsService) {}

  @Get()
  @ApiOperation({ summary: 'List pre-scraped application forms for every high-scoring job (the Prepare tab).' })
  @ApiOkResponse({ description: 'Array of application-fields records, sorted by unknownCount desc then scrapedAt desc.' })
  getAll() {
    return this.service.getAll();
  }

  @Get(':jobId')
  @ApiOperation({ summary: 'Get the pre-scraped application form for a single job.' })
  @ApiParam({ name: 'jobId', description: 'Job externalId.' })
  @ApiOkResponse({ description: 'The application-fields record.' })
  getByJobId(@Param('jobId') jobId: string) {
    return this.service.getByJobId(jobId);
  }

  @Put(':jobId/fields/:fieldIndex')
  @ApiOperation({ summary: 'Correct a single form field\'s answer, optionally saving it as a reusable rule.' })
  @ApiParam({ name: 'jobId', description: 'Job externalId.' })
  @ApiParam({ name: 'fieldIndex', description: 'Index of the field within the record\'s `fields` array.' })
  @ApiOkResponse({ description: 'The updated application-fields record.' })
  updateField(
    @Param('jobId') jobId: string,
    @Param('fieldIndex') fieldIndex: string,
    @Body() body: UpdateFieldDto,
  ) {
    return this.service.updateField(jobId, parseInt(fieldIndex, 10), body.value, body.saveAsRule ?? true);
  }

  @Patch(':jobId/status')
  @ApiOperation({ summary: 'Update an application-fields record\'s review status.' })
  @ApiParam({ name: 'jobId', description: 'Job externalId.' })
  @ApiOkResponse({ description: 'The updated application-fields record.' })
  updateStatus(@Param('jobId') jobId: string, @Body() body: UpdateApplicationFieldsStatusDto) {
    return this.service.updateStatus(jobId, body.status);
  }

  @Delete(':jobId')
  @ApiOperation({ summary: 'Remove a job\'s pre-scraped application form (e.g. after applying).' })
  @ApiParam({ name: 'jobId', description: 'Job externalId.' })
  @ApiOkResponse({ description: 'Deleted.' })
  deleteByJobId(@Param('jobId') jobId: string) {
    return this.service.deleteByJobId(jobId);
  }
}
