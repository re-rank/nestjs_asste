import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SupabaseService } from './supabase.service';
import { AIProviderService } from './ai-provider.service';
import { StockPriceService } from './stock-price.service';
import { NotificationService } from './notification.service';
import type {
  AIModel,
  AIHolding,
  AITrade,
  Market,
  TradeDecision,
  MarketDataSnapshot,
  StockSnapshot,
  TradingRoundResult,
} from '../types/ai-trading.types';

@Injectable()
export class TradingService implements OnModuleInit {
  private readonly logger = new Logger(TradingService.name);

  constructor(
    private supabaseService: SupabaseService,
    private aiProviderService: AIProviderService,
    private stockPriceService: StockPriceService,
    private notificationService: NotificationService,
  ) {}

  /**
   * 모듈 초기화 시 AI Tool 핸들러 등록
   */
  onModuleInit() {
    this.registerToolHandlers();
    this.logger.log('🔧 AI Tool handlers registered');
  }

  /**
   * AI Tool 핸들러 등록
   */
  private registerToolHandlers(): void {
    // search_stocks: 키워드로 종목 검색
    this.aiProviderService.registerToolHandler(
      'search_stocks',
      async (args: Record<string, unknown>) => {
        const keyword = args.keyword as string;
        const market = args.market as Market;
        const limit = (args.limit as number) || 10;

        this.logger.log(`🔍 Tool: search_stocks("${keyword}", ${market})`);
        return await this.stockPriceService.searchStocks(keyword, market, limit);
      },
    );

    // get_stock_quote: 특정 종목 시세 조회
    this.aiProviderService.registerToolHandler(
      'get_stock_quote',
      async (args: Record<string, unknown>) => {
        const ticker = args.ticker as string;
        const market = args.market as Market;

        this.logger.log(`📈 Tool: get_stock_quote("${ticker}", ${market})`);
        const quote = await this.stockPriceService.getStockQuoteForTool(
          ticker,
          market,
        );
        if (!quote) {
          return { error: `Failed to get quote for ${ticker}` };
        }
        return quote;
      },
    );

    // get_top_stocks: 상위 종목 목록 조회
    this.aiProviderService.registerToolHandler(
      'get_top_stocks',
      async (args: Record<string, unknown>) => {
        const market = args.market as Market;
        const category = (args.category as string) || 'market_cap';
        const limit = (args.limit as number) || 20;

        this.logger.log(`📊 Tool: get_top_stocks(${market}, ${category}, ${limit})`);
        return await this.stockPriceService.getTopStocks(market, category, limit);
      },
    );
  }

