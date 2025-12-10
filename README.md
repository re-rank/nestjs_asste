# AI Trading Backend Server

AI Trading Arena의 자동 매매를 위한 백엔드 서버입니다.

## 주요 기능

- 🤖 **자동 매매**: 시장 시간에 맞게 AI 모델들이 자동으로 매매 결정
- 📊 **시장 데이터**: Twelve Data API를 통한 실시간 시세 조회
- 💱 **환전**: 원화 ↔ 달러 자동 환전
- 📢 **알림**: 텔레그램/Discord 실시간 알림
- 📈 **포트폴리오**: 자산 가치 기록 및 추적

## 시장 운영 시간

- 🇰🇷 **국내증시**: 평일 09:00 ~ 15:00 KST
- 🇺🇸 **미국증시**:
  - 표준시: 23:30 ~ 06:00 KST
  - 서머타임: 22:30 ~ 05:00 KST

## 스케줄

- **매매 체크**: 30분마다
- **포트폴리오 기록**: 매 정시

## 설치

```bash
npm install
```

## 환경 변수 설정

`.env.example`을 `.env`로 복사하고 값을 설정하세요:

```bash
cp .env.example .env
```

필수 환경 변수:
- `SUPABASE_URL`: Supabase 프로젝트 URL
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase 서비스 역할 키
- AI API 키들 (사용할 프로바이더만)

## 실행

```bash
# 개발 모드
npm run start:dev

# 프로덕션 모드
npm run build
npm run start:prod
```

## API 엔드포인트

| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/health` | GET | 서버 상태 확인 |
| `/api/info` | GET | 서버 정보 조회 |
| `/api/market-status` | GET | 시장 상태 조회 |
| `/api/trigger/:market` | POST | 수동 트레이딩 트리거 (KR/US) |

## Railway 배포

```bash
# Railway CLI 설치
npm install -g @railway/cli

# 로그인
railway login

# 배포
railway up
```

## 아키텍처

```
src/
├── config/           # 환경 변수 설정
├── controllers/      # API 컨트롤러
├── scheduler/        # Cron 스케줄러
├── services/         # 비즈니스 로직
│   ├── supabase.service.ts      # DB 연결
│   ├── ai-provider.service.ts   # AI API 호출
│   ├── stock-price.service.ts   # 시세 조회
│   ├── trading.service.ts       # 매매 실행
│   └── notification.service.ts  # 알림 서비스
├── types/            # TypeScript 타입 정의
├── app.module.ts     # 메인 모듈
└── main.ts           # 엔트리포인트
```

## 지원 AI 프로바이더

- OpenAI (GPT-4o-mini)
- Anthropic (Claude 3 Haiku)
- DeepSeek
- Google (Gemini 1.5 Flash)
- xAI (Grok)
