/**
 * 환경 변수 설정
 */
export default () => ({
  port: parseInt(process.env.PORT, 10) || 3001,
  nodeEnv: process.env.NODE_ENV || 'development',

  // Supabase
  supabase: {
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },

  // AI API Keys
  ai: {
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    deepseek: process.env.DEEPSEEK_API_KEY,
    google: process.env.GOOGLE_API_KEY,
    xai: process.env.XAI_API_KEY,
  },

  // Stock Price API
  twelveData: {
    apiKey: process.env.TWELVE_DATA_API_KEY,
  },

  // Notifications
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  },
  discord: {
    webhookUrl: process.env.DISCORD_WEBHOOK_URL,
  },

  // Frontend URL (for CORS)
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
});
