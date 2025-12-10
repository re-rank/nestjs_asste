import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { TradingService } from '../services/trading.service';
import { NotificationService } from '../services/notification.service';
import type { Market } from '../types/ai-trading.types';

@Injectable()
export class TradingSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(TradingSchedulerService.name);

  constructor(
    private tradingService: TradingService,
    private notificationService: NotificationService,
  ) {}

  onModuleInit() {
    this.logger.log('🤖 Trading Scheduler initialized');
    this.logger.log('📅 Trading schedules configured:');
    this.logger.log('   - Trading check: every 30 minutes');
    this.logger.log('   - Portfolio record: every hour');
  }

  /**
   * 서머타임 적용 여부 (미국 기준: 3월 둘째 일요일 ~ 11월 첫째 일요일)
   */
  private isUSDaylightSavingTime(): boolean {
    const now = new Date();
    const year = now.getFullYear();

    // 3월 둘째 일요일
    const marchFirst = new Date(year, 2, 1);
    const dstStart = new Date(
      year,
      2,
      8 + ((7 - marchFirst.getDay()) % 7),
      2,
      0,
      0,
    );

    // 11월 첫째 일요일
    const novFirst = new Date(year, 10, 1);
    const dstEnd = new Date(
      year,
      10,
      1 + ((7 - novFirst.getDay()) % 7),
      2,
      0,
      0,
    );

    return now >= dstStart && now < dstEnd;
  }

  /**
   * 현재 시장이 열려있는지 확인
   */
  isMarketOpen(market: Market): boolean {
    const now = new Date();
    const kstHours = now.getHours();
    const kstMinutes = now.getMinutes();
    const dayOfWeek = now.getDay();

    // 주말이면 닫힘
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return false;
    }

    const currentTime = kstHours * 60 + kstMinutes;

    if (market === 'KR') {
      // 국내증시: 9:00 ~ 15:00 KST
      const openTime = 9 * 60;
      const closeTime = 15 * 60;
      return currentTime >= openTime && currentTime < closeTime;
    } else {
      // 미국증시: 23:30 ~ 06:00 KST (또는 서머타임 시 22:30 ~ 05:00)
      const isDST = this.isUSDaylightSavingTime();

      if (isDST) {
        // 서머타임: 22:30 ~ 05:00
        const openTime = 22 * 60 + 30;
        const closeTime = 5 * 60;
        return currentTime >= openTime || currentTime < closeTime;
      } else {
        // 표준시: 23:30 ~ 06:00
        const openTime = 23 * 60 + 30;
        const closeTime = 6 * 60;
        return currentTime >= openTime || currentTime < closeTime;
      }
    }
  }

  /**
   * 시장 상태 정보 반환
   */
  getMarketStatus(): {
    kr: { isOpen: boolean; nextOpen: string; nextClose: string };
    us: { isOpen: boolean; nextOpen: string; nextClose: string };
  } {
    const isDST = this.isUSDaylightSavingTime();
    const krOpen = this.isMarketOpen('KR');
    const usOpen = this.isMarketOpen('US');

    return {
      kr: {
        isOpen: krOpen,
        nextOpen: krOpen ? '현재 장중' : '09:00',
        nextClose: krOpen ? '15:00' : '-',
      },
      us: {
        isOpen: usOpen,
        nextOpen: usOpen ? '현재 장중' : isDST ? '22:30' : '23:30',
        nextClose: usOpen ? (isDST ? '05:00' : '06:00') : '-',
      },
    };
  }

  /**
   * 30분마다 시장 체크 및 트레이딩 실행
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async handleTradingSchedule() {
    const now = new Date();
    this.logger.log(`\n⏰ [${now.toISOString()}] Scheduler triggered`);

    // 국내 시장 체크
    if (this.isMarketOpen('KR')) {
      this.logger.log('🇰🇷 Korean market is OPEN - running trading round');
      try {
        const result = await this.tradingService.runMarketTradingRound('KR');
        if (result.tradesExecuted > 0) {
          this.logger.log(`🇰🇷 국내 매매 ${result.tradesExecuted}건 체결`);
        }
      } catch (error) {
        this.logger.error('KR trading error:', error);
        await this.notificationService.sendErrorNotification(
          'KR Trading',
          String(error),
        );
      }
    } else {
      this.logger.log('🇰🇷 Korean market is CLOSED');
    }

    // 미국 시장 체크
    if (this.isMarketOpen('US')) {
      this.logger.log('🇺🇸 US market is OPEN - running trading round');
      try {
        const result = await this.tradingService.runMarketTradingRound('US');
        if (result.tradesExecuted > 0) {
          this.logger.log(`🇺🇸 미국 매매 ${result.tradesExecuted}건 체결`);
        }
      } catch (error) {
        this.logger.error('US trading error:', error);
        await this.notificationService.sendErrorNotification(
          'US Trading',
          String(error),
        );
      }
    } else {
      this.logger.log('🇺🇸 US market is CLOSED');
    }
  }

  /**
   * 매 정시에 포트폴리오 가치 기록
   */
  @Cron(CronExpression.EVERY_HOUR)
  async handlePortfolioRecord() {
    this.logger.log('📊 Recording portfolio values...');
    try {
      await this.tradingService.recordAllPortfolioValues();
    } catch (error) {
      this.logger.error('Portfolio record error:', error);
    }
  }

  /**
   * 수동으로 트레이딩 트리거 (API용)
   */
  async triggerTradingRound(
    market: Market,
  ): Promise<{ success: boolean; tradesExecuted: number }> {
    this.logger.log(`🔧 Manual trading trigger: ${market}`);
    const result = await this.tradingService.runMarketTradingRound(market);
    return {
      success: result.success,
      tradesExecuted: result.tradesExecuted,
    };
  }
}
