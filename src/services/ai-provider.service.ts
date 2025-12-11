import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AIProvider,
  AIHolding,
  TradeDecision,
  Market,
  MarketDataSnapshot,
} from '../types/ai-trading.types';

// Tool 정의
interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: string;
    properties: Record<string, unknown>;
    required: string[];
  };
}

// Tool 호출 결과
interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

// Tool 실행 핸들러 타입
export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

@Injectable()
export class AIProviderService {
  private readonly logger = new Logger(AIProviderService.name);

  // Tool 핸들러 저장
  private toolHandlers: Map<string, ToolHandler> = new Map();

  constructor(private configService: ConfigService) {}

  /**
   * Tool 핸들러 등록
   */
  registerToolHandler(name: string, handler: ToolHandler): void {
    this.toolHandlers.set(name, handler);
  }

  /**
   * AI에게 제공할 Tool 정의
   */
  private getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'search_stocks',
        description:
          '키워드로 종목을 검색합니다. 종목명, 티커, 섹터 등으로 검색 가능합니다. 예: "반도체", "삼성", "AAPL", "테슬라"',
        parameters: {
          type: 'object',
          properties: {
            keyword: {
              type: 'string',
              description: '검색 키워드 (종목명, 티커, 섹터 등)',
            },
            market: {
              type: 'string',
              enum: ['KR', 'US'],
              description: '검색할 시장',
            },
            limit: {
              type: 'number',
              description: '최대 결과 수 (기본: 10)',
            },
          },
          required: ['keyword', 'market'],
        },
      },
      {
        name: 'get_stock_quote',
        description:
          '특정 종목의 현재 시세를 조회합니다. 티커 코드가 필요합니다.',
        parameters: {
          type: 'object',
          properties: {
            ticker: {
              type: 'string',
              description: '종목 코드 (예: 005930, AAPL)',
            },
            market: {
              type: 'string',
              enum: ['KR', 'US'],
              description: '시장 구분',
            },
          },
          required: ['ticker', 'market'],
        },
      },
      {
        name: 'get_top_stocks',
        description:
          '시가총액 상위 종목이나 거래량 상위 종목 등 주요 종목 목록을 가져옵니다.',
        parameters: {
          type: 'object',
          properties: {
            market: {
              type: 'string',
              enum: ['KR', 'US'],
              description: '시장 구분',
            },
            category: {
              type: 'string',
              enum: ['market_cap', 'volume', 'gainers', 'losers'],
              description: '정렬 기준',
            },
            limit: {
              type: 'number',
              description: '최대 결과 수 (기본: 20)',
            },
          },
          required: ['market'],
        },
      },
      {
        name: 'make_trade_decision',
        description:
          '최종 매매 결정을 내립니다. 충분한 정보 수집 후 이 함수를 호출하세요.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['BUY', 'SELL', 'HOLD'],
              description: '매매 행동',
            },
            ticker: {
              type: 'string',
              description: '종목 코드 (BUY/SELL인 경우 필수)',
            },
            stockName: {
              type: 'string',
              description: '종목명',
            },
            shares: {
              type: 'number',
              description: '매매 수량 (BUY/SELL인 경우 필수)',
            },
            reasoning: {
              type: 'string',
              description: '결정 이유 (한국어, 2-3문장)',
            },
            confidence: {
              type: 'number',
              description: '확신도 (0-100)',
            },
            scenario: {
              type: 'string',
              description: '시나리오 설명',
            },
            exchange: {
              type: 'object',
              description: '환전 정보 (필요시)',
              properties: {
                type: {
                  type: 'string',
                  enum: ['KRW_TO_USD', 'USD_TO_KRW'],
                },
                amount: { type: 'number' },
                reason: { type: 'string' },
              },
            },
          },
          required: ['action', 'reasoning', 'confidence'],
        },
      },
    ];
  }

  /**
   * Tool 기반 분석 프롬프트 (시장 데이터 없이)
   */
  private buildToolBasedPrompt(
    holdings: AIHolding[],
    balances: { krwBalance: number; usdBalance: number },
    market: Market,
  ): string {
    const currencySymbol = market === 'KR' ? '₩' : '$';
    const marketName = market === 'KR' ? '한국' : '미국';
    const tradingCash =
      market === 'KR' ? balances.krwBalance : balances.usdBalance;

    const holdingsText =
      holdings.length > 0
        ? holdings
            .map(
              (h) =>
                `- ${h.stockName || h.ticker}: ${h.shares}주 @ ${currencySymbol}${h.avgPrice.toLocaleString()} (현재가: ${currencySymbol}${h.currentPrice?.toLocaleString() || 'N/A'})`,
            )
            .join('\n')
        : '없음';

    return `당신은 전문 주식 투자 AI입니다. 제공된 도구를 사용하여 ${marketName} 시장을 분석하고 매매 결정을 내려주세요.

## 현재 거래 시장: ${marketName} (${market})
- 주의: ${marketName} 시장 종목만 거래 가능합니다.

## 보유 현금 (양쪽 통화)
- 원화 (KRW): ₩${balances.krwBalance.toLocaleString()}
- 달러 (USD): $${balances.usdBalance.toLocaleString()}
- ${marketName} 시장 거래 가능 금액: ${currencySymbol}${tradingCash.toLocaleString()}
${tradingCash === 0 && (market === 'KR' ? balances.usdBalance > 0 : balances.krwBalance > 0) ? `⚠️ ${marketName} 시장 거래 자금이 없습니다! ${market === 'KR' ? '달러를 원화로' : '원화를 달러로'} 환전하면 거래가 가능합니다.` : ''}

## 보유 종목 (${marketName} 시장)
${holdingsText}

## 사용 가능한 도구
1. **search_stocks**: 키워드로 종목 검색 (예: "반도체", "AI", "테슬라")
2. **get_stock_quote**: 특정 종목의 현재 시세 조회
3. **get_top_stocks**: 시가총액/거래량 상위 종목 조회
4. **make_trade_decision**: 최종 매매 결정 (반드시 마지막에 호출)

## 분석 절차
1. get_top_stocks로 주요 종목 현황 파악
2. 관심 있는 종목이나 섹터를 search_stocks로 검색
3. get_stock_quote로 관심 종목의 상세 시세 확인
4. 충분한 정보 수집 후 make_trade_decision으로 최종 결정

## 투자 원칙 (중요!)
- 신중하게 판단하세요. 확실하지 않으면 HOLD를 선택하세요.
- 현금의 일부만 사용하세요. 전액 투자는 위험합니다.
- 분산 투자를 고려하세요.
- 단기 변동성에 휘둘리지 마세요.
- **환전은 필요한 금액만! 절대 전액 환전하지 마세요!** (최대 50%까지만)

## 주의사항
- 반드시 make_trade_decision을 호출하여 최종 결정을 내려주세요.
- 도구 호출 없이 텍스트만 응답하지 마세요.`;
  }

  /**
   * API 키 상태 확인
   */
  getAPIKeyStatus(provider: AIProvider): {
    hasKey: boolean;
    isValid: boolean;
    error?: string;
  } {
    const key = this.getAPIKey(provider);

    switch (provider) {
      case 'openai':
        return {
          hasKey: !!key,
          isValid: key?.startsWith('sk-') ?? false,
          error: !key ? 'OPENAI_API_KEY not configured' : undefined,
        };
      case 'anthropic':
        return {
          hasKey: !!key,
          isValid: key?.startsWith('sk-ant-') ?? false,
          error: !key ? 'ANTHROPIC_API_KEY not configured' : undefined,
        };
      case 'deepseek':
        return {
          hasKey: !!key,
          isValid: key?.startsWith('sk-') ?? false,
          error: !key ? 'DEEPSEEK_API_KEY not configured' : undefined,
        };
      case 'google':
        return {
          hasKey: !!key,
          isValid: key?.startsWith('AIza') ?? false,
          error: !key ? 'GOOGLE_API_KEY not configured' : undefined,
        };
      case 'xai':
        return {
          hasKey: !!key,
          isValid: key?.startsWith('xai-') ?? false,
          error: !key ? 'XAI_API_KEY not configured' : undefined,
        };
      default:
        return {
          hasKey: false,
          isValid: false,
          error: `${provider} not supported`,
        };
    }
  }

  private getAPIKey(provider: AIProvider): string | undefined {
    return this.configService.get<string>(`ai.${provider}`);
  }

  /**
   * 매매 판단 프롬프트 생성
   * @param market 현재 거래 가능한 시장 (KR 또는 US)
   */
  buildAnalysisPrompt(
    holdings: AIHolding[],
    balances: { krwBalance: number; usdBalance: number },
    marketData: MarketDataSnapshot,
    market: 'KR' | 'US',
  ): string {
    const currencySymbol = market === 'KR' ? '₩' : '$';
    const marketName = market === 'KR' ? '한국' : '미국';
    const tradingCash = market === 'KR' ? balances.krwBalance : balances.usdBalance;

    const holdingsText =
      holdings.length > 0
        ? holdings
            .map(
              (h) =>
                `- ${h.stockName || h.ticker}: ${h.shares}주 @ ${currencySymbol}${h.avgPrice.toLocaleString()} (현재가: ${currencySymbol}${h.currentPrice?.toLocaleString() || 'N/A'})`,
            )
            .join('\n')
        : '없음';

    // 현재 시장 종목만 필터링
    const filteredStocks = marketData.stocks.filter((s) => s.market === market);
    const marketText = filteredStocks
      .map(
        (s) =>
          `- ${s.name} (${s.ticker}): ${currencySymbol}${s.price.toLocaleString()} (${s.changePercent >= 0 ? '+' : ''}${s.changePercent.toFixed(2)}%)`,
      )
      .join('\n');

    return `당신은 전문 주식 투자 AI입니다. 현재 ${marketName} 시장 상황을 분석하고 매매 결정을 내려주세요.

## 현재 거래 시장: ${marketName} (${market})
- 주의: ${marketName} 시장 종목만 거래 가능합니다.

## 보유 현금 (양쪽 통화)
- 원화 (KRW): ₩${balances.krwBalance.toLocaleString()}
- 달러 (USD): $${balances.usdBalance.toLocaleString()}
- ${marketName} 시장 거래 가능 금액: ${currencySymbol}${tradingCash.toLocaleString()}
${tradingCash === 0 && (market === 'KR' ? balances.usdBalance > 0 : balances.krwBalance > 0) ? `⚠️ ${marketName} 시장 거래 자금이 없습니다! ${market === 'KR' ? '달러를 원화로' : '원화를 달러로'} 환전하면 거래가 가능합니다.` : ''}

## 보유 종목 (${marketName} 시장)
${holdingsText}

## ${marketName} 시장 데이터 (${marketData.timestamp})
${marketText}

## 지시사항
1. 현재 ${marketName} 시장 상황을 분석하세요.
2. 위 목록에 있는 종목 중에서만 매수/매도를 결정하세요.
3. 매수, 매도, 또는 관망 중 하나를 결정하세요.
4. **${marketName} 시장 거래 자금이 부족하면 환전을 먼저 결정하세요!**
   - ${market === 'KR' ? '원화가 부족하고 달러가 있으면 → USD_TO_KRW 환전' : '달러가 부족하고 원화가 있으면 → KRW_TO_USD 환전'}
5. 결정 이유를 간략히 설명하세요.

## 투자 원칙 (중요!)
- 신중하게 판단하세요. 확실하지 않으면 HOLD를 선택하세요.
- 현금의 일부만 사용하세요. 전액 투자는 위험합니다.
- 분산 투자를 고려하세요.
- 단기 변동성에 휘둘리지 마세요.
- **환전은 필요한 금액만! 절대 전액 환전하지 마세요!** (최대 50%까지만)

## 응답 형식 (반드시 JSON 형식으로 응답)
{
  "action": "BUY" | "SELL" | "HOLD",
  "ticker": "종목코드 (BUY/SELL인 경우, 위 목록에서만 선택)",
  "stockName": "종목명 (BUY/SELL인 경우)",
  "shares": 매매수량 (BUY/SELL인 경우, 정수),
  "reasoning": "결정 이유 (한국어, 2-3문장)",
  "confidence": 0-100 (확신도),
  "scenario": "시나리오 설명 (한국어, 1문장)",
  "exchange": {
    "type": "KRW_TO_USD" | "USD_TO_KRW",
    "amount": 환전할 금액 (아래 설명 참조),
    "reason": "환전 이유"
  }
}

환전 규칙 (매우 중요!):
- KRW_TO_USD: 원화를 달러로 환전. amount는 **원화 금액** (예: 100000 = 10만원 환전)
- USD_TO_KRW: 달러를 원화로 환전. amount는 **달러 금액** (예: 100 = 100달러 환전)
- **환전은 보유 금액의 최대 50%까지만!** 전액 환전 금지!
- 환전이 필요없으면 exchange 필드를 생략하세요.

중요:
- 반드시 위 ${marketName} 시장 종목 목록에서만 선택하세요.
- 매수 시 현금 잔고를 초과하지 마세요.
- 매도 시 보유 수량을 초과하지 마세요.
- 무리한 거래보다 HOLD를 선택하는 것이 나을 수 있습니다.
- 반드시 유효한 JSON만 응답하세요.`;
  }

  /**
   * OpenAI API 호출
   */
  private async callOpenAI(prompt: string): Promise<string> {
    const apiKey = this.getAPIKey('openai');
    if (!apiKey) throw new Error('OpenAI API key not configured');

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You are a professional stock trading AI. Always respond with valid JSON only.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  }

  /**
   * Anthropic Claude API 호출
   */
  private async callAnthropic(prompt: string): Promise<string> {
    const apiKey = this.getAPIKey('anthropic');
    if (!apiKey) throw new Error('Anthropic API key not configured');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.content[0]?.text || '';
  }

  /**
   * DeepSeek API 호출
   */
  private async callDeepSeek(prompt: string): Promise<string> {
    const apiKey = this.getAPIKey('deepseek');
    if (!apiKey) throw new Error('DeepSeek API key not configured');

    const response = await fetch(
      'https://api.deepseek.com/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            {
              role: 'system',
              content:
                'You are a professional stock trading AI. Always respond with valid JSON only.',
            },
            { role: 'user', content: prompt },
          ],
          temperature: 0.7,
          max_tokens: 500,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`DeepSeek API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  }

  /**
   * Google Gemini API 호출
   */
  private async callGoogle(prompt: string): Promise<string> {
    const apiKey = this.getAPIKey('google');
    if (!apiKey) throw new Error('Google API key not configured');

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 500,
          },
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Google API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }

  /**
   * xAI Grok API 호출
   */
  private async callXAI(prompt: string): Promise<string> {
    const apiKey = this.getAPIKey('xai');
    if (!apiKey) throw new Error('xAI API key not configured');

    const response = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'grok-3-fast',
        messages: [
          {
            role: 'system',
            content:
              'You are a professional stock trading AI. Always respond with valid JSON only.',
          },
          { role: 'user', content: prompt },
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`xAI API error: ${response.status} - ${error}`);
    }

    const data = await response.json();
    return data.choices[0]?.message?.content || '';
  }

  /**
   * AI 응답 파싱
   */
  private parseAIResponse(response: string): TradeDecision | null {
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        this.logger.error('No JSON found in response');
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (
        !parsed.action ||
        !['BUY', 'SELL', 'HOLD'].includes(parsed.action)
      ) {
        this.logger.error('Invalid action in response');
        return null;
      }

      return {
        action: parsed.action,
        ticker: parsed.ticker,
        stockName: parsed.stockName,
        market: parsed.market,
        shares: parsed.shares ? Number(parsed.shares) : undefined,
        reasoning: parsed.reasoning || '분석 결과',
        confidence: parsed.confidence ? Number(parsed.confidence) : 50,
        scenario: parsed.scenario,
        exchange: parsed.exchange
          ? {
              type: parsed.exchange.type,
              amount: Number(parsed.exchange.amount),
              reason: parsed.exchange.reason,
            }
          : undefined,
      };
    } catch (error) {
      this.logger.error('Failed to parse AI response:', error);
      return null;
    }
  }

  /**
   * AI 매매 판단 요청
   * @param market 현재 거래 가능한 시장 (KR 또는 US)
   */
  async requestTradeAnalysis(
    provider: AIProvider,
    holdings: AIHolding[],
    balances: { krwBalance: number; usdBalance: number },
    marketData: MarketDataSnapshot,
    market: 'KR' | 'US',
  ): Promise<TradeDecision | null> {
    const keyStatus = this.getAPIKeyStatus(provider);

    if (!keyStatus.hasKey) {
      this.logger.warn(`${provider}: API key not configured. Skipping trade.`);
      return null;
    }

    if (!keyStatus.isValid) {
      this.logger.warn(`${provider}: Invalid API key format. Skipping trade.`);
      return null;
    }

    const prompt = this.buildAnalysisPrompt(holdings, balances, marketData, market);

    try {
      let response: string;

      switch (provider) {
        case 'openai':
          response = await this.callOpenAI(prompt);
          break;
        case 'anthropic':
          response = await this.callAnthropic(prompt);
          break;
        case 'deepseek':
          response = await this.callDeepSeek(prompt);
          break;
        case 'google':
          response = await this.callGoogle(prompt);
          break;
        case 'xai':
          response = await this.callXAI(prompt);
          break;
        default:
          this.logger.warn(`${provider}: Unsupported AI provider.`);
          return null;
      }

      const decision = this.parseAIResponse(response);
      if (decision) {
        this.logger.log(
          `${provider}: Decision - ${decision.action} ${decision.ticker || ''} (confidence: ${decision.confidence})`,
        );
        return decision;
      }

      this.logger.warn(
        `${provider}: Failed to parse response: ${response.substring(0, 200)}`,
      );
      return null;
    } catch (error) {
      this.logger.error(`${provider} API error:`, error);
      return null;
    }
  }

  /**
   * Tool Calling 기반 AI 매매 판단 요청 (신규)
   * AI가 직접 종목을 검색하고 시세를 조회하여 결정
   */
  async requestTradeAnalysisWithTools(
    provider: AIProvider,
    holdings: AIHolding[],
    balances: { krwBalance: number; usdBalance: number },
    market: Market,
  ): Promise<TradeDecision | null> {
    const keyStatus = this.getAPIKeyStatus(provider);

    if (!keyStatus.hasKey) {
      this.logger.warn(`${provider}: API key not configured. Skipping trade.`);
      return null;
    }

    if (!keyStatus.isValid) {
      this.logger.warn(`${provider}: Invalid API key format. Skipping trade.`);
      return null;
    }

    const prompt = this.buildToolBasedPrompt(holdings, balances, market);
    const tools = this.getToolDefinitions();

    try {
      let decision: TradeDecision | null = null;

      switch (provider) {
        case 'openai':
          decision = await this.callOpenAIWithTools(prompt, tools);
          break;
        case 'deepseek':
          decision = await this.callDeepSeekWithTools(prompt, tools);
          break;
        case 'xai':
          decision = await this.callXAIWithTools(prompt, tools);
          break;
        case 'anthropic':
          decision = await this.callAnthropicWithTools(prompt, tools);
          break;
        case 'google':
          decision = await this.callGoogleWithTools(prompt, tools);
          break;
        default:
          this.logger.warn(`${provider}: Tool calling not supported.`);
          return null;
      }

      if (decision) {
        this.logger.log(
          `${provider}: Tool-based Decision - ${decision.action} ${decision.ticker || ''} (confidence: ${decision.confidence})`,
        );
        return decision;
      }

      return null;
    } catch (error) {
      this.logger.error(`${provider} Tool API error:`, error);
      return null;
    }
  }

  /**
   * Tool 실행
   */
  private async executeTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const handler = this.toolHandlers.get(toolName);
    if (!handler) {
      return { error: `Unknown tool: ${toolName}` };
    }

    try {
      return await handler(args);
    } catch (error) {
      this.logger.error(`Tool ${toolName} execution error:`, error);
      return { error: `Tool execution failed: ${error}` };
    }
  }

  /**
   * OpenAI Tool Calling (최대 5회 반복)
   */
  private async callOpenAIWithTools(
    prompt: string,
    tools: ToolDefinition[],
  ): Promise<TradeDecision | null> {
    const apiKey = this.getAPIKey('openai');
    if (!apiKey) throw new Error('OpenAI API key not configured');

    const openaiTools = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const messages: Array<{
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string;
      tool_calls?: unknown[];
      tool_call_id?: string;
    }> = [
      {
        role: 'system',
        content:
          'You are a professional stock trading AI. Use the provided tools to analyze the market and make trading decisions. You MUST call make_trade_decision at the end.',
      },
      { role: 'user', content: prompt },
    ];

    for (let iteration = 0; iteration < 5; iteration++) {
      const response = await fetch(
        'https://api.openai.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            messages,
            tools: openaiTools,
            tool_choice: 'auto',
            temperature: 0.7,
            max_tokens: 1000,
          }),
        },
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`OpenAI API error: ${response.status} - ${error}`);
      }

      const data = await response.json();
      const assistantMessage = data.choices[0]?.message;

      if (!assistantMessage) break;

      // Tool 호출이 있는 경우
      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        messages.push({
          role: 'assistant',
          content: assistantMessage.content || '',
          tool_calls: assistantMessage.tool_calls,
        });

        for (const toolCall of assistantMessage.tool_calls) {
          const toolName = toolCall.function.name;
          const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

          this.logger.log(`🔧 Tool call: ${toolName}(${JSON.stringify(toolArgs)})`);

          // make_trade_decision이면 바로 결과 반환
          if (toolName === 'make_trade_decision') {
            return this.parseToolDecision(toolArgs);
          }

          // 다른 tool 실행
          const result = await this.executeTool(toolName, toolArgs);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }
      } else {
        // Tool 호출 없이 종료 - 텍스트에서 결정 파싱 시도
        if (assistantMessage.content) {
          const decision = this.parseAIResponse(assistantMessage.content);
          if (decision) return decision;
        }
        break;
      }
    }

    this.logger.warn('OpenAI: Max iterations reached without decision');
    return null;
  }

  /**
   * DeepSeek Tool Calling (OpenAI 호환)
   */
  private async callDeepSeekWithTools(
    prompt: string,
    tools: ToolDefinition[],
  ): Promise<TradeDecision | null> {
    const apiKey = this.getAPIKey('deepseek');
    if (!apiKey) throw new Error('DeepSeek API key not configured');

    const openaiTools = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const messages: Array<{
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string;
      tool_calls?: unknown[];
      tool_call_id?: string;
    }> = [
      {
        role: 'system',
        content:
          'You are a professional stock trading AI. Use the provided tools to analyze the market and make trading decisions. You MUST call make_trade_decision at the end.',
      },
      { role: 'user', content: prompt },
    ];

    for (let iteration = 0; iteration < 5; iteration++) {
      const response = await fetch(
        'https://api.deepseek.com/v1/chat/completions',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages,
            tools: openaiTools,
            tool_choice: 'auto',
            temperature: 0.7,
            max_tokens: 1000,
          }),
        },
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`DeepSeek API error: ${response.status} - ${error}`);
      }

      const data = await response.json();
      const assistantMessage = data.choices[0]?.message;

      if (!assistantMessage) break;

      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        messages.push({
          role: 'assistant',
          content: assistantMessage.content || '',
          tool_calls: assistantMessage.tool_calls,
        });

        for (const toolCall of assistantMessage.tool_calls) {
          const toolName = toolCall.function.name;
          const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

          this.logger.log(`🔧 Tool call: ${toolName}(${JSON.stringify(toolArgs)})`);

          if (toolName === 'make_trade_decision') {
            return this.parseToolDecision(toolArgs);
          }

          const result = await this.executeTool(toolName, toolArgs);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }
      } else {
        if (assistantMessage.content) {
          const decision = this.parseAIResponse(assistantMessage.content);
          if (decision) return decision;
        }
        break;
      }
    }

    return null;
  }

  /**
   * xAI Tool Calling (OpenAI 호환)
   */
  private async callXAIWithTools(
    prompt: string,
    tools: ToolDefinition[],
  ): Promise<TradeDecision | null> {
    const apiKey = this.getAPIKey('xai');
    if (!apiKey) throw new Error('xAI API key not configured');

    const openaiTools = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const messages: Array<{
      role: 'system' | 'user' | 'assistant' | 'tool';
      content: string;
      tool_calls?: unknown[];
      tool_call_id?: string;
    }> = [
      {
        role: 'system',
        content:
          'You are a professional stock trading AI. Use the provided tools to analyze the market and make trading decisions. You MUST call make_trade_decision at the end.',
      },
      { role: 'user', content: prompt },
    ];

    for (let iteration = 0; iteration < 5; iteration++) {
      const response = await fetch('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'grok-3-fast',
          messages,
          tools: openaiTools,
          tool_choice: 'auto',
          temperature: 0.7,
          max_tokens: 1000,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`xAI API error: ${response.status} - ${error}`);
      }

      const data = await response.json();
      const assistantMessage = data.choices[0]?.message;

      if (!assistantMessage) break;

      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        messages.push({
          role: 'assistant',
          content: assistantMessage.content || '',
          tool_calls: assistantMessage.tool_calls,
        });

        for (const toolCall of assistantMessage.tool_calls) {
          const toolName = toolCall.function.name;
          const toolArgs = JSON.parse(toolCall.function.arguments || '{}');

          this.logger.log(`🔧 Tool call: ${toolName}(${JSON.stringify(toolArgs)})`);

          if (toolName === 'make_trade_decision') {
            return this.parseToolDecision(toolArgs);
          }

          const result = await this.executeTool(toolName, toolArgs);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          });
        }
      } else {
        if (assistantMessage.content) {
          const decision = this.parseAIResponse(assistantMessage.content);
          if (decision) return decision;
        }
        break;
      }
    }

    return null;
  }

  /**
   * Anthropic Tool Calling
   */
  private async callAnthropicWithTools(
    prompt: string,
    tools: ToolDefinition[],
  ): Promise<TradeDecision | null> {
    const apiKey = this.getAPIKey('anthropic');
    if (!apiKey) throw new Error('Anthropic API key not configured');

    const anthropicTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));

    const messages: Array<{
      role: 'user' | 'assistant';
      content: unknown;
    }> = [{ role: 'user', content: prompt }];

    for (let iteration = 0; iteration < 5; iteration++) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 1000,
          tools: anthropicTools,
          messages,
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Anthropic API error: ${response.status} - ${error}`);
      }

      const data = await response.json();
      const content = data.content;

      if (!content || content.length === 0) break;

      // Tool 사용 확인
      const toolUseBlocks = content.filter(
        (block: { type: string }) => block.type === 'tool_use',
      );

      if (toolUseBlocks.length > 0) {
        messages.push({ role: 'assistant', content });

        const toolResults: Array<{
          type: 'tool_result';
          tool_use_id: string;
          content: string;
        }> = [];

        for (const toolUse of toolUseBlocks) {
          const toolName = toolUse.name;
          const toolArgs = toolUse.input || {};

          this.logger.log(`🔧 Tool call: ${toolName}(${JSON.stringify(toolArgs)})`);

          if (toolName === 'make_trade_decision') {
            return this.parseToolDecision(toolArgs as Record<string, unknown>);
          }

          const result = await this.executeTool(
            toolName,
            toolArgs as Record<string, unknown>,
          );

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          });
        }

        messages.push({ role: 'user', content: toolResults });
      } else {
        // Tool 사용 없이 텍스트만 반환
        const textBlock = content.find(
          (block: { type: string }) => block.type === 'text',
        );
        if (textBlock?.text) {
          const decision = this.parseAIResponse(textBlock.text);
          if (decision) return decision;
        }
        break;
      }
    }

    return null;
  }

  /**
   * Google Gemini Tool Calling
   */
  private async callGoogleWithTools(
    prompt: string,
    tools: ToolDefinition[],
  ): Promise<TradeDecision | null> {
    const apiKey = this.getAPIKey('google');
    if (!apiKey) throw new Error('Google API key not configured');

    const geminiTools = [
      {
        function_declarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];

    const contents: Array<{
      role: 'user' | 'model' | 'function';
      parts: Array<{ text?: string; functionCall?: unknown; functionResponse?: unknown }>;
    }> = [{ role: 'user', parts: [{ text: prompt }] }];

    for (let iteration = 0; iteration < 5; iteration++) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents,
            tools: geminiTools,
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 1000,
            },
          }),
        },
      );

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Google API error: ${response.status} - ${error}`);
      }

      const data = await response.json();
      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts;

      if (!parts || parts.length === 0) break;

      // Function call 확인
      const functionCalls = parts.filter(
        (part: { functionCall?: unknown }) => part.functionCall,
      );

      if (functionCalls.length > 0) {
        contents.push({
          role: 'model',
          parts,
        });

        const functionResponses: Array<{ functionResponse: { name: string; response: unknown } }> =
          [];

        for (const part of functionCalls) {
          const fc = part.functionCall;
          const toolName = fc.name;
          const toolArgs = fc.args || {};

          this.logger.log(`🔧 Tool call: ${toolName}(${JSON.stringify(toolArgs)})`);

          if (toolName === 'make_trade_decision') {
            return this.parseToolDecision(toolArgs as Record<string, unknown>);
          }

          const result = await this.executeTool(
            toolName,
            toolArgs as Record<string, unknown>,
          );

          functionResponses.push({
            functionResponse: {
              name: toolName,
              response: result,
            },
          });
        }

        contents.push({
          role: 'function',
          parts: functionResponses,
        });
      } else {
        // 텍스트만 반환
        const textPart = parts.find((part: { text?: string }) => part.text);
        if (textPart?.text) {
          const decision = this.parseAIResponse(textPart.text);
          if (decision) return decision;
        }
        break;
      }
    }

    return null;
  }

  /**
   * Tool 결정 파싱
   */
  private parseToolDecision(args: Record<string, unknown>): TradeDecision | null {
    if (!args.action || !['BUY', 'SELL', 'HOLD'].includes(args.action as string)) {
      return null;
    }

    return {
      action: args.action as 'BUY' | 'SELL' | 'HOLD',
      ticker: args.ticker as string | undefined,
      stockName: args.stockName as string | undefined,
      shares: args.shares ? Number(args.shares) : undefined,
      reasoning: (args.reasoning as string) || '분석 결과',
      confidence: args.confidence ? Number(args.confidence) : 50,
      scenario: args.scenario as string | undefined,
      exchange: args.exchange
        ? {
            type: (args.exchange as { type: string }).type as 'KRW_TO_USD' | 'USD_TO_KRW',
            amount: Number((args.exchange as { amount: number }).amount),
            reason: (args.exchange as { reason: string }).reason,
          }
        : undefined,
    };
  }
}
