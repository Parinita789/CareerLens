import { Module } from '@nestjs/common';
import { PipelineController } from './pipeline.controller';
import { PipelineService } from './pipeline.service';
import { ApplicationTaskService } from './application-task.service';

@Module({
  controllers: [PipelineController],
  providers: [PipelineService, ApplicationTaskService],
})
export class PipelineModule {}
