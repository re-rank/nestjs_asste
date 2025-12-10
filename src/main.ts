import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // ConfigService 가져오기
  const configService = app.get(ConfigService);
  const port = configService.get<number>('port') || 3001;
  const frontendUrl = configService.get<string>('frontendUrl');

  // CORS 설정
  app.enableCors({
    origin: frontendUrl || '*',
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
