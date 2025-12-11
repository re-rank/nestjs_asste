import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  StockQuote,
  StockSearchResult,
  Market,
} from '../types/ai-trading.types';

@Injectable()
export class StockPriceService {
  private readonly logger = new Logger(StockPriceService.name);

  // 환율 캐시
  private cachedExchangeRate: number | null = null;
  private lastExchangeRateFetch = 0;
  private readonly EXCHANGE_RATE_CACHE_DURATION = 60 * 1000; // 1분

  // 종목 캐시
  private cachedStockListKR: StockSearchResult[] = [];
  private cachedStockListUS: StockSearchResult[] = [];
  private lastStockListFetch = 0;
  private readonly STOCK_LIST_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24시간

  // 종목명 캐시 (ticker -> name)
  private stockNameCache: Map<string, string> = new Map();

  constructor(private configService: ConfigService) {
    // 종목명 캐시 초기화
    this.initStockNameCache();
  }

  /**
   * 종목명 캐시 초기화
   */
  private initStockNameCache(): void {
    const krStocks = this.getDefaultKRStocks();
    const usStocks = this.getDefaultUSStocks();

    krStocks.forEach((s) => this.stockNameCache.set(s.ticker, s.name));
    usStocks.forEach((s) => this.stockNameCache.set(s.ticker, s.name));
  }

  /**
   * 종목명 조회 (캐시 우선)
   */
  getStockName(ticker: string): string | undefined {
    return this.stockNameCache.get(ticker);
  }

  private get twelveDataApiKey(): string {
    return this.configService.get<string>('twelveData.apiKey') || '';
  }

  /**
   * 미국주식 시세 조회 (Twelve Data API)
   */
  async getUSStockQuote(ticker: string): Promise<StockQuote | null> {
    try {
      if (!this.twelveDataApiKey) {
        return this.getMockUSStockQuote(ticker);
      }

      const response = await fetch(
        `https://api.twelvedata.com/quote?symbol=${ticker}&apikey=${this.twelveDataApiKey}`,
      );

      if (!response.ok) {
        throw new Error('Twelve Data API failed');
      }

      const data = await response.json();

      if (data.code || !data.close) {
        this.logger.warn(`Twelve Data error: ${data.message || 'No data'}`);
        return this.getMockUSStockQuote(ticker);
      }

      return {
        ticker: data.symbol,
        name: data.name,
        price: parseFloat(data.close),
        change: parseFloat(data.change || '0'),
        changePercent: parseFloat(data.percent_change || '0'),
        previousClose: parseFloat(data.previous_close || '0'),
        open: parseFloat(data.open || '0'),
        high: parseFloat(data.high || '0'),
        low: parseFloat(data.low || '0'),
        volume: parseInt(data.volume || '0'),
        timestamp: new Date().toISOString(),
        currency: 'USD',
        exchange: data.exchange || 'US',
      };
    } catch (error) {
      this.logger.error('US stock quote error:', error);
      return this.getMockUSStockQuote(ticker);
    }
  }

  /**
   * 국내주식 시세 조회 (Twelve Data API 우선, Yahoo Finance 폴백)
   */
  async getKoreanStockQuote(ticker: string): Promise<StockQuote | null> {
    // 1차 시도: Twelve Data API
    if (this.twelveDataApiKey) {
      try {
        const quote = await this.fetchTwelveDataKRQuote(ticker);
        if (quote && quote.price > 0) {
          this.logger.log(`📈 KR 시세 조회 성공 (TwelveData): ${ticker} = ₩${quote.price.toLocaleString()}`);
          return quote;
        }
      } catch {
        // Twelve Data 실패, Yahoo Finance 시도
      }
    }

    // 2차 시도: Yahoo Finance (KOSPI)
    try {
      const quote = await this.fetchYahooFinanceQuote(`${ticker}.KS`, ticker);
      if (quote && quote.price > 0) {
        this.logger.log(`📈 KR 시세 조회 성공 (Yahoo/KOSPI): ${ticker} = ₩${quote.price.toLocaleString()}`);
        return quote;
      }
    } catch {
      // KOSPI 실패
    }

    // 3차 시도: Yahoo Finance (KOSDAQ)
    try {
      const quote = await this.fetchYahooFinanceQuote(`${ticker}.KQ`, ticker);
      if (quote && quote.price > 0) {
        this.logger.log(`📈 KR 시세 조회 성공 (Yahoo/KOSDAQ): ${ticker} = ₩${quote.price.toLocaleString()}`);
        return quote;
      }
    } catch {
      // KOSDAQ도 실패
    }

    // 실패 시 모의 데이터 사용
    this.logger.warn(`📉 KR 시세 조회 실패, Mock 데이터 사용: ${ticker}`);
    return this.getMockKoreanStockQuote(ticker);
  }

