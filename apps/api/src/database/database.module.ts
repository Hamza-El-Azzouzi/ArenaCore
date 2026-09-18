import { Module } from '@nestjs/common';
import { Config } from '../config/config';
import { Database } from './database';
@Module({providers: [Config, Database], exports: [Config, Database]})
export class DatabaseModule {}
