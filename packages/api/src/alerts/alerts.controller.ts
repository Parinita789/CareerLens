import { Controller, Get, Post, Delete, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam, ApiOkResponse } from '@nestjs/swagger';
import { AlertsService } from './alerts.service';
import { CreateAlertDto } from './dto/create-alert.dto';

@ApiTags('alerts')
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alertsService: AlertsService) {}

  @Get()
  @ApiOperation({ summary: 'List saved LinkedIn job-alert search keywords.' })
  @ApiOkResponse({ description: 'Array of alerts.' })
  getAll() {
    return this.alertsService.getAll();
  }

  @Post()
  @ApiOperation({ summary: 'Save a new job-alert search (keywords + location) for the scraper to poll.' })
  @ApiOkResponse({ description: 'The created alert.' })
  create(@Body() body: CreateAlertDto) {
    return this.alertsService.create(body.keywords, body.location);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove a saved alert.' })
  @ApiParam({ name: 'id', description: 'Alert ID.' })
  @ApiOkResponse({ description: '{ ok: true }' })
  delete(@Param('id') id: string) {
    this.alertsService.delete(id);
    return { ok: true };
  }
}