  /**
   * Twelve Data API로 한국 주식 시세 조회
   */
  private async fetchTwelveDataKRQuote(ticker: string): Promise<StockQuote | null> {
    const response = await fetch(
      `https://api.twelvedata.com/quote?symbol=${ticker}&apikey=${this.twelveDataApiKey}`,
    );

    if (!response.ok) {
      throw new Error(`Twelve Data KR API error: ${response.status}`);
    }

    const data = await response.json();

    if (data.code || !data.close) {
      throw new Error(data.message || 'No data');
    }

    const stockName = this.stockNameCache.get(ticker) || data.name || ticker;

    return {
      ticker,
      name: stockName,
      price: Math.round(parseFloat(data.close)),
      change: Math.round(parseFloat(data.change || '0')),
      changePercent: parseFloat(data.percent_change || '0'),
      previousClose: Math.round(parseFloat(data.previous_close || '0')),
      open: data.open ? Math.round(parseFloat(data.open)) : undefined,
      high: data.high ? Math.round(parseFloat(data.high)) : undefined,
      low: data.low ? Math.round(parseFloat(data.low)) : undefined,
      volume: parseInt(data.volume || '0'),
      timestamp: new Date().toISOString(),
      currency: 'KRW',
      exchange: data.exchange || 'KRX',
    };
  }

  /**
   * Yahoo Finance API로 시세 조회
   */
  private async fetchYahooFinanceQuote(
    yahooTicker: string,
    originalTicker: string,
  ): Promise<StockQuote | null> {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?interval=1d&range=1d`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    if (!response.ok) {
      throw new Error(`Yahoo Finance API error: ${response.status}`);
    }

    const data = await response.json();
    const result = data?.chart?.result?.[0];

    if (!result || !result.meta) {
      throw new Error('Invalid Yahoo Finance response');
    }

    const meta = result.meta;
    const quote = result.indicators?.quote?.[0];

    // 현재가 (regularMarketPrice가 가장 정확)
    const price = meta.regularMarketPrice || meta.previousClose || 0;
    const previousClose = meta.previousClose || meta.chartPreviousClose || price;
    const change = price - previousClose;
    const changePercent = previousClose > 0 ? (change / previousClose) * 100 : 0;

    // 종목명: 캐시 → Yahoo API → ticker
    const cachedName = this.stockNameCache.get(originalTicker);
    const stockName = cachedName || meta.longName || meta.shortName || originalTicker;

    return {
      ticker: originalTicker,
      name: stockName,
      price: Math.round(price),
      change: Math.round(change),
      changePercent: Math.round(changePercent * 100) / 100,
      previousClose: Math.round(previousClose),
      open: quote?.open?.[0] ? Math.round(quote.open[0]) : undefined,
      high: quote?.high?.[0] ? Math.round(quote.high[0]) : undefined,
      low: quote?.low?.[0] ? Math.round(quote.low[0]) : undefined,
      volume: quote?.volume?.[0] || 0,
      timestamp: new Date().toISOString(),
      currency: 'KRW',
      exchange: 'KRX',
    };
  }

  /**
   * 여러 종목 시세 일괄 조회
   */
  async getBatchStockQuotes(
    tickers: { ticker: string; market: Market }[],
  ): Promise<Map<string, StockQuote>> {
    const results = new Map<string, StockQuote>();

    const usTickers = tickers
      .filter((t) => t.market === 'US')
      .map((t) => t.ticker);
    const krTickers = tickers
      .filter((t) => t.market === 'KR')
      .map((t) => t.ticker);

    // 미국주식: Batch API
    if (usTickers.length > 0) {
      try {
        const usQuotes = await this.getUSStockQuotesBatch(usTickers);
        usQuotes.forEach((quote, ticker) => results.set(ticker, quote));
      } catch (error) {
        this.logger.error('US batch quote error:', error);
        for (const ticker of usTickers) {
          const quote = await this.getUSStockQuote(ticker);
          if (quote) results.set(ticker, quote);
        }
      }
    }

    // 국내주식: 개별 조회
    for (const ticker of krTickers) {
      const quote = await this.getKoreanStockQuote(ticker);
      if (quote) results.set(ticker, quote);
    }

    return results;
  }

  /**
   * 미국주식 Batch 조회 (Twelve Data API)
   */
  private async getUSStockQuotesBatch(
    tickers: string[],
  ): Promise<Map<string, StockQuote>> {
    const results = new Map<string, StockQuote>();

    if (tickers.length === 0) return results;

    if (!this.twelveDataApiKey) {
      for (const ticker of tickers) {
        const quote = this.getMockUSStockQuote(ticker);
        results.set(ticker, quote);
      }
      return results;
    }

    // 8개씩 청크로 나눠서 호출
    const chunks: string[][] = [];
    for (let i = 0; i < tickers.length; i += 8) {
      chunks.push(tickers.slice(i, i + 8));
    }

    for (const chunk of chunks) {
      try {
        const symbols = chunk.join(',');
        const response = await fetch(
          `https://api.twelvedata.com/quote?symbol=${symbols}&apikey=${this.twelveDataApiKey}`,
        );

