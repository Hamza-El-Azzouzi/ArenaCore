import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {DatabaseModule} from '../database/database.module';
import {Notifications,NotificationsController} from './notifications';

@Module({imports:[DatabaseModule,AuthModule],controllers:[NotificationsController],providers:[Notifications],exports:[Notifications]})
export class NotificationsModule{}
