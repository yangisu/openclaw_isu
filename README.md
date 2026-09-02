# OpenClaw Settings & Personal Assistant

OpenClaw 환경 설정 및 개인 비서 플러그인(`openclaw-personal-assistant`) 저장소입니다.  
Linux(Ubuntu 24.04 LTS) 및 WSL 환경에서 보안 표준을 준수하며 실행되도록 구성되어 있습니다.

---

## 📌 주요 구성 요소

- **`config/`**: OpenClaw 게이트웨이 및 개인 비서 설정 예제 (`openclaw.personal-assistant.example.json5`, `openclaw-personal-assistant-maintenance.example.json`)
- **`plugins/openclaw-personal-assistant/`**: 개인 비서 핵심 플러그인 (브리핑, Google Calendar 연동, 과제/학습 스케줄러, 지식 아카이브 등)
- **`scripts/wsl/`**: Ubuntu / WSL 환경용 설치, 검증, Cron 트리거 및 인수 테스트 스크립트
- **`scripts/windows/`**: Windows 보조 유틸리티 스크립트
- **`docs/`**: 시스템 아키텍처 사양(Specs), 구현 계획(Plans), 런북(Runbooks)

---

## 💻 Ubuntu PC 설치 및 실행 가이드

### 1. 사전 요구사항 (Prerequisites)
- **OS**: Ubuntu 24.04 LTS (권장)
- **Node.js**: `>= 24.15.0 < 25.0.0`
- **Init 시스템**: `systemd`
- **OpenClaw**: `2026.7.1`

Node.js 버전 확인 및 설치:
```bash
node -v # v24.x 버전 확인
```

### 2. 저장소 클론 (Clone Repository)
```bash
git clone https://github.com/yangisu/openclaw_isu.git ~/openclaw_setting
cd ~/openclaw_setting
```

### 3. 플러그인 빌드 (Build Plugin)
```bash
cd ~/openclaw_setting/plugins/openclaw-personal-assistant
npm ci
npm run build
npm run typecheck
cd ~/openclaw_setting
```

### 4. 시크릿 및 디렉토리 권한 설정 (Secrets Setup)
OpenClaw는 강화된 보안 정책(소유자 전용 `chmod 700`, `600`)을 요구합니다.
```bash
mkdir -p -m 700 ~/.openclaw/secrets ~/.openclaw/workspace ~/.openclaw/state/openclaw-personal-assistant
```

필요한 시크릿 파일들을 `~/.openclaw/secrets/`에 배치하고 권한을 `600`으로 설정합니다:
```bash
# 1. 텔레그램 봇 토큰
chmod 600 ~/.openclaw/secrets/telegram-token

# 2. Google OAuth 클라이언트 및 토큰
chmod 600 ~/.openclaw/secrets/google-oauth-client
chmod 600 ~/.openclaw/secrets/google-oauth-token
chmod 600 ~/.openclaw/secrets/google-calendar-binding
```

### 5. 설정 파일 적용 (Configuration)
```bash
# 템플릿 복사
cp config/openclaw.personal-assistant.example.json5 ~/.openclaw/openclaw.personal-assistant.json5
cp config/openclaw-personal-assistant-maintenance.example.json ~/.openclaw/maintenance.json

# 권한 설정
chmod 600 ~/.openclaw/openclaw.personal-assistant.json5 ~/.openclaw/maintenance.json
```
> **참고**: 설정 파일 내 경로(`/home/user/...`) 및 `telegramUserId`를 본인의 환경에 맞게 수정하세요.

### 6. 자동 설치 스크립트 실행 (Run Installation)
```bash
# 드라이 런 (사전 검증)
bash scripts/wsl/install-openclaw.sh --dry-run

# 설치 준비 단계 실행
bash scripts/wsl/install-openclaw.sh

# Google OAuth 인증 및 캘린더 부트스트랩 완료 후 마무리
bash scripts/wsl/install-openclaw.sh --finish
```

### 7. 상태 및 무결성 검증 (Verification)
```bash
# 설치 상태 검증
bash scripts/wsl/install-openclaw.sh --check

# 전체 인수 테스트 실행
bash scripts/wsl/run-acceptance.sh
```

---

## 🔒 보안 및 환경 주의사항

1. **시크릿 격리**: 토큰, 인증 키, 백업 아카이브(`.age`)는 Git에 포함되지 않으며, `~/.openclaw/secrets/`에서 소유자 단독 권한(`chmod 600`)으로 관리됩니다.
2. **개행 문자 (LF)**: Linux 쉘 스크립트(`scripts/wsl/*.sh`)는 반드시 `LF` 개행을 유지해야 합니다. (`.gitattributes`에 자동 설정됨)
3. **Google Calendar 격리**: 캘린더 작업은 전용 도구와 승인된 계정(`yangisu12@gmail.com`)만을 통해 안전하게 수행됩니다.
