import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as dotenv from 'dotenv';
import * as path from 'path';
import mongoose from 'mongoose';
import { AppModule } from './app.module';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

async function bootstrap() {
  const uri = process.env.MONGO_URI || 'mongodb://localhost:27017/job-tracker';
  await mongoose.connect(uri);
  console.log(`[MongoDB] Connected to: ${uri}`);

  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: 'http://localhost:5173',
  });

  // High-frequency UI pollers. Logging each hit drowns out everything else
  // useful (cover-letter generations, applies, etc.). They're still served —
  // just not logged.
  const SILENT_POLL_PATHS = [
    '/api/jobs',
    '/api/form-answers/pending',
    '/api/pipeline/status',
    '/api/pipeline/logs',
  ];

  app.use((req: any, res: any, next: any) => {
    if (SILENT_POLL_PATHS.some((p) => req.originalUrl.startsWith(p))) {
      next();
      return;
    }
    const start = Date.now();
    res.on('finish', () => {
      const ms = Date.now() - start;
      console.log(
        `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`,
      );
    });
    next();
  });

  app.setGlobalPrefix('api');

  const swaggerConfig = new DocumentBuilder()
    .setTitle('JobPilot API')
    .setDescription(
      'REST API consumed by the JobPilot frontend (packages/ui) — job tracking, cover ' +
        'letters, the scrape/apply pipeline, application form answers, and candidate profile.',
    )
    .setVersion('1.0')
    .addTag('jobs', 'Job listings, status, and cover letters')
    .addTag('pipeline', 'Scrape/score/apply pipeline control and live logs')
    .addTag('application-fields', 'Pre-scraped application form fields (Prepare tab)')
    .addTag('form-answers', 'Q&A history, saved answer rules, and pending question prompts')
    .addTag('profile', 'Candidate profile and resume upload')
    .addTag('alerts', 'Saved LinkedIn job-alert search keywords')
    .addTag('settings', 'Global pipeline settings (e.g. auto-submit toggle)')
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDocument);

  const port = process.env.API_PORT ?? 3001;
  await app.listen(port);
  console.log(`API running on http://localhost:${port}`);
  console.log(`API docs on http://localhost:${port}/api/docs`);
}

bootstrap();
