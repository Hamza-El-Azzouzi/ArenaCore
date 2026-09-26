import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {DatabaseModule} from '../database/database.module';
import {Competitions, CompetitionsController} from './competitions';

@Module({imports:[DatabaseModule,AuthModule],controllers:[CompetitionsController],providers:[Competitions]})
export class CompetitionsModule {}
