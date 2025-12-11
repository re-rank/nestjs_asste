import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type {
  AIProvider,
  AIHolding,
  TradeDecision,
  MarketDataSnapshot,
} from '../types/ai-trading.types';

@Injectable()
export class AIProviderService {
  private readonly logger = new Logger(AIProviderService.name);

  constructor(private configService: ConfigService) {}

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
    "amount": 환전할 금액 (원화면 원화금액, 달러면 달러금액),
    "reason": "환전 이유"
  }
}

중요:
- 반드시 위 ${marketName} 시장 종목 목록에서만 선택하세요.
- 매수 시 현금 잔고를 초과하지 마세요.
- 매도 시 보유 수량을 초과하지 마세요.
- **거래 자금이 없으면 반드시 환전을 먼저 하세요!** 환전 후 매수도 가능합니다.
- 환전 시 amount는 ${market === 'KR' ? '달러 금액 (USD_TO_KRW)' : '원화 금액 (KRW_TO_USD)'}입니다.
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
}
