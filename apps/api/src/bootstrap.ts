import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';
import { json } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ErrorFilter } from './common/errors';

export async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {bodyParser: false, logger: ['error', 'warn']});
  app.disable('x-powered-by');
  app.setGlobalPrefix('api/v1');
  app.use(helmet());
  app.use((_req: unknown, res: {setHeader: (name: string, value: string) => void}, next: () => void) => {res.setHeader('X-Request-Id', randomUUID()); res.setHeader('Cache-Control', 'no-store'); next();});
  // Leave room for JSON escaping of a source string; source itself has its own UTF-8 byte cap.
  app.use(json({limit: '512kb', strict: true}));
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  return app;
}
