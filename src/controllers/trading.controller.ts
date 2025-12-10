import {
  Controller,
  Get,
  Post,
  Param,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { TradingSchedulerService } from '../scheduler/trading-scheduler.service';
import { AIProviderService } from '../services/ai-provider.service';
import { SupabaseService } from '../services/supabase.service';
import type { Market, AIProvider } from '../types/ai-trading.types';

@Controller()
export class TradingController {
  private startTime = Date.now();

  constructor(
    private tradingSchedulerService: TradingSchedulerService,
    private aiProviderService: AIProviderService,
    private supabaseService: SupabaseService,
  ) {}

  /**
   * Health check endpoint
   */
  @Get('health')
  getHealth() {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const marketStatus = this.tradingSchedulerService.getMarketStatus();

    return {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime,
      uptimeFormatted: this.formatUptime(uptime),
      markets: marketStatus,
    };
  }

  /**
   * 시장 상태 조회
   */
  @Get('api/market-status')
  getMarketStatus() {
    return this.tradingSchedulerService.getMarketStatus();
  }

  /**
   * 수동 트레이딩 트리거 (테스트/디버깅용)
   */
  @Post('api/trigger/:market')
  async triggerTrading(@Param('market') market: string) {
    if (market !== 'KR' && market !== 'US') {
      throw new HttpException(
        'Invalid market. Use KR or US',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const result = await this.tradingSchedulerService.triggerTradingRound(
        market as Market,
      );
      return {
        success: true,
        market,
        ...result,
      };
    } catch (error) {
      throw new HttpException(
        `Trading failed: ${error}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 서버 정보 조회
   */
  @Get('api/info')
  getInfo() {
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);
    const marketStatus = this.tradingSchedulerService.getMarketStatus();
    const isDST = this.isDaylightSavingTime();

    return {
      name: 'AI Trading Backend',
      version: '1.0.0',
      uptime: this.formatUptime(uptime),
      environment: process.env.NODE_ENV || 'development',
      timezone: 'Asia/Seoul',
      daylightSavingTime: isDST,
      schedules: {
        trading: 'every 30 minutes',
        portfolioRecord: 'every hour',
      },
      markets: {
        KR: {
          ...marketStatus.kr,
          hours: '09:00 ~ 15:00 KST',
        },
        US: {
          ...marketStatus.us,
          hours: isDST
            ? '22:30 ~ 05:00 KST (DST)'
            : '23:30 ~ 06:00 KST',
        },
      },
    };
  }

  /**
   * AI 프로바이더 연결 상태 확인 (백엔드 기준)
   */
  @Get('api/ai-health')
  async getAIHealth() {
    const providers: AIProvider[] = [
      'openai',
      'anthropic',
      'google',
      'xai',
      'deepseek',
    ];
    const models = await this.supabaseService.getAIModels();

    const healthStatuses = await Promise.all(
      models.map(async (model) => {
        const keyStatus = this.aiProviderService.getAPIKeyStatus(model.provider);

        // 최근 24시간 거래 횟수 조회
        const recentTrades = await this.supabaseService.getRecentTradesByModel(
          model.id,
          24,
        );

        return {
          provider: model.provider,
          name: model.name,
          hasKey: keyStatus.hasKey,
          isValid: keyStatus.isValid,
          error: keyStatus.error,
          apiKeyStatus: this.getApiKeyStatusLabel(keyStatus),
          tradesLast24h: recentTrades.length,
          lastTradeTime: recentTrades[0]?.created_at || null,
        };
      }),
    );

    return {
      timestamp: new Date().toISOString(),
      providers: healthStatuses,
    };
  }

  private formatUptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    const parts: string[] = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);

    return parts.join(' ');
  }

  private getApiKeyStatusLabel(keyStatus: {
    hasKey: boolean;
    isValid: boolean;
    error?: string;
  }): 'valid' | 'missing' | 'invalid' {
    if (!keyStatus.hasKey) return 'missing';
    if (!keyStatus.isValid) return 'invalid';
    return 'valid';
  }

  private isDaylightSavingTime(): boolean {
    const now = new Date();
    const year = now.getFullYear();

    const marchFirst = new Date(year, 2, 1);
    const dstStart = new Date(
      year,
      2,
      8 + ((7 - marchFirst.getDay()) % 7),
      2,
      0,
      0,
    );

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
}
