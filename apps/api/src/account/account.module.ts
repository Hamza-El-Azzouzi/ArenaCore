import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {DatabaseModule} from '../database/database.module';
import {AccountController,AccountService} from './account';

@Module({imports:[DatabaseModule,AuthModule],controllers:[AccountController],providers:[AccountService]})
export class AccountModule{}
