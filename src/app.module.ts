import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ServeStaticModule } from '@nestjs/serve-static';
import { join } from 'path';

import configuration from './config/configuration';

// Services
import { SupabaseService } from './services/supabase.service';
import { AIProviderService } from './services/ai-provider.service';
import { StockPriceService } from './services/stock-price.service';
import { TradingService } from './services/trading.service';
import { NotificationService } from './services/notification.service';

// Scheduler
import { TradingSchedulerService } from './scheduler/trading-scheduler.service';

// Controllers
import { TradingController } from './controllers/trading.controller';

@Module({
  imports: [
    // 환경 변수 설정
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    // 스케줄러 설정
    ScheduleModule.forRoot(),
    // 정적 파일 제공 (선택적)
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', 'public'),
      serveRoot: '/static',
    }),
  ],
  controllers: [TradingController],
  providers: [
    // Services
    SupabaseService,
    AIProviderService,
    StockPriceService,
    TradingService,
    NotificationService,
    // Scheduler
    TradingSchedulerService,
  ],
})
export class AppModule {}
