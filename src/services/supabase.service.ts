import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type {
  AIModel,
  AIHolding,
  AITrade,
  CurrencyBalances,
  ExecuteTradeRequest,
  Market,
  DBModel,
  DBPortfolio,
  DBTrade,
  DBCashBalance,
  DBExchangeHistory,
  DBPortfolioHistory,
} from '../types/ai-trading.types';

@Injectable()
export class SupabaseService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseService.name);
  private supabase: SupabaseClient;
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 1000;

  constructor(private configService: ConfigService) {}

  /**
   * 재시도 로직을 포함한 함수 실행
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string,
  ): Promise<T> {
    let lastError: Error | null = null;
    
    for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error as Error;
        const isNetworkError = 
          error instanceof Error && 
          (error.message.includes('fetch failed') || 
           error.message.includes('ECONNRESET') ||
           error.message.includes('ETIMEDOUT'));
        
        if (isNetworkError && attempt < this.MAX_RETRIES) {
          this.logger.warn(
            `${operationName}: 네트워크 오류, ${attempt}/${this.MAX_RETRIES} 재시도 중...`,
          );
          await new Promise(resolve => setTimeout(resolve, this.RETRY_DELAY_MS * attempt));
        } else {
          throw error;
        }
      }
    }
    
    throw lastError;
  }

  onModuleInit() {
    // Cloudtype 환경 변수 직접 접근 (ConfigService보다 우선)
    const url = process.env.SUPABASE_URL || this.configService.get<string>('supabase.url');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || this.configService.get<string>('supabase.serviceRoleKey');

    this.logger.log(`Supabase URL: ${url ? 'configured' : 'missing'}`);
    this.logger.log(`Supabase Key: ${key ? 'configured' : 'missing'}`);

    if (!url || !key) {
      this.logger.warn('Supabase credentials not configured');
      this.logger.warn(`Check environment variables: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY`);
      return;
    }

    this.supabase = createClient(url, key);
    this.logger.log('Supabase client initialized successfully');
  }

  getClient(): SupabaseClient {
    return this.supabase;
  }

  // ========== AI Models ==========

  async getAIModels(): Promise<AIModel[]> {
    return this.withRetry(async () => {
      const { data, error } = await this.supabase
        .from('ai_models')
        .select('*')
        .eq('is_active', true)
        .order('created_at', { ascending: true });

      if (error) {
        if (error.message?.includes('fetch failed') || error.message?.includes('ECONNRESET')) {
          throw new Error(error.message);
        }
        this.logger.error('Failed to fetch AI models:', error);
        return [];
      }

      return (data as DBModel[]).map(this.toAIModel);
    }, 'getAIModels');
  }

  private toAIModel(db: DBModel): AIModel {
    return {
      id: db.id,
      name: db.name,
      provider: db.provider as AIModel['provider'],
      avatarColor: db.avatar_color,
      initialCapital: Number(db.initial_capital),
      isActive: db.is_active,
      createdAt: db.created_at,
    };
  }

  // ========== Cash Balances ==========

  async getCurrencyBalances(modelId: string): Promise<CurrencyBalances> {
    return this.withRetry(async () => {
      const { data, error } = await this.supabase
        .from('ai_cash_balances')
        .select('krw_balance, usd_balance')
        .eq('model_id', modelId)
        .single();

      if (error) {
        if (error.message?.includes('fetch failed') || error.message?.includes('ECONNRESET')) {
          throw new Error(error.message);
        }
        this.logger.error('Failed to fetch currency balances:', error);
        return { krwBalance: 0, usdBalance: 0 };
      }

      const row = data as DBCashBalance;
      return {
        krwBalance: Number(row.krw_balance),
        usdBalance: Number(row.usd_balance),
      };
    }, 'getCurrencyBalances');
  }

  async updateCashBalance(
    modelId: string,
    krwBalance: number,
    usdBalance: number,
  ): Promise<boolean> {
    const { error } = await this.supabase
      .from('ai_cash_balances')
      .update({
        krw_balance: krwBalance,
        usd_balance: usdBalance,
        updated_at: new Date().toISOString(),
      })
      .eq('model_id', modelId);

    if (error) {
      this.logger.error('Failed to update cash balance:', error);
      return false;
    }
    return true;
  }

  // ========== Exchange ==========

  async recordExchange(
    modelId: string,
    exchangeType: 'KRW_TO_USD' | 'USD_TO_KRW',
    krwAmount: number,
    usdAmount: number,
    exchangeRate: number,
    reasoning?: string,
  ): Promise<boolean> {
    const { error } = await this.supabase.from('ai_exchange_history').insert({
      model_id: modelId,
      exchange_type: exchangeType,
      krw_amount: krwAmount,
      usd_amount: usdAmount,
      exchange_rate: exchangeRate,
      reasoning,
    });

    if (error) {
      this.logger.error('Failed to record exchange:', error);
      return false;
    }
    return true;
  }

  // ========== Holdings ==========

  async getHoldings(modelId: string): Promise<AIHolding[]> {
    return this.withRetry(async () => {
      const { data, error } = await this.supabase
        .from('ai_portfolios')
        .select('*')
        .eq('model_id', modelId)
        .order('updated_at', { ascending: false });

      if (error) {
        // 네트워크 오류인 경우 throw하여 재시도 유도
        if (error.message?.includes('fetch failed') || error.message?.includes('ECONNRESET')) {
          throw new Error(error.message);
        }
        this.logger.error('Failed to fetch holdings:', error);
        return [];
      }

      return (data as DBPortfolio[]).map(this.toAIHolding);
    }, 'getHoldings');
  }

  private toAIHolding(db: DBPortfolio): AIHolding {
    const currentPrice = db.current_price ? Number(db.current_price) : undefined;
    const avgPrice = Number(db.avg_price);
    const shares = Number(db.shares);
    const totalValue = currentPrice ? currentPrice * shares : avgPrice * shares;
    const returnRate = currentPrice
      ? ((currentPrice - avgPrice) / avgPrice) * 100
      : 0;

    return {
      id: db.id,
      modelId: db.model_id,
      ticker: db.ticker,
      stockName: db.stock_name ?? undefined,
      market: db.market as Market,
      shares,
      avgPrice,
      currentPrice,
      totalValue,
      returnRate,
      updatedAt: db.updated_at,
    };
  }

  async getHoldingByTicker(
    modelId: string,
    ticker: string,
    market: Market,
  ): Promise<DBPortfolio | null> {
    const { data, error } = await this.supabase
      .from('ai_portfolios')
      .select('*')
      .eq('model_id', modelId)
      .eq('ticker', ticker)
      .eq('market', market)
      .single();

    if (error) {
      return null;
    }
    return data as DBPortfolio;
  }

  async insertHolding(
    modelId: string,
    ticker: string,
    market: Market,
    shares: number,
    price: number,
  ): Promise<boolean> {
    const { error } = await this.supabase.from('ai_portfolios').insert({
      model_id: modelId,
      ticker,
      market,
      shares,
      avg_price: price,
      current_price: price,
    });

    if (error) {
      this.logger.error('Failed to insert holding:', error);
      return false;
    }
    return true;
  }

  async updateHolding(
    id: string,
    updates: {
      shares?: number;
      avgPrice?: number;
      currentPrice?: number;
    },
  ): Promise<boolean> {
    const updateData: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (updates.shares !== undefined) updateData.shares = updates.shares;
    if (updates.avgPrice !== undefined) updateData.avg_price = updates.avgPrice;
    if (updates.currentPrice !== undefined)
      updateData.current_price = updates.currentPrice;

    const { error } = await this.supabase
      .from('ai_portfolios')
      .update(updateData)
      .eq('id', id);

    if (error) {
      this.logger.error('Failed to update holding:', error);
      return false;
    }
    return true;
  }

  async deleteHolding(id: string): Promise<boolean> {
    const { error } = await this.supabase
      .from('ai_portfolios')
      .delete()
      .eq('id', id);

    if (error) {
      this.logger.error('Failed to delete holding:', error);
      return false;
    }
    return true;
  }

  /**
   * 모든 AI 모델의 보유 종목 조회 (시세 업데이트용)
   */
  async getAllHoldings(): Promise<
    Array<{ id: string; ticker: string; market: Market }>
  > {
    return this.withRetry(async () => {
      const { data, error } = await this.supabase
        .from('ai_portfolios')
        .select('id, ticker, market');

      if (error) {
        if (error.message?.includes('fetch failed') || error.message?.includes('ECONNRESET')) {
          throw new Error(error.message);
        }
        this.logger.error('Failed to fetch all holdings:', error);
        return [];
      }

      return data.map((h) => ({
        id: h.id,
        ticker: h.ticker,
        market: h.market as Market,
      }));
    }, 'getAllHoldings');
  }

  /**
   * 보유 종목의 현재가만 업데이트
   */
  async updateHoldingCurrentPrice(
    id: string,
    currentPrice: number,
  ): Promise<boolean> {
    const { error } = await this.supabase
      .from('ai_portfolios')
      .update({
        current_price: currentPrice,
        updated_at: new Date().toISOString(),
      })
      .eq('id', id);

    if (error) {
      this.logger.error('Failed to update holding current price:', error);
      return false;
    }
    return true;
  }

  // ========== Trades ==========

  async recordTrade(request: ExecuteTradeRequest): Promise<AITrade | null> {
    const { modelId, ticker, stockName, market, tradeType, shares, price, reasoning, scenario } = request;
    const totalAmount = shares * price;

    const { data, error } = await this.supabase
      .from('ai_trades')
      .insert({
        model_id: modelId,
        ticker,
        stock_name: stockName,
        market,
        trade_type: tradeType,
        shares,
        price,
        total_amount: totalAmount,
        reasoning,
        scenario,
      })
      .select('*, ai_models!inner(name, avatar_color)')
      .single();

    if (error) {
      this.logger.error('Failed to record trade:', error);
      return null;
    }

    const row = data as DBTrade & {
      ai_models: { name: string; avatar_color: string };
    };
    return this.toAITrade(row, row.ai_models.name, row.ai_models.avatar_color);
  }

  private toAITrade(
    db: DBTrade,
    modelName?: string,
    modelColor?: string,
  ): AITrade {
    return {
      id: db.id,
      modelId: db.model_id,
      modelName,
      modelColor,
      ticker: db.ticker,
      stockName: db.stock_name ?? undefined,
      market: db.market as Market,
      tradeType: db.trade_type as 'BUY' | 'SELL',
      shares: Number(db.shares),
      price: Number(db.price),
      totalAmount: Number(db.total_amount),
      reasoning: db.reasoning ?? undefined,
      scenario: db.scenario ?? undefined,
      createdAt: db.created_at,
    };
  }

  async hasTradedToday(modelId: string, market: Market): Promise<boolean> {
    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await this.supabase
      .from('ai_trades')
      .select('id')
      .eq('model_id', modelId)
      .eq('market', market)
      .gte('created_at', `${today}T00:00:00`)
      .limit(1);

    if (error) {
      this.logger.error('Failed to check today trades:', error);
      return false;
    }

    return data && data.length > 0;
  }

  async recordHoldScenario(
    modelId: string,
    market: Market,
    reasoning: string,
  ): Promise<void> {
    await this.supabase.from('ai_trade_scenarios').insert({
      model_id: modelId,
      market,
      action: 'HOLD',
      reasoning,
      created_at: new Date().toISOString(),
    });
  }

  async getRecentTradesByModel(
    modelId: string,
    hours: number = 24,
  ): Promise<DBTrade[]> {
    const startDate = new Date();
    startDate.setHours(startDate.getHours() - hours);

    const { data, error } = await this.supabase
      .from('ai_trades')
      .select('*')
      .eq('model_id', modelId)
      .gte('created_at', startDate.toISOString())
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error('Failed to fetch recent trades:', error);
      return [];
    }

    return data as DBTrade[];
  }

  // ========== Portfolio History ==========

  async recordPortfolioValue(
    modelId: string,
    totalValue: number,
  ): Promise<boolean> {
    if (!this.supabase) {
      this.logger.error('Supabase client not initialized - cannot record portfolio value');
      return false;
    }

    const { data, error } = await this.supabase.from('ai_portfolio_history').insert({
      model_id: modelId,
      total_value: totalValue,
    }).select('id, recorded_at');

    if (error) {
      this.logger.error(`Failed to record portfolio value for ${modelId}:`, error);
      return false;
    }

    this.logger.debug(`📊 Portfolio recorded: ${modelId} = ₩${totalValue.toLocaleString()} at ${data?.[0]?.recorded_at}`);
    return true;
  }

  async getPortfolioHistory(
    days: number = 30,
  ): Promise<{ modelId: string; totalValue: number; recordedAt: string }[]> {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const { data, error } = await this.supabase
      .from('ai_portfolio_history')
      .select('model_id, total_value, recorded_at')
      .gte('recorded_at', startDate.toISOString())
      .order('recorded_at', { ascending: true });

    if (error) {
      this.logger.error('Failed to fetch portfolio history:', error);
      return [];
    }

    return (data as DBPortfolioHistory[]).map((row) => ({
      modelId: row.model_id,
      totalValue: Number(row.total_value),
      recordedAt: row.recorded_at,
    }));
  }

  /**
   * 전체 거래 기록 조회 (마이그레이션용)
   */
  async getAllTrades(): Promise<DBTrade[]> {
    if (!this.supabase) {
      this.logger.error('Supabase client not initialized');
      return [];
    }

    const { data, error } = await this.supabase
      .from('ai_trades')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) {
      this.logger.error('Failed to fetch all trades:', error);
      return [];
    }

    return data as DBTrade[];
  }

  /**
   * 특정 날짜의 포트폴리오 히스토리 존재 여부 확인
   */
  async hasPortfolioHistoryForDate(modelId: string, date: string): Promise<boolean> {
    if (!this.supabase) return false;

    const startOfDay = `${date}T00:00:00.000Z`;
    const endOfDay = `${date}T23:59:59.999Z`;

    const { data, error } = await this.supabase
      .from('ai_portfolio_history')
      .select('id')
      .eq('model_id', modelId)
      .gte('recorded_at', startOfDay)
      .lte('recorded_at', endOfDay)
      .limit(1);

    if (error) {
      this.logger.error('Failed to check portfolio history:', error);
      return false;
    }

    return data && data.length > 0;
  }

  /**
   * 특정 시간에 포트폴리오 가치 기록 (마이그레이션용)
   */
  async recordPortfolioValueAt(
    modelId: string,
    totalValue: number,
    recordedAt: string,
  ): Promise<boolean> {
    if (!this.supabase) {
      this.logger.error('Supabase client not initialized');
      return false;
    }

    const { error } = await this.supabase.from('ai_portfolio_history').insert({
      model_id: modelId,
      total_value: totalValue,
      recorded_at: recordedAt,
    });

    if (error) {
      this.logger.error(`Failed to record portfolio value at ${recordedAt}:`, error);
      return false;
    }

    return true;
  }

  /**
   * 가장 오래된 포트폴리오 히스토리 날짜 조회
   */
  async getEarliestPortfolioHistoryDate(): Promise<string | null> {
    if (!this.supabase) return null;

    const { data, error } = await this.supabase
      .from('ai_portfolio_history')
      .select('recorded_at')
      .order('recorded_at', { ascending: true })
      .limit(1);

    if (error || !data || data.length === 0) {
      return null;
    }

    return data[0].recorded_at.split('T')[0];
  }
}
