/**
 * AI 주식 매매 시뮬레이션 관련 타입 정의
 */

// AI 모델 제공자
export type AIProvider = 'openai' | 'anthropic' | 'google' | 'xai' | 'deepseek' | 'custom';

// 시장 구분
export type Market = 'KR' | 'US';

// 매매 유형
export type TradeType = 'BUY' | 'SELL';

// AI 모델 정보
export interface AIModel {
  id: string;
  name: string;
  provider: AIProvider;
  avatarColor: string;
  avatarIcon?: string;
  initialCapital: number;
  isActive: boolean;
  createdAt: string;
}

// AI 모델 + 현재 상태 (계산된 값 포함)
export interface AIModelWithStats extends AIModel {
  currentValue: number;
  cash: number;
  krwBalance: number;
  usdBalance: number;
  returnRate: number;
  returnAmount: number;
  rank?: number;
}

// AI 보유 종목
export interface AIHolding {
  id: string;
  modelId: string;
  ticker: string;
  stockName?: string;
  market: Market;
  shares: number;
  avgPrice: number;
  currentPrice?: number;
  totalValue?: number;
  returnRate?: number;
  updatedAt: string;
}

// AI 매매 내역
export interface AITrade {
  id: string;
  modelId: string;
  modelName?: string;
  modelColor?: string;
  ticker: string;
  stockName?: string;
  market: Market;
  tradeType: TradeType;
  shares: number;
  price: number;
  totalAmount: number;
  reasoning?: string;
  scenario?: string;
  createdAt: string;
}

// AI 포트폴리오 (보유 종목 + 현금)
export interface AIPortfolio {
  modelId: string;
  holdings: AIHolding[];
  cash: number;
  krwBalance: number;
  usdBalance: number;
  totalValue: number;
  returnRate: number;
}

// 포트폴리오 가치 히스토리 (차트용)
export interface PortfolioValuePoint {
  date: string;
  timestamp: number;
  values: Record<string, number>;
}

// 시장 데이터 스냅샷
export interface MarketDataSnapshot {
  stocks: StockSnapshot[];
  indices: IndexSnapshot[];
  timestamp: string;
}

export interface StockSnapshot {
  ticker: string;
  name: string;
  market: Market;
  price: number;
  change: number;
  changePercent: number;
  volume?: number;
  high?: number;
  low?: number;
}

export interface IndexSnapshot {
  name: string;
  value: number;
  change: number;
  changePercent: number;
}

// AI 매매 판단 응답
export interface TradeDecision {
  action: 'BUY' | 'SELL' | 'HOLD';
  ticker?: string;
  stockName?: string;
  market?: Market;
  shares?: number;
  targetPrice?: number;
  reasoning: string;
  confidence: number;
  scenario?: string;
  exchange?: {
    type: 'KRW_TO_USD' | 'USD_TO_KRW';
    amount: number;
    reason: string;
  };
}

// 매매 실행 요청
export interface ExecuteTradeRequest {
  modelId: string;
  ticker: string;
  stockName?: string;
  market: Market;
  tradeType: TradeType;
  shares: number;
  price: number;
  reasoning?: string;
  scenario?: string;
}

// 통화별 잔고
export interface CurrencyBalances {
  krwBalance: number;
  usdBalance: number;
}

// 주식 시세
export interface StockQuote {
  ticker: string;
  name?: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  marketCap?: number;
  timestamp: string;
  currency: 'KRW' | 'USD';
  exchange: string;
}

export interface StockSearchResult {
  ticker: string;
  name: string;
  exchange: string;
  type: string;
}

// 트레이딩 라운드 결과
export interface TradingRoundResult {
  success: boolean;
  tradesExecuted: number;
  results: Array<{
    model: string;
    action: string;
    ticker?: string;
  }>;
}

// DB 테이블 타입 (Supabase)
export interface DBModel {
  id: string;
  name: string;
  provider: string;
  avatar_color: string;
  initial_capital: number;
  is_active: boolean;
  created_at: string;
}

export interface DBPortfolio {
  id: string;
  model_id: string;
  ticker: string;
  stock_name?: string;
  market: string;
  shares: number;
  avg_price: number;
  current_price?: number;
  updated_at: string;
}

export interface DBTrade {
  id: string;
  model_id: string;
  ticker: string;
  stock_name?: string;
  market: string;
  trade_type: string;
  shares: number;
  price: number;
  total_amount: number;
  reasoning?: string;
  scenario?: string;
  created_at: string;
}

export interface DBCashBalance {
  id: string;
  model_id: string;
  krw_balance: number;
  usd_balance: number;
  updated_at: string;
}

export interface DBExchangeHistory {
  id: string;
  model_id: string;
  exchange_type: string;
  krw_amount: number;
  usd_amount: number;
  exchange_rate: number;
  reasoning?: string;
  created_at: string;
}

export interface DBPortfolioHistory {
  id: string;
  model_id: string;
  total_value: number;
  recorded_at: string;
}
