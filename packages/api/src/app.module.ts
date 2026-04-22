import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import * as path from 'path';
import { JobsModule } from './jobs/jobs.module';
import { ProfileModule } from './profile/profile.module';
import { PipelineModule } from './pipeline/pipeline.module';
import { AlertsModule } from './alerts/alerts.module';
import { FormAnswersModule } from './form-answers/form-answers.module';
import { ApplicationFieldsModule } from './application-fields/application-fields.module';
import { SettingsModule } from './settings/settings.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      envFilePath: [
        path.resolve(__dirname, '../../../.env'),
        path.resolve(process.cwd(), '.env'),
      ],
      isGlobal: true,
    }),
    JobsModule,
    ProfileModule,
    PipelineModule,
    AlertsModule,
    FormAnswersModule,
    ApplicationFieldsModule,
    SettingsModule,
  ],
})
export class AppModule {}
