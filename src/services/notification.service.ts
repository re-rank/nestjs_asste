import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(private configService: ConfigService) {}

  /**
   * 텔레그램 알림 전송
   */
  async sendNotification(message: string): Promise<void> {
    const telegramToken = this.configService.get<string>('telegram.botToken');
    const chatId = this.configService.get<string>('telegram.chatId');

    if (!telegramToken || !chatId) {
      this.logger.log(`📢 Notification (no telegram): ${message}`);
      return;
    }

    try {
      const response = await fetch(
        `https://api.telegram.org/bot${telegramToken}/sendMessage`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML',
          }),
        },
      );

      if (response.ok) {
        this.logger.log('📢 Telegram notification sent');
      } else {
        const error = await response.text();
        this.logger.error('Telegram notification failed:', error);
      }
    } catch (error) {
      this.logger.error('Telegram notification failed:', error);
    }
  }

  /**
   * Discord 알림 전송
   */
  async sendDiscordNotification(message: string): Promise<void> {
    const webhookUrl = this.configService.get<string>('discord.webhookUrl');

    if (!webhookUrl) {
      return;
    }

    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message }),
      });

      if (response.ok) {
        this.logger.log('📢 Discord notification sent');
      } else {
        const error = await response.text();
        this.logger.error('Discord notification failed:', error);
      }
    } catch (error) {
      this.logger.error('Discord notification failed:', error);
    }
  }

  /**
   * 모든 채널로 알림 전송
   */
  async broadcast(message: string): Promise<void> {
    await Promise.all([
      this.sendNotification(message),
      this.sendDiscordNotification(message),
    ]);
  }

  /**
   * 거래 알림 전송
   */
  async sendTradeNotification(
    modelName: string,
    action: 'BUY' | 'SELL',
    ticker: string,
    shares: number,
    price: number,
    market: 'KR' | 'US',
  ): Promise<void> {
    const currencySymbol = market === 'KR' ? '₩' : '$';
    const emoji = action === 'BUY' ? '🟢' : '🔴';
    const actionText = action === 'BUY' ? '매수' : '매도';
    const marketEmoji = market === 'KR' ? '🇰🇷' : '🇺🇸';

    const message = `${marketEmoji} ${emoji} <b>${modelName}</b> ${actionText}
📈 ${ticker} ${shares}주
💰 ${currencySymbol}${price.toLocaleString()}
💵 총액: ${currencySymbol}${(price * shares).toLocaleString()}`;

    await this.broadcast(message);
  }

  /**
   * 일일 리포트 전송
   */
  async sendDailyReport(
    reports: Array<{
      modelName: string;
      totalValue: number;
      returnRate: number;
    }>,
  ): Promise<void> {
    const sortedReports = [...reports].sort(
      (a, b) => b.returnRate - a.returnRate,
    );

    let message = '📊 <b>일일 AI 트레이딩 리포트</b>\n\n';

    sortedReports.forEach((report, index) => {
      const emoji =
        index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '📈';
      const returnEmoji = report.returnRate >= 0 ? '📈' : '📉';
      const sign = report.returnRate >= 0 ? '+' : '';

      message += `${emoji} ${report.modelName}\n`;
      message += `   💰 ₩${report.totalValue.toLocaleString()}\n`;
      message += `   ${returnEmoji} ${sign}${report.returnRate.toFixed(2)}%\n\n`;
    });

    await this.broadcast(message);
  }

  /**
   * 오류 알림 전송
   */
  async sendErrorNotification(
    context: string,
    error: string,
  ): Promise<void> {
    const message = `⚠️ <b>오류 발생</b>
📍 ${context}
❌ ${error}`;

    await this.broadcast(message);
  }
}