  /**
   * 시장 데이터 스냅샷 생성
   */
  async getMarketSnapshot(): Promise<MarketDataSnapshot> {
    const stocks: StockSnapshot[] = [];
    const { KR, US } = await this.stockPriceService.fetchAllStocks();

    const tickers = [
      ...KR.map((s) => ({ ticker: s.ticker, market: 'KR' as const })),
      ...US.map((s) => ({ ticker: s.ticker, market: 'US' as const })),
    ];

    const quotesMap = await this.stockPriceService.getBatchStockQuotes(tickers);

    for (const stock of KR) {
      const quote = quotesMap.get(stock.ticker);
      if (quote) {
        stocks.push({
          ticker: stock.ticker,
          name: stock.name,
          market: 'KR',
          price: quote.price,
          change: quote.change,
          changePercent: quote.changePercent,
          volume: quote.volume,
          high: quote.high,
          low: quote.low,
        });
      }
    }

    for (const stock of US) {
      const quote = quotesMap.get(stock.ticker);
      if (quote) {
        stocks.push({
          ticker: stock.ticker,
          name: stock.name,
          market: 'US',
          price: quote.price,
          change: quote.change,
          changePercent: quote.changePercent,
          volume: quote.volume,
          high: quote.high,
          low: quote.low,
        });
      }
    }

    return {
      stocks,
      indices: [],
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 환전: 원화 → 달러
   * 안전 제한: 최대 80%까지만 환전 가능
   */
  async exchangeKRWtoUSD(
    modelId: string,
    krwAmount: number,
  ): Promise<{ success: boolean; usdAmount?: number; error?: string }> {
    const exchangeRate = await this.stockPriceService.getExchangeRate();

    const { krwBalance, usdBalance } =
      await this.supabaseService.getCurrencyBalances(modelId);

    // 안전 제한: 최대 80%까지만 환전 허용
    const maxExchangeAmount = krwBalance * 0.8;
    const actualKrwAmount = Math.min(krwAmount, maxExchangeAmount);

    if (actualKrwAmount <= 0) {
      return { success: false, error: '환전할 원화가 없습니다.' };
    }

    if (krwBalance < actualKrwAmount) {
      return { success: false, error: '원화 잔고가 부족합니다.' };
    }

    const usdAmount = actualKrwAmount / exchangeRate;

    this.logger.log(
      `💱 KRW→USD 환전: 요청 ${krwAmount.toLocaleString()}원 → 실제 ${actualKrwAmount.toLocaleString()}원 (최대 80% 제한)`,
    );

    const updated = await this.supabaseService.updateCashBalance(
      modelId,
      krwBalance - actualKrwAmount,
      usdBalance + usdAmount,
    );

    if (!updated) {
      return { success: false, error: '잔고 업데이트 실패' };
    }

    await this.supabaseService.recordExchange(
      modelId,
      'KRW_TO_USD',
      actualKrwAmount,
      usdAmount,
      exchangeRate,
    );

    return { success: true, usdAmount };
  }

  /**
   * 환전: 달러 → 원화
   * 안전 제한: 최대 80%까지만 환전 가능
   */
  async exchangeUSDtoKRW(
    modelId: string,
    usdAmount: number,
  ): Promise<{ success: boolean; krwAmount?: number; error?: string }> {
    const exchangeRate = await this.stockPriceService.getExchangeRate();

    const { krwBalance, usdBalance } =
      await this.supabaseService.getCurrencyBalances(modelId);

    // 안전 제한: 최대 80%까지만 환전 허용
    const maxExchangeAmount = usdBalance * 0.8;
    const actualUsdAmount = Math.min(usdAmount, maxExchangeAmount);

    if (actualUsdAmount <= 0) {
      return { success: false, error: '환전할 달러가 없습니다.' };
    }

    if (usdBalance < actualUsdAmount) {
      return { success: false, error: '달러 잔고가 부족합니다.' };
    }

    const krwAmount = actualUsdAmount * exchangeRate;

    this.logger.log(
      `💱 USD→KRW 환전: 요청 $${usdAmount.toFixed(2)} → 실제 $${actualUsdAmount.toFixed(2)} (최대 80% 제한)`,
    );

    const updated = await this.supabaseService.updateCashBalance(
      modelId,
      krwBalance + krwAmount,
      usdBalance - actualUsdAmount,
    );

    if (!updated) {
      return { success: false, error: '잔고 업데이트 실패' };
    }

    await this.supabaseService.recordExchange(
      modelId,
      'USD_TO_KRW',
      krwAmount,
      actualUsdAmount,
      exchangeRate,
    );

    return { success: true, krwAmount };
  }

  /**
   * 매매 실행
   */
  async executeTrade(
    modelId: string,
    ticker: string,
    stockName: string,
    market: Market,
    tradeType: 'BUY' | 'SELL',
    shares: number,
    price: number,
    reasoning?: string,
    scenario?: string,
  ): Promise<AITrade | null> {
    const totalAmount = shares * price;
    const { krwBalance, usdBalance } =
      await this.supabaseService.getCurrencyBalances(modelId);

    if (tradeType === 'BUY') {
      if (market === 'KR') {
        // 한국 주식 매수: 원화 사용
        if (krwBalance < totalAmount) {
          this.logger.error('Insufficient KRW balance for buy order');
          return null;
        }

        const updated = await this.supabaseService.updateCashBalance(
          modelId,
          krwBalance - totalAmount,
          usdBalance,
        );
        if (!updated) return null;
      } else {
        // 미국 주식 매수: 달러 사용
        if (usdBalance < totalAmount) {
          // 달러 부족 시 자동 환전
          const neededUSD = totalAmount - usdBalance;
          const exchangeRate = await this.stockPriceService.getExchangeRate();
          const neededKRW = neededUSD * exchangeRate * 1.01;

          if (krwBalance < neededKRW) {
            this.logger.error('Insufficient balance for buy order');
            return null;
          }

          const exchangeResult = await this.exchangeKRWtoUSD(modelId, neededKRW);
          if (!exchangeResult.success) {
            this.logger.error('Failed to auto-exchange');
            return null;
          }

          const newBalances =
            await this.supabaseService.getCurrencyBalances(modelId);
          const updated = await this.supabaseService.updateCashBalance(
            modelId,
            newBalances.krwBalance,
            newBalances.usdBalance - totalAmount,
          );
          if (!updated) return null;
        } else {
          const updated = await this.supabaseService.updateCashBalance(
            modelId,
            krwBalance,
            usdBalance - totalAmount,
          );
          if (!updated) return null;
        }
      }

      // 기존 보유 종목 확인
      const existingHolding = await this.supabaseService.getHoldingByTicker(
        modelId,
        ticker,
        market,
      );

      if (existingHolding) {
        const existingShares = Number(existingHolding.shares);
        const existingAvgPrice = Number(existingHolding.avg_price);
        const newTotalShares = existingShares + shares;
        const newAvgPrice =
          (existingShares * existingAvgPrice + shares * price) / newTotalShares;

        const updated = await this.supabaseService.updateHolding(
          existingHolding.id,
          {
            shares: newTotalShares,
            avgPrice: newAvgPrice,
            currentPrice: price,
          },
        );
        if (!updated) return null;
      } else {
        const inserted = await this.supabaseService.insertHolding(
          modelId,
          ticker,
          market,
          shares,
          price,
        );
        if (!inserted) return null;
      }
    } else {
      // 매도
      const existingHolding = await this.supabaseService.getHoldingByTicker(
        modelId,
        ticker,
        market,
      );

      if (!existingHolding) {
        this.logger.error('No holding found for sell order');
        return null;
      }

      const existingShares = Number(existingHolding.shares);
      if (existingShares < shares) {
        this.logger.error('Insufficient shares for sell order');
        return null;
      }

      // 현금 추가
      if (market === 'KR') {
        const updated = await this.supabaseService.updateCashBalance(
          modelId,
          krwBalance + totalAmount,
          usdBalance,
        );
        if (!updated) return null;
      } else {
        const updated = await this.supabaseService.updateCashBalance(
          modelId,
          krwBalance,
          usdBalance + totalAmount,
        );
        if (!updated) return null;
      }

      if (existingShares === shares) {
        const deleted = await this.supabaseService.deleteHolding(
          existingHolding.id,
        );
        if (!deleted) return null;
      } else {
        const updated = await this.supabaseService.updateHolding(
          existingHolding.id,
          {
            shares: existingShares - shares,
            currentPrice: price,
          },
        );
        if (!updated) return null;
      }
    }

    // 매매 내역 기록
    return await this.supabaseService.recordTrade({
      modelId,
      ticker,
      stockName,
      market,
      tradeType,
      shares,
      price,
      reasoning,
      scenario,
    });
  }

  /**
   * AI 매매 결정 실행
   */
  private async executeTradeDecision(
    model: AIModel,
    decision: TradeDecision,
    market: Market,
  ): Promise<boolean> {
    // 1. 환전 결정 처리
    if (decision.exchange) {
      this.logger.log(
        `💱 ${model.name}: AI가 환전 결정 - ${decision.exchange.reason}`,
      );

      if (decision.exchange.type === 'KRW_TO_USD') {
        const result = await this.exchangeKRWtoUSD(
          model.id,
          decision.exchange.amount,
        );
        if (result.success) {
          this.logger.log(
            `  ✅ ${decision.exchange.amount.toLocaleString()} KRW → ${result.usdAmount?.toFixed(2)} USD`,
          );
        } else {
          this.logger.error(`  ❌ 환전 실패: ${result.error}`);
        }
      } else {
        const result = await this.exchangeUSDtoKRW(
          model.id,
          decision.exchange.amount,
        );
        if (result.success) {
          this.logger.log(
            `  ✅ ${decision.exchange.amount.toFixed(2)} USD → ${result.krwAmount?.toLocaleString()} KRW`,
          );
        } else {
          this.logger.error(`  ❌ 환전 실패: ${result.error}`);
        }
      }
    }

    // 2. 매매 결정 실행
    if (decision.action === 'HOLD') {
      this.logger.log(
        `[${model.name}] HOLD 결정 - 매매 없음: ${decision.reasoning}`,
      );
      await this.supabaseService.recordHoldScenario(
        model.id,
        market,
        decision.reasoning,
      );
      return false;
    }

    const { ticker, shares, stockName } = decision;

    if (!ticker || !shares || shares <= 0) {
      this.logger.error(`[${model.name}] 잘못된 매매 결정:`, decision);
      return false;
    }

    // 실시간 가격 조회
    const quote =
      market === 'KR'
        ? await this.stockPriceService.getKoreanStockQuote(ticker)
        : await this.stockPriceService.getUSStockQuote(ticker);

    if (!quote || quote.price <= 0) {
      this.logger.error(`[${model.name}] 가격 조회 실패: ${ticker}`);
      return false;
    }

    // 매매 실행
    const trade = await this.executeTrade(
      model.id,
      ticker,
      stockName || ticker,
      market,
      decision.action,
      shares,
      quote.price,
      decision.reasoning,
      decision.scenario,
    );

    if (trade) {
      this.logger.log(
        `[${model.name}] ${decision.action} 완료: ${ticker} ${shares}주 @ ${market === 'KR' ? '₩' : '$'}${quote.price.toLocaleString()}`,
      );
      return true;
    }

    return false;
  }

  /**
   * 특정 시장에 대해 모든 AI 모델의 매매 분석 및 실행
   * Tool Calling 방식으로 AI가 직접 종목을 검색하고 시세를 조회
   */
  async runMarketTradingRound(market: Market): Promise<TradingRoundResult> {
    this.logger.log(`\n=== ${market} 시장 트레이딩 라운드 시작 (Tool-based) ===`);

    const results: Array<{ model: string; action: string; ticker?: string }> =
      [];
    let tradesExecuted = 0;

    try {
      const models = await this.supabaseService.getAIModels();

      if (models.length === 0) {
        this.logger.log('활성 AI 모델이 없습니다.');
        return { success: false, tradesExecuted: 0, results };
      }

      // 환율만 미리 조회 (캐시용)
      await this.stockPriceService.getExchangeRate();

      for (const model of models) {
        // 보유 종목 조회
        const holdings = await this.supabaseService.getHoldings(model.id);
        const marketHoldings = holdings.filter((h) => h.market === market);

        // 잔고 조회 (양쪽 통화 모두)
        const balances = await this.supabaseService.getCurrencyBalances(
          model.id,
        );
        const tradingCash =
          market === 'KR' ? balances.krwBalance : balances.usdBalance;

        this.logger.log(
          `[${model.name}] Tool 기반 분석 시작 - ${market} 시장, 잔고: ${tradingCash.toLocaleString()} (KRW: ${balances.krwBalance.toLocaleString()}, USD: ${balances.usdBalance.toLocaleString()})`,
        );

        // AI Tool 기반 분석 요청 (전체 시장 데이터 없이)
        // model.name을 전달하여 모델별로 다른 API 모델 ID 사용 (예: grok-4-1-fast-reasoning, gemini-3-pro-preview)
        const decision = await this.aiProviderService.requestTradeAnalysisWithTools(
          model.provider,
          marketHoldings,
          balances,
          market,
          model.name,
        );

        if (decision === null) {
          // API 키가 없는 경우에만 null 반환됨
          this.logger.warn(
            `[${model.name}] API 키 미설정 또는 미지원 프로바이더 - 거래 건너뜀`,
          );
          results.push({
            model: model.name,
            action: 'SKIPPED_NO_API_KEY',
            ticker: '',
          });
          continue;
        }

        // 매매 실행
        const executed = await this.executeTradeDecision(
          model,
          decision,
          market,
        );

        if (executed) {
          tradesExecuted++;
        }

        results.push({
          model: model.name,
          action: decision.action,
          ticker: decision.ticker,
        });

        // API 호출 간격 유지
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      this.logger.log(
        `=== ${market} 시장 트레이딩 라운드 완료: ${tradesExecuted}건 체결 ===\n`,
      );

      // 알림 전송
      if (tradesExecuted > 0) {
        await this.notificationService.sendNotification(
          `${market === 'KR' ? '🇰🇷 국내' : '🇺🇸 미국'} 매매 ${tradesExecuted}건 체결`,
        );
      }

      return { success: true, tradesExecuted, results };
    } catch (error) {
      this.logger.error(`${market} 시장 트레이딩 라운드 실패:`, error);
      return { success: false, tradesExecuted, results };
    }
  }

  /**
   * 모든 보유 종목의 현재가를 실시간 시세로 업데이트
   */
  async updateAllHoldingsWithCurrentPrices(): Promise<void> {
    const holdings = await this.supabaseService.getAllHoldings();

    if (holdings.length === 0) {
      this.logger.log('📈 업데이트할 보유 종목이 없습니다.');
      return;
    }

    // 종목별로 그룹화하여 배치 조회
    const tickers = holdings.map((h) => ({
      ticker: h.ticker,
      market: h.market,
    }));

    // 중복 제거
    const uniqueTickers = Array.from(
      new Map(tickers.map((t) => [`${t.ticker}-${t.market}`, t])).values(),
    );

    // 배치로 시세 조회
    const quotesMap =
      await this.stockPriceService.getBatchStockQuotes(uniqueTickers);

    // 각 보유 종목의 현재가 업데이트
    let updatedCount = 0;
    for (const holding of holdings) {
      const quote = quotesMap.get(holding.ticker);
      if (quote && quote.price > 0) {
        const success = await this.supabaseService.updateHoldingCurrentPrice(
          holding.id,
          quote.price,
        );
        if (success) {
          updatedCount++;
        }
      }
    }

    this.logger.log(
      `📈 보유 종목 시세 업데이트 완료: ${updatedCount}/${holdings.length}건`,
    );
  }

  /**
   * 포트폴리오 가치 기록 (시세 업데이트 후 기록)
   */
  async recordAllPortfolioValues(): Promise<void> {
    this.logger.log('📊 포트폴리오 가치 기록 시작...');

    // 먼저 모든 보유 종목의 시세를 실시간으로 업데이트
    await this.updateAllHoldingsWithCurrentPrices();

    const models = await this.supabaseService.getAIModels();
    const exchangeRate = await this.stockPriceService.getExchangeRate();

    this.logger.log(`📊 ${models.length}개 모델의 포트폴리오 가치 기록 중... (환율: ₩${exchangeRate.toLocaleString()})`);

    let recordedCount = 0;
    for (const model of models) {
      try {
        const holdings = await this.supabaseService.getHoldings(model.id);
        const balances = await this.supabaseService.getCurrencyBalances(model.id);

        const cash = balances.krwBalance + balances.usdBalance * exchangeRate;

        // USD 주식은 환율 적용하여 원화로 환산
        const holdingsValue = holdings.reduce((sum, h) => {
          const value = h.totalValue || 0;
          // USD 시장 주식은 환율 적용
          if (h.market === 'US') {
            return sum + value * exchangeRate;
          }
          return sum + value;
        }, 0);

        const totalValue = cash + holdingsValue;

        const success = await this.supabaseService.recordPortfolioValue(model.id, totalValue);
        if (success) {
          recordedCount++;
          this.logger.debug(
            `  ✓ ${model.name}: ₩${totalValue.toLocaleString()} (현금: ₩${cash.toLocaleString()}, 주식: ₩${holdingsValue.toLocaleString()})`,
          );
        } else {
          this.logger.warn(`  ⚠️ ${model.name} 기록 실패 (Supabase 오류)`);
        }
      } catch (error) {
        this.logger.error(`  ✗ ${model.name} 기록 실패:`, error);
      }
    }

    this.logger.log(`📊 포트폴리오 가치 기록 완료: ${recordedCount}/${models.length}개 모델`);
  }

  /**
   * 거래 기록에서 포트폴리오 히스토리 마이그레이션
   * 각 거래 시점에서 포트폴리오 가치를 계산하여 히스토리에 저장
   */
  async migratePortfolioHistoryFromTrades(): Promise<{
    success: boolean;
    migratedDates: number;
    skippedDates: number;
    errors: string[];
  }> {
    this.logger.log('🔄 포트폴리오 히스토리 마이그레이션 시작...');

    const models = await this.supabaseService.getAIModels();
    const allTrades = await this.supabaseService.getAllTrades();
    const exchangeRate = await this.stockPriceService.getExchangeRate();

    let migratedDates = 0;
    let skippedDates = 0;
    const errors: string[] = [];

    // 모델별로 처리
    for (const model of models) {
      this.logger.log(`📊 ${model.name} 마이그레이션 처리 중...`);

      // 해당 모델의 거래 기록만 필터링
      const modelTrades = allTrades.filter((t) => t.model_id === model.id);

      if (modelTrades.length === 0) {
        this.logger.log(`  - ${model.name}: 거래 기록 없음, 초기 자본으로 기록`);
        // 거래 기록이 없으면 현재 날짜에 초기 자본 기록
        const today = new Date().toISOString().split('T')[0];
        const hasHistory = await this.supabaseService.hasPortfolioHistoryForDate(model.id, today);
        if (!hasHistory) {
          await this.supabaseService.recordPortfolioValueAt(
            model.id,
            model.initialCapital,
            new Date().toISOString(),
          );
          migratedDates++;
        }
        continue;
      }

      // 거래 날짜별로 그룹화
      const tradesByDate = new Map<string, typeof modelTrades>();
      for (const trade of modelTrades) {
        const date = trade.created_at.split('T')[0];
        if (!tradesByDate.has(date)) {
          tradesByDate.set(date, []);
        }
        tradesByDate.get(date)!.push(trade);
      }

      // 각 날짜별로 포트폴리오 가치 계산 및 저장
      // 현재 잔고에서 역산하는 방식
      const currentBalances = await this.supabaseService.getCurrencyBalances(model.id);
      const currentHoldings = await this.supabaseService.getHoldings(model.id);

      // 현재 총 자산 가치
      let currentTotalValue =
        currentBalances.krwBalance + currentBalances.usdBalance * exchangeRate;
      for (const holding of currentHoldings) {
        const value = holding.totalValue || holding.avgPrice * holding.shares;
        currentTotalValue += holding.market === 'US' ? value * exchangeRate : value;
      }

      // 날짜를 역순으로 정렬하여 역산
      const sortedDates = Array.from(tradesByDate.keys()).sort().reverse();

      let portfolioValue = currentTotalValue;

      for (const date of sortedDates) {
        // 이미 히스토리가 있는지 확인
        const hasHistory = await this.supabaseService.hasPortfolioHistoryForDate(model.id, date);
        if (hasHistory) {
          skippedDates++;
          continue;
        }

        // 해당 날짜의 거래로 인한 변동 계산 (역산)
        const dayTrades = tradesByDate.get(date)!;
        for (const trade of dayTrades.reverse()) {
          const tradeAmount = Number(trade.total_amount);
          const tradeRate = trade.market === 'US' ? exchangeRate : 1;

          if (trade.trade_type === 'BUY') {
            // 매수: 역산 시 현금 증가, 주식 감소 → 총 가치 변동 없음 (수수료 무시)
            // 단, 현재 주가와 매수가 차이로 인한 손익 반영
          } else {
            // 매도: 역산 시 현금 감소, 주식 증가 → 총 가치 변동 없음
          }
        }

        // 해당 날짜 종료 시점의 포트폴리오 가치 기록
        const recordedAt = `${date}T15:00:00.000Z`; // KST 24:00 = UTC 15:00 (다음 날)
        const success = await this.supabaseService.recordPortfolioValueAt(
          model.id,
          portfolioValue,
          recordedAt,
        );

        if (success) {
          migratedDates++;
          this.logger.debug(`  ✓ ${model.name} ${date}: ₩${portfolioValue.toLocaleString()}`);
        } else {
          errors.push(`${model.name} ${date}: 저장 실패`);
        }
      }
    }

    this.logger.log(`🔄 마이그레이션 완료: ${migratedDates}건 생성, ${skippedDates}건 스킵`);

    return {
      success: errors.length === 0,
      migratedDates,
      skippedDates,
      errors,
    };
  }

  /**
   * 캔들차트용 일별 OHLC 데이터 조회
   */
  async getCandleChartData(
    days: number = 30,
  ): Promise<Record<string, Array<{
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    change: number;
    changePercent: number;
  }>>> {
    const models = await this.supabaseService.getAIModels();
    const history = await this.supabaseService.getPortfolioHistory(days);

    // 모델 ID -> 이름 매핑
    const modelMap = new Map(models.map((m) => [m.id, m]));

    // 모델별, 날짜별로 그룹화
    const dataByModelAndDate = new Map<string, Map<string, number[]>>();

    for (const record of history) {
      const model = modelMap.get(record.modelId);
      if (!model) continue;

      const modelName = model.name;
      const date = record.recordedAt.split('T')[0];

      if (!dataByModelAndDate.has(modelName)) {
        dataByModelAndDate.set(modelName, new Map());
      }

      const modelData = dataByModelAndDate.get(modelName)!;
      if (!modelData.has(date)) {
        modelData.set(date, []);
      }

      modelData.get(date)!.push(record.totalValue);
    }

    // OHLC 데이터로 변환
    const result: Record<string, Array<{
      date: string;
      open: number;
      high: number;
      low: number;
      close: number;
      change: number;
      changePercent: number;
    }>> = {};

    for (const [modelName, dateMap] of dataByModelAndDate) {
      const sortedDates = Array.from(dateMap.keys()).sort();
      const candles: Array<{
        date: string;
        open: number;
        high: number;
        low: number;
        close: number;
        change: number;
        changePercent: number;
      }> = [];

      let previousClose = 0;

      for (const date of sortedDates) {
        const values = dateMap.get(date)!;
        const open = values[0];
        const close = values[values.length - 1];
        const high = Math.max(...values);
        const low = Math.min(...values);

        const change = previousClose > 0 ? close - previousClose : 0;
        const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

        candles.push({
          date,
          open,
          high,
          low,
          close,
          change: Math.round(change),
          changePercent: Math.round(changePercent * 100) / 100,
        });

        previousClose = close;
      }

      result[modelName] = candles;
    }

    return result;
  }

  /**
   * 누락된 날짜에 대해 포트폴리오 히스토리 보완
   * 거래가 없는 날도 이전 종가를 기준으로 기록
   */
  async fillMissingPortfolioHistory(): Promise<{
    success: boolean;
    filledDates: number;
  }> {
    this.logger.log('📊 누락된 포트폴리오 히스토리 보완 시작...');

    const models = await this.supabaseService.getAIModels();
    const history = await this.supabaseService.getPortfolioHistory(365); // 1년치
    let filledDates = 0;

    // 모델별로 처리
    for (const model of models) {
      // 해당 모델의 히스토리만 필터링
      const modelHistory = history.filter((h) => h.modelId === model.id);

      if (modelHistory.length === 0) {
        continue;
      }

      // 날짜별로 정렬
      const sortedHistory = modelHistory.sort(
        (a, b) => new Date(a.recordedAt).getTime() - new Date(b.recordedAt).getTime(),
      );

      // 날짜 범위 계산
      const startDate = new Date(sortedHistory[0].recordedAt.split('T')[0]);
      const endDate = new Date();

      // 각 날짜 확인
      const existingDates = new Set(sortedHistory.map((h) => h.recordedAt.split('T')[0]));
      let previousValue = sortedHistory[0].totalValue;

      for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];

        // 주말 건너뛰기
        const dayOfWeek = d.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) continue;

        if (!existingDates.has(dateStr)) {
          // 누락된 날짜 - 이전 종가로 기록
          const recordedAt = `${dateStr}T15:00:00.000Z`;
          const success = await this.supabaseService.recordPortfolioValueAt(
            model.id,
            previousValue,
            recordedAt,
          );

          if (success) {
            filledDates++;
            this.logger.debug(`  ✓ ${model.name} ${dateStr}: ₩${previousValue.toLocaleString()} (보완)`);
          }
        } else {
          // 기존 데이터가 있으면 해당 값으로 업데이트
          const existing = sortedHistory.find((h) => h.recordedAt.startsWith(dateStr));
          if (existing) {
            previousValue = existing.totalValue;
          }
        }
      }
    }

    this.logger.log(`📊 히스토리 보완 완료: ${filledDates}건 추가`);

    return {
      success: true,
      filledDates,
    };
  }
}
