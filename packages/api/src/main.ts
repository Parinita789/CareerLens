import { NestFactory } from '@nestjs/core';
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

  const port = process.env.API_PORT ?? 3001;
  await app.listen(port);
  console.log(`API running on http://localhost:${port}`);
}

bootstrap();