        if (!response.ok) {
          throw new Error('Twelve Data batch API failed');
        }

        const data = await response.json();

        if (chunk.length === 1) {
          if (data.close) {
            results.set(data.symbol, {
              ticker: data.symbol,
              name: data.name,
              price: parseFloat(data.close),
              change: parseFloat(data.change || '0'),
              changePercent: parseFloat(data.percent_change || '0'),
              previousClose: parseFloat(data.previous_close || '0'),
              open: parseFloat(data.open || '0'),
              high: parseFloat(data.high || '0'),
              low: parseFloat(data.low || '0'),
              volume: parseInt(data.volume || '0'),
              timestamp: new Date().toISOString(),
              currency: 'USD',
              exchange: data.exchange || 'US',
            });
          }
        } else {
          for (const [symbol, quoteData] of Object.entries(data)) {
            const quote = quoteData as Record<string, string>;
            if (quote.close) {
              results.set(symbol, {
                ticker: symbol,
                name: quote.name,
                price: parseFloat(quote.close),
                change: parseFloat(quote.change || '0'),
                changePercent: parseFloat(quote.percent_change || '0'),
                previousClose: parseFloat(quote.previous_close || '0'),
                open: parseFloat(quote.open || '0'),
                high: parseFloat(quote.high || '0'),
                low: parseFloat(quote.low || '0'),
                volume: parseInt(quote.volume || '0'),
                timestamp: new Date().toISOString(),
                currency: 'USD',
                exchange: quote.exchange || 'US',
              });
            }
          }
        }
      } catch (error) {
        this.logger.error('Twelve Data batch error:', error);
      }
    }

    return results;
  }

  /**
   * 환율 조회 (USD/KRW)
   */
  async getExchangeRate(): Promise<number> {
    const now = Date.now();

    if (
      this.cachedExchangeRate &&
      now - this.lastExchangeRateFetch < this.EXCHANGE_RATE_CACHE_DURATION
    ) {
      return this.cachedExchangeRate;
    }

    try {
      if (!this.twelveDataApiKey) {
        // 시뮬레이션 환율
        const baseRate = 1320;
        const timeInMinutes = Math.floor(Date.now() / 60000);
        const variation =
          Math.sin(timeInMinutes / 10) * 50 +
          Math.cos(timeInMinutes / 5) * 30;
        this.cachedExchangeRate = Math.round(baseRate + variation);
        this.lastExchangeRateFetch = now;
        return this.cachedExchangeRate;
      }

      const response = await fetch(
        `https://api.twelvedata.com/exchange_rate?symbol=USD/KRW&apikey=${this.twelveDataApiKey}`,
      );

      if (response.ok) {
        const data = await response.json();
        if (data.rate) {
          this.cachedExchangeRate = parseFloat(data.rate);
          this.lastExchangeRateFetch = now;
          return this.cachedExchangeRate;
        }
      }
    } catch (error) {
      this.logger.error('Exchange rate error:', error);
    }

    return this.cachedExchangeRate || 1320;
  }

  /**
   * 전체 종목 목록 조회 (캐싱)
   */
  async fetchAllStocks(): Promise<{
    KR: StockSearchResult[];
    US: StockSearchResult[];
  }> {
    const now = Date.now();

    if (
      this.cachedStockListKR.length > 0 &&
      this.cachedStockListUS.length > 0 &&
      now - this.lastStockListFetch < this.STOCK_LIST_CACHE_DURATION
    ) {
      return {
        KR: this.cachedStockListKR,
        US: this.cachedStockListUS,
      };
    }

    // 동적으로 종목 목록 가져오기 시도
    try {
      const krStocks = await this.fetchKRXStockList();
      if (krStocks.length > 0) {
        this.cachedStockListKR = krStocks;
        // 종목명 캐시 업데이트
        krStocks.forEach((s) => this.stockNameCache.set(s.ticker, s.name));
        this.logger.log(`📊 KRX 종목 ${krStocks.length}개 로드 완료`);
      } else {
        this.cachedStockListKR = this.getDefaultKRStocks();
      }
    } catch (error) {
      this.logger.warn('KRX 종목 목록 조회 실패, 기본 목록 사용:', error);
      this.cachedStockListKR = this.getDefaultKRStocks();
    }

    this.cachedStockListUS = this.getDefaultUSStocks();
    this.lastStockListFetch = now;

    return {
      KR: this.cachedStockListKR,
      US: this.cachedStockListUS,
    };
  }

  /**
   * Twelve Data API로 한국 종목 목록 가져오기
   */
  private async fetchKRXStockList(): Promise<StockSearchResult[]> {
    if (!this.twelveDataApiKey) {
      this.logger.warn('TWELVE_DATA_API_KEY 없음, 기본 종목 목록 사용');
      return [];
    }

    const results: StockSearchResult[] = [];

    // KOSPI + KOSDAQ 종목 가져오기
    const exchanges = ['KRX', 'KOSDAQ'];

    for (const exchange of exchanges) {
      try {
        const url = `https://api.twelvedata.com/stocks?exchange=${exchange}&apikey=${this.twelveDataApiKey}`;
        const response = await fetch(url);

        if (!response.ok) {
          this.logger.warn(`Twelve Data ${exchange} 조회 실패: ${response.status}`);
          continue;
        }

        const data = await response.json();
        const stocks = data?.data || [];

        for (const stock of stocks) {
          // 우선주, 스팩 등 제외하고 보통주/ETF만
          if (stock.type === 'Common Stock' || stock.type === 'ETF') {
            results.push({
              ticker: stock.symbol,
              name: stock.name,
              exchange: exchange === 'KRX' ? 'KOSPI' : 'KOSDAQ',
              type: stock.type,
            });
          }
        }

        this.logger.log(`📊 ${exchange} 종목 ${stocks.length}개 로드`);
      } catch (error) {
        this.logger.warn(`Twelve Data ${exchange} 오류:`, error);
      }
    }

    return results;
  }

  // ========== Mock Data ==========

  private getMockUSStockQuote(ticker: string): StockQuote {
    const mockData: Record<string, { name: string; price: number }> = {
      AAPL: { name: 'Apple Inc.', price: 178.5 },
      MSFT: { name: 'Microsoft Corporation', price: 378.2 },
      GOOGL: { name: 'Alphabet Inc.', price: 141.8 },
      AMZN: { name: 'Amazon.com Inc.', price: 178.3 },
      NVDA: { name: 'NVIDIA Corporation', price: 495.2 },
      META: { name: 'Meta Platforms Inc.', price: 505.8 },
      TSLA: { name: 'Tesla Inc.', price: 248.5 },
      JPM: { name: 'JPMorgan Chase & Co.', price: 195.8 },
      V: { name: 'Visa Inc.', price: 275.4 },
      SPY: { name: 'SPDR S&P 500 ETF Trust', price: 598.5 },
      QQQ: { name: 'Invesco QQQ Trust', price: 505.2 },
      VOO: { name: 'Vanguard S&P 500 ETF', price: 548.8 },
    };

    const stock = mockData[ticker.toUpperCase()] || {
      name: ticker,
      price: 100,
    };
    const changePercent = (Math.random() - 0.5) * 4;
    const change =
      Math.round(stock.price * (changePercent / 100) * 100) / 100;

    return {
      ticker: ticker.toUpperCase(),
      name: stock.name,
      price: Math.round((stock.price + change) * 100) / 100,
      change,
      changePercent: Math.round(changePercent * 100) / 100,
      previousClose: stock.price,
      timestamp: new Date().toISOString(),
      currency: 'USD',
      exchange: 'US',
    };
  }

  private getMockKoreanStockQuote(ticker: string): StockQuote {
    const mockData: Record<string, { name: string; price: number }> = {
      '005930': { name: '삼성전자', price: 71500 },
      '000660': { name: 'SK하이닉스', price: 178000 },
      '035420': { name: 'NAVER', price: 215000 },
      '035720': { name: '카카오', price: 48500 },
      '051910': { name: 'LG화학', price: 385000 },
      '006400': { name: '삼성SDI', price: 415000 },
      '005380': { name: '현대차', price: 245000 },
      '000270': { name: '기아', price: 98500 },
      '373220': { name: 'LG에너지솔루션', price: 385000 },
      '069500': { name: 'KODEX 200', price: 35500 },
      '102110': { name: 'TIGER 200', price: 35800 },
    };

    const stock = mockData[ticker] || {
      name: `종목 ${ticker}`,
      price: 50000,
    };
    const changePercent = (Math.random() - 0.5) * 6;
    const change = Math.round(stock.price * (changePercent / 100));

    return {
      ticker,
      name: stock.name,
      price: stock.price + change,
      change,
      changePercent: Math.round(changePercent * 100) / 100,
      previousClose: stock.price,
      timestamp: new Date().toISOString(),
      currency: 'KRW',
      exchange: 'KRX',
    };
  }

  private getDefaultKRStocks(): StockSearchResult[] {
    return [
      // 시가총액 상위 대형주
      { ticker: '005930', name: '삼성전자', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '000660', name: 'SK하이닉스', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '373220', name: 'LG에너지솔루션', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '005935', name: '삼성전자우', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '006400', name: '삼성SDI', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '051910', name: 'LG화학', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '005380', name: '현대차', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '000270', name: '기아', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '068270', name: '셀트리온', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '035420', name: 'NAVER', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '035720', name: '카카오', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '005490', name: 'POSCO홀딩스', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '055550', name: '신한지주', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '105560', name: 'KB금융', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '012330', name: '현대모비스', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '066570', name: 'LG전자', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '003670', name: '포스코퓨처엠', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '028260', name: '삼성물산', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '034730', name: 'SK', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '096770', name: 'SK이노베이션', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '003550', name: 'LG', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '086790', name: '하나금융지주', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '032830', name: '삼성생명', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '010950', name: 'S-Oil', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '030200', name: 'KT', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '017670', name: 'SK텔레콤', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '018260', name: '삼성에스디에스', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '090430', name: '아모레퍼시픽', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '015760', name: '한국전력', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '034220', name: 'LG디스플레이', exchange: 'KOSPI', type: 'Common Stock' },

      // 2차전지/반도체 관련주
      { ticker: '247540', name: '에코프로비엠', exchange: 'KOSDAQ', type: 'Common Stock' },
      { ticker: '086520', name: '에코프로', exchange: 'KOSDAQ', type: 'Common Stock' },
      { ticker: '006280', name: '녹십자', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '011070', name: 'LG이노텍', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '352820', name: '하이브', exchange: 'KOSPI', type: 'Common Stock' },

      // 바이오/제약
      { ticker: '207940', name: '삼성바이오로직스', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '326030', name: 'SK바이오팜', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '128940', name: '한미약품', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '000100', name: '유한양행', exchange: 'KOSPI', type: 'Common Stock' },

      // 금융/보험
      { ticker: '316140', name: '우리금융지주', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '000810', name: '삼성화재', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '138930', name: 'BNK금융지주', exchange: 'KOSPI', type: 'Common Stock' },

      // 유통/소비재
      { ticker: '004020', name: '현대제철', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '097950', name: 'CJ제일제당', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '051900', name: 'LG생활건강', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '004170', name: '신세계', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '139480', name: '이마트', exchange: 'KOSPI', type: 'Common Stock' },

      // 건설/조선
      { ticker: '000720', name: '현대건설', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '009540', name: '한국조선해양', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '329180', name: 'HD현대중공업', exchange: 'KOSPI', type: 'Common Stock' },

      // 게임/엔터
      { ticker: '036570', name: '엔씨소프트', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '263750', name: '펄어비스', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '259960', name: '크래프톤', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '293490', name: '카카오게임즈', exchange: 'KOSPI', type: 'Common Stock' },

      // ETF
      { ticker: '069500', name: 'KODEX 200', exchange: 'KOSPI', type: 'ETF' },
      { ticker: '102110', name: 'TIGER 200', exchange: 'KOSPI', type: 'ETF' },
      { ticker: '122630', name: 'KODEX 레버리지', exchange: 'KOSPI', type: 'ETF' },
      { ticker: '114800', name: 'KODEX 인버스', exchange: 'KOSPI', type: 'ETF' },
      { ticker: '252670', name: 'KODEX 200선물인버스2X', exchange: 'KOSPI', type: 'ETF' },
      { ticker: '229200', name: 'KODEX 코스닥150', exchange: 'KOSPI', type: 'ETF' },
      { ticker: '305720', name: 'KODEX 2차전지산업', exchange: 'KOSPI', type: 'ETF' },
      { ticker: '091160', name: 'KODEX 반도체', exchange: 'KOSPI', type: 'ETF' },
      { ticker: '133690', name: 'TIGER 미국나스닥100', exchange: 'KOSPI', type: 'ETF' },
      { ticker: '360750', name: 'TIGER 미국S&P500', exchange: 'KOSPI', type: 'ETF' },
      { ticker: '379800', name: 'KODEX 미국S&P500TR', exchange: 'KOSPI', type: 'ETF' },
      { ticker: '381180', name: 'TIGER 미국테크TOP10 INDXX', exchange: 'KOSPI', type: 'ETF' },
    ];
  }

  private getDefaultUSStocks(): StockSearchResult[] {
    return [
      { ticker: 'AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', type: 'Common Stock' },
      { ticker: 'MSFT', name: 'Microsoft Corporation', exchange: 'NASDAQ', type: 'Common Stock' },
      { ticker: 'GOOGL', name: 'Alphabet Inc.', exchange: 'NASDAQ', type: 'Common Stock' },
      { ticker: 'AMZN', name: 'Amazon.com Inc.', exchange: 'NASDAQ', type: 'Common Stock' },
      { ticker: 'NVDA', name: 'NVIDIA Corporation', exchange: 'NASDAQ', type: 'Common Stock' },
      { ticker: 'META', name: 'Meta Platforms Inc.', exchange: 'NASDAQ', type: 'Common Stock' },
      { ticker: 'TSLA', name: 'Tesla Inc.', exchange: 'NASDAQ', type: 'Common Stock' },
      { ticker: 'JPM', name: 'JPMorgan Chase & Co.', exchange: 'NYSE', type: 'Common Stock' },
      { ticker: 'V', name: 'Visa Inc.', exchange: 'NYSE', type: 'Common Stock' },
      { ticker: 'SPY', name: 'SPDR S&P 500 ETF Trust', exchange: 'NYSE', type: 'ETF' },
      { ticker: 'QQQ', name: 'Invesco QQQ Trust', exchange: 'NASDAQ', type: 'ETF' },
      { ticker: 'VOO', name: 'Vanguard S&P 500 ETF', exchange: 'NYSE', type: 'ETF' },
    ];
  }
}
