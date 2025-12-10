import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // ConfigService 가져오기
  const configService = app.get(ConfigService);
  // Cloudtype은 PORT 환경 변수를 직접 주입하므로 process.env.PORT 우선 사용
  const port = process.env.PORT || configService.get<number>('port') || 3001;

  // CORS 허용 도메인 목록
  const allowedOrigins = [
    'http://localhost:5173',
    'http://localhost:3000',
    'https://asset-management-re-rank.vercel.app',
    'https://asset-management-git-main-re-rank.vercel.app',
    /\.vercel\.app$/,  // 모든 Vercel 도메인 허용
  ];

  // CORS 설정
  app.enableCors({
    origin: allowedOrigins,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // 서버 시작
  await app.listen(port);

  console.log(`
🚀 AI Trading Backend Server
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📍 Port: ${port}
🌐 URL: http://localhost:${port}
🔗 Health: http://localhost:${port}/health
📊 Info: http://localhost:${port}/api/info
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📅 Trading schedules:
   - Trading check: every 30 minutes
   - Portfolio record: every hour
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  `);
}
bootstrap();
