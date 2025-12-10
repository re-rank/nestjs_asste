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

  constructor(private configService: ConfigService) {}

  onModuleInit() {
    const url = this.configService.get<string>('supabase.url');
    const key = this.configService.get<string>('supabase.serviceRoleKey');

    if (!url || !key) {
      this.logger.warn('Supabase credentials not configured');
      return;
    }

    this.supabase = createClient(url, key);
    this.logger.log('Supabase client initialized');
  }

  getClient(): SupabaseClient {
    return this.supabase;
  }

  // ========== AI Models ==========

  async getAIModels(): Promise<AIModel[]> {
    const { data, error } = await this.supabase
      .from('ai_models')
      .select('*')
      .eq('is_active', true)
      .order('created_at', { ascending: true });

    if (error) {
      this.logger.error('Failed to fetch AI models:', error);
      return [];
    }

    return (data as DBModel[]).map(this.toAIModel);
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
    const { data, error } = await this.supabase
      .from('ai_cash_balances')
      .select('krw_balance, usd_balance')
      .eq('model_id', modelId)
      .single();

    if (error) {
      this.logger.error('Failed to fetch currency balances:', error);
      return { krwBalance: 0, usdBalance: 0 };
    }

    const row = data as DBCashBalance;
    return {
      krwBalance: Number(row.krw_balance),
      usdBalance: Number(row.usd_balance),
    };
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
    const { data, error } = await this.supabase
      .from('ai_portfolios')
      .select('*')
      .eq('model_id', modelId)
      .order('updated_at', { ascending: false });

    if (error) {
      this.logger.error('Failed to fetch holdings:', error);
      return [];
    }

    return (data as DBPortfolio[]).map(this.toAIHolding);
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

  // ========== Portfolio History ==========

  async recordPortfolioValue(
    modelId: string,
    totalValue: number,
  ): Promise<void> {
    const { error } = await this.supabase.from('ai_portfolio_history').insert({
      model_id: modelId,
      total_value: totalValue,
    });

    if (error) {
      this.logger.error('Failed to record portfolio value:', error);
    }
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
}
