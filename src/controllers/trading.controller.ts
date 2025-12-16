import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { TradingSchedulerService } from '../scheduler/trading-scheduler.service';
import { TradingService } from '../services/trading.service';
import { AIProviderService } from '../services/ai-provider.service';
import { SupabaseService } from '../services/supabase.service';
import type { Market, AIProvider } from '../types/ai-trading.types';

@Controller()
export class TradingController {
  private startTime = Date.now();

  constructor(
    private tradingSchedulerService: TradingSchedulerService,
    private tradingService: TradingService,
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
   * 수동 포트폴리오 가치 기록 트리거 (테스트/디버깅용)
   */
  @Post('api/record-portfolio')
  async triggerPortfolioRecord() {
    try {
      await this.tradingService.recordAllPortfolioValues();
      return {
        success: true,
        message: 'Portfolio values recorded successfully',
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new HttpException(
        `Portfolio record failed: ${error}`,
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
        portfolioRecord: 'every 30 minutes (after trading)',
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

  /**
   * 포트폴리오 히스토리 조회 (차트용)
   */
  @Get('api/portfolio-history')
  async getPortfolioHistory(@Query('days') days?: string) {
    const daysNum = days ? parseInt(days, 10) : 30;
    const history = await this.supabaseService.getPortfolioHistory(daysNum);
    const models = await this.supabaseService.getAIModels();

    // 모델 ID -> 이름 매핑
    const modelMap = new Map(models.map((m) => [m.id, m.name]));

    // 날짜별로 그룹화
    const groupedByDate = new Map<string, Record<string, number>>();

    for (const record of history) {
      const date = record.recordedAt.split('T')[0];
      if (!groupedByDate.has(date)) {
        groupedByDate.set(date, {});
      }
      const dateRecord = groupedByDate.get(date)!;
      const modelName = modelMap.get(record.modelId) || record.modelId;
      // 같은 날짜에 여러 기록이 있으면 마지막 값 사용
      dateRecord[modelName] = record.totalValue;
    }

    // 배열로 변환
    const chartData = Array.from(groupedByDate.entries()).map(([date, values]) => ({
      date,
      ...values,
    }));

    return {
      success: true,
      count: chartData.length,
      latestDate: chartData.length > 0 ? chartData[chartData.length - 1].date : null,
      data: chartData,
    };
  }

  /**
   * 캔들차트 데이터 조회 (일별 OHLC)
   */
  @Get('api/candle-chart')
  async getCandleChart(@Query('days') days?: string) {
    const daysNum = days ? parseInt(days, 10) : 30;

    try {
      const candleData = await this.tradingService.getCandleChartData(daysNum);
      const models = Object.keys(candleData);

      // 날짜 범위 계산
      let startDate: string | null = null;
      let endDate: string | null = null;

      for (const modelData of Object.values(candleData)) {
        if (modelData.length > 0) {
          const firstDate = modelData[0].date;
          const lastDate = modelData[modelData.length - 1].date;

          if (!startDate || firstDate < startDate) startDate = firstDate;
          if (!endDate || lastDate > endDate) endDate = lastDate;
        }
      }

      return {
        success: true,
        models,
        dateRange: {
          start: startDate,
          end: endDate,
        },
        data: candleData,
      };
    } catch (error) {
      throw new HttpException(
        `Failed to get candle chart: ${error}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 거래 기록에서 포트폴리오 히스토리 마이그레이션
   */
  @Post('api/migrate-portfolio-history')
  async migratePortfolioHistory() {
    try {
      const result = await this.tradingService.migratePortfolioHistoryFromTrades();
      return {
        success: result.success,
        message: `마이그레이션 완료: ${result.migratedDates}건 생성, ${result.skippedDates}건 스킵`,
        ...result,
      };
    } catch (error) {
      throw new HttpException(
        `Migration failed: ${error}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * 누락된 포트폴리오 히스토리 보완
   */
  @Post('api/fill-portfolio-history')
  async fillPortfolioHistory() {
    try {
      const result = await this.tradingService.fillMissingPortfolioHistory();
      return {
        success: result.success,
        message: `히스토리 보완 완료: ${result.filledDates}건 추가`,
        ...result,
      };
    } catch (error) {
      throw new HttpException(
        `Fill history failed: ${error}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
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
