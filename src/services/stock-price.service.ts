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

  constructor(private configService: ConfigService) {}

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
   * 국내주식 시세 조회 (모의 데이터)
   */
  async getKoreanStockQuote(ticker: string): Promise<StockQuote | null> {
    // 실제 프록시 서버가 있으면 사용, 없으면 모의 데이터
    return this.getMockKoreanStockQuote(ticker);
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

    this.cachedStockListKR = this.getDefaultKRStocks();
    this.cachedStockListUS = this.getDefaultUSStocks();
    this.lastStockListFetch = now;

    return {
      KR: this.cachedStockListKR,
      US: this.cachedStockListUS,
    };
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
      { ticker: '005930', name: '삼성전자', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '000660', name: 'SK하이닉스', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '035420', name: 'NAVER', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '035720', name: '카카오', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '051910', name: 'LG화학', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '006400', name: '삼성SDI', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '005380', name: '현대차', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '000270', name: '기아', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '373220', name: 'LG에너지솔루션', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '068270', name: '셀트리온', exchange: 'KOSPI', type: 'Common Stock' },
      { ticker: '069500', name: 'KODEX 200', exchange: 'KOSPI', type: 'ETF' },
      { ticker: '102110', name: 'TIGER 200', exchange: 'KOSPI', type: 'ETF' },
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
