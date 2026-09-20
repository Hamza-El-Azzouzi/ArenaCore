import { Inject, Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { Config } from '../config/config';

export interface DatabaseConfiguration {
  readonly values: { readonly DATABASE_URL: string };
}

@Injectable()
export class Database extends PrismaClient implements OnModuleInit, OnApplicationShutdown {
  constructor(@Inject(Config) config: DatabaseConfiguration) {
    super({ datasources: { db: { url: config.values.DATABASE_URL } } });
  }
  async onModuleInit() { await this.$connect(); }
  // Background maintenance stops during module teardown; disconnect only after
  // that work and HTTP transport shutdown have completed.
  async onApplicationShutdown() { await this.$disconnect(); }
}
