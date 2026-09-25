import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {DatabaseModule} from '../database/database.module';
import {Profiles, ProfilesController} from './profiles';

@Module({imports: [DatabaseModule, AuthModule], controllers: [ProfilesController], providers: [Profiles]})
export class ProfilesModule {}
