import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {DatabaseModule} from '../database/database.module';
import {AdminController, AdminService} from './admin';

@Module({imports: [DatabaseModule, AuthModule], controllers: [AdminController], providers: [AdminService]})
export class AdminModule {}
