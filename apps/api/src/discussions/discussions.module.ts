import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {DatabaseModule} from '../database/database.module';
import {Discussions, DiscussionsController} from './discussions';

@Module({imports: [DatabaseModule, AuthModule], controllers: [DiscussionsController], providers: [Discussions]})
export class DiscussionsModule {}
