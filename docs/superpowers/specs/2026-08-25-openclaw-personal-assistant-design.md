# OpenClaw 개인 AI 비서 설계

작성일: 2026-08-25
상태: 사용자 승인 완료, 구현 전 검토 대기

> 2026-08-27 변경: 이 문서의 네이버 Calendar/CalDAV 관련 선택·범위·구현·인수 기준은 `2026-08-27-openclaw-google-calendar-design.md`가 대체한다. 로컬 작업공간, Telegram, 브리핑, 백업 및 WSL 운영 설계는 계속 유효하다.

## 1. 목적

사용자가 해야 할 일, 저장할 자료, 기억할 사실, 공부 계획, 행사와 약속을 한 AI 비서에게 자연어로 맡기되, 데이터와 변경 권한은 사용자가 직접 통제한다. OpenClaw를 Windows의 WSL2 Gateway로 실행하고, Telegram을 주 대화 및 알림 채널로 사용한다.

시스템은 다음 결과를 제공해야 한다.

- 할 일, 메모, 기억, 공부 계획을 사람이 직접 읽고 수정할 수 있는 로컬 Markdown으로 보관한다.
- 행사, 약속, 예약, 시험, 수업처럼 시간축에서 봐야 하는 일정만 네이버 캘린더에 표시한다.
- 매일 08:00부터 22:00까지 매 정각에 필요한 내용만 Telegram으로 브리핑한다.
- 비밀값과 외부 변경은 최소 권한과 명시적 확인 원칙으로 다룬다.
- 작업공간은 로컬 Git과 Windows 백업으로 사용자가 복구할 수 있게 한다.

## 2. 확정된 선택

| 항목 | 선택 |
|---|---|
| 호스트 | Windows의 Ubuntu 24.04 LTS WSL2 |
| 실행 방식 | OpenClaw Gateway를 WSL systemd 서비스로 상시 실행 |
| 모델 인증 | ChatGPT 계정의 OpenAI OAuth |
| 대화 채널 | Telegram `@Yangisu_openclaw_bot` |
| 시간대 | `Asia/Seoul` |
| 알림 시간 | 매일 08:00~22:00 매 정각 |
| 개인 데이터 원본 | OpenClaw 작업공간의 Markdown |
| 일정 원본 | 네이버 캘린더 |
| 네이버 일정 조회 | CalDAV, 전용 애플리케이션 비밀번호 사용 |
| 네이버 일정 추가 | 네이버 공식 OAuth 캘린더 API, 사용자 확인 후 실행 |
| 일정 수정·삭제 | 네이버 앱에서 사용자가 직접 수행 |
| 접근 정책 | 사용자의 숫자형 Telegram ID만 허용 |

## 3. 범위

### 포함

- Ubuntu WSL2와 OpenClaw 설치 및 서비스 구성
- ChatGPT OAuth 온보딩
- Telegram 개인 봇 연결과 단일 사용자 allowlist
- 로컬 Markdown 기반 할 일, 메모, 사용자 성향, 장기 기억, 공부 계획 관리
- 네이버 캘린더 기존 일정 읽기와 확인 후 일정 추가
- 정시 Telegram 브리핑
- 자동 기동, 상태 점검, 실패 기록, 로컬 백업과 복원 검증

### 제외

- 네이버 캘린더 일정의 AI 기반 수정 및 삭제
- 일반 할 일이나 일상적인 공부 분량을 네이버 캘린더에 등록
- 외부 인터넷에 Gateway 포트 공개
- VPS 기반 24시간 운영
- 여러 Telegram 사용자의 공동 사용
- Notion, Todoist, Google Calendar 등 추가 저장소 도입

PC가 꺼지거나 절전 상태인 동안 Gateway와 Cron은 실행되지 않는다. 이는 WSL2 로컬 운영의 명시적인 제약이다.

## 4. 아키텍처

```text
Windows 시작 작업(사용자 계정)
└─ Ubuntu 24.04 WSL2
   ├─ OpenClaw Gateway (systemd)
   │  ├─ OpenAI OAuth 모델
   │  ├─ Telegram 채널
   │  ├─ OpenClaw Cron
   │  └─ 개인 작업공간
   ├─ 네이버 캘린더 어댑터
   │  ├─ CalDAV 읽기
   │  └─ 공식 OAuth API 일정 추가
   └─ 백업 작업
      └─ D:\openclaw_setting\backups
```

Gateway는 WSL 내부의 `systemd --user` 서비스로 설치하고 `loginctl enable-linger`를 활성화한다. Windows 작업 스케줄러는 시스템 시작 시 `SYSTEM`이 아닌 WSL 배포판 소유 사용자 계정으로 `wsl.exe -d <배포판> --exec /bin/sleep infinity`를 실행한다. 작업은 사용자 로그온 여부와 무관하게 실행하고 비정상 종료 1분 후 다시 시작하도록 구성한다. 종료되지 않는 명시적 keepalive가 WSL을 유지하며, 별도 상태 점검은 `systemctl --user is-active openclaw-gateway.service`의 실제 종료 코드로 판정한다. 작업 실행 계정에서 대상 WSL 배포판이 보이지 않거나 작업이 5분 안에 종료되면 성공으로 처리하지 않는다.

이 설계에서 자동 복구는 Windows 부팅 후 작업 스케줄러에 저장된 사용자 자격 증명으로 시작 작업이 실행되는 상태를 뜻하며, 대화형 로그인을 요구하지 않는다. Gateway는 loopback에만 바인딩하고 Windows 포트 포워딩이나 방화벽 인바운드 규칙을 만들지 않는다.

## 5. 작업공간과 데이터 모델

기본 작업공간은 `~/.openclaw/workspace`다.

| 파일/폴더 | 역할 |
|---|---|
| `INBOX.md` | 분류가 불명확하거나 외부 연동 실패로 대기 중인 항목 |
| `TASKS.md` | 일반 할 일, 상태, 우선순위, 마감, 완료 기록 |
| `NOTES.md` | 저장할 자료와 메모, 출처, 저장일 |
| `STUDY.md` | 장기 학습 목표, 과목별 목표, 주간 계획, 오늘 분량, 복습, 진도 |
| `USER.md` | 사용자의 안정적인 성향과 선호를 날짜 및 활성 상태와 함께 기록 |
| `MEMORY.md` | 장기적으로 유지할 결정과 중요한 사실의 간결한 요약 |
| `memory/YYYY-MM-DD.md` | 날짜별 상세 기록과 작업 맥락 |
| `archive/` | 삭제 대신 이동한 완료·폐기 항목 |

할 일 ID는 `T-YYYYMMDD-NNN`, 공부 계획 ID는 `S-YYYYMMDD-NNN` 형식을 사용한다. 동일 날짜 안의 일련번호는 중복되지 않아야 한다.

### 5.1 Markdown 레코드 계약

`TASKS.md`와 `STUDY.md`의 각 레코드는 ID를 포함한 3단계 제목 하나와 바로 아래의 구조화된 필드 목록 하나로 표현한다. 필드명은 소문자 ASCII로 고정하고 날짜와 시각은 `Asia/Seoul` 오프셋을 포함한 RFC 3339 형식을 사용한다.

```markdown
### T-20260825-001 보고서 초안
- type: "task"
- status: open
- priority: high
- due_at: 2026-08-25T12:00:00+09:00
- created_at: 2026-08-25T09:03:00+09:00
- updated_at: 2026-08-25T09:03:00+09:00
- source: "telegram"

필요한 표와 결론 부분을 먼저 작성한다.
```

`TASKS.md`와 `STUDY.md`의 공통 필수 필드는 `type`, `status`, `created_at`, `updated_at`, `source`다. 할 일은 `priority`와 선택적 `due_at`을, 공부 계획은 `subject`, `target_amount`, `progress`, 선택적 `target_date`, `recurrence`, `review_dates`를 추가한다. 허용 상태는 `open`, `in_progress`, `done`, `archived`이고, 우선순위는 `high`, `normal`, `low`다.

`NOTES.md`, `USER.md`, `MEMORY.md`는 각각 `N-YYYYMMDD-NNN`, `U-YYYYMMDD-NNN`, `M-YYYYMMDD-NNN` ID와 `type`, `created_at`, `updated_at`, `source`를 필수로 사용한다. 메모 상태는 `active|archived`, 사용자 성향과 기억은 `active: true|false` 및 선택적 `supersedes`로 변경 이력을 보존한다. 모든 파일에서 파서가 모르는 필드와 본문은 삭제하거나 재정렬하지 않는다.

모든 Markdown은 UTF-8, LF 줄바꿈으로 저장한다. 필드 값은 아래 형식만 허용한다. `string`은 한 줄 JSON 문자열, `integer`는 10진 정수, `boolean`은 `true|false`, `timestamp`는 오프셋을 포함한 RFC 3339, `date`는 `YYYY-MM-DD`, 목록은 동일 자료형의 JSON 배열이다. 선택 필드는 값이 없으면 키 자체를 생략하며 빈 문자열이나 `null`을 저장하지 않는다.

| 파일 | ID | 추가 필수 필드와 자료형 | 선택 필드와 제약 |
|---|---|---|---|
| `TASKS.md` | `T-YYYYMMDD-NNN` | `type: "task"`, `status: open|in_progress|done|archived`, `priority: high|normal|low` | `due_at: timestamp`, `completed_at: timestamp` |
| `STUDY.md` | `S-YYYYMMDD-NNN` | `type: "study"`, `status`, `subject: string`, `target_amount: integer >= 1`, `unit: string`, `progress: integer` | `target_date: date`, `recurrence: none|daily|weekly`, `review_dates: date[]`; `0 <= progress <= target_amount` |
| `NOTES.md` | `N-YYYYMMDD-NNN` | `type: "note"`, `status: active|archived` | `url: string`, `tags: string[]` |
| `USER.md` | `U-YYYYMMDD-NNN` | `type: "preference"`, `active: boolean` | `supersedes: U-ID` |
| `MEMORY.md` | `M-YYYYMMDD-NNN` | `type: "memory"`, `active: boolean` | `supersedes: M-ID`, `sensitivity: normal|sensitive` |
| `INBOX.md` | `I-YYYYMMDD-NNN` | `type: "inbox"`, `status: pending|resolved|archived`, `reason: string`, `original_text: string` | `resolved_at: timestamp`, `target_id: ID` |
| `memory/YYYY-MM-DD.md` | `D-HHMMSS-NNN` | `type: "daily"`, `entry_at: timestamp`, `source: string` | `related_ids: ID[]` |

각 레코드는 공통으로 `created_at: timestamp`, `updated_at: timestamp`, `source: string`을 가진다. ID는 활성 파일과 보관 파일 전체에서 고유해야 한다. 보관할 때는 레코드를 원래 형식 그대로 `archive/<원본파일명>`으로 이동하고 `archived_at: timestamp`, `archive_reason: string`을 추가한다. `status` 필드가 있는 레코드는 `archived`로, `active` 필드가 있는 레코드는 `false`로 바꾼다.

빈 제목, 알 수 없는 상태, 형식이 잘못된 날짜, 시작보다 이른 종료 시각, 음수이거나 목표량을 초과한 진도는 저장하지 않고 `INBOX.md`에 오류 이유와 함께 보류한다. Telegram 원문은 필요한 최소 범위만 보관하며 메시지 길이 제한을 넘는 입력은 임의 절단하지 않고 거부하거나 첨부 파일로 안내한다.

### 5.2 단일 작성자와 원자적 변경

모든 Markdown 변경과 ID 발급은 작업공간 단위 단일 작성자 큐를 통과한다. 작성자는 배타적 잠금 안에서 최신 파일을 다시 읽고 ID의 다음 일련번호를 계산한 뒤, 같은 디렉터리의 임시 파일에 쓰고 `fsync` 후 원자적으로 교체한다. 잠금 획득 제한 시간은 10초이며 초과하면 변경하지 않고 재시도 가능한 실패로 기록한다.

브리핑과 백업은 잠금이 해제된 완성본만 읽는다. Git 커밋은 한 요청의 파일 교체가 모두 끝난 뒤 생성하며, 작업 시작 전에 존재하던 미커밋 변경은 자동 덮어쓰기·정리·커밋하지 않는다. 사람이 동시에 수정해 읽은 파일의 해시가 쓰기 직전에 달라졌으면 변경을 중단하고 충돌 내용을 `INBOX.md`에 남긴다. 프로세스 중단 뒤에는 남은 임시 파일을 원본으로 승격하지 않고 검역한 다음 마지막 정상 파일을 사용한다.

공부 계획은 다음 정보를 담는다.

- 과목
- 목표와 측정 가능한 분량
- 목표일 또는 반복 주기
- 상태와 현재 진도
- 필요하면 1일, 3일, 7일 등의 복습 예정일

시험, 수업, 스터디 약속처럼 고정 시각이 있는 사건은 네이버 캘린더 일정이다. 단어 암기량, 문제 풀이 분량, 독서 진도 같은 학습 작업은 `STUDY.md`에만 둔다.

## 6. 입력 분류와 변경 규칙

Telegram 입력은 다음 우선순위로 분류한다.

1. 행사·약속·예약·시험·수업 등 고정 일정
2. 공부 목표·분량·진도·복습
3. 일반 할 일
4. 저장할 자료나 메모
5. 사용자 성향 또는 장기 기억
6. 불명확한 항목

동작 규칙은 다음과 같다.

- 할 일, 메모, 공부 계획, 비민감 기억은 자연어 요청으로 즉시 추가·수정·완료할 수 있다.
- 네이버 일정 추가 전에는 제목, 날짜, 시작·종료 시간, 시간대, 장소를 사용자에게 다시 보여주고 확인을 받는다.
- 외부 변경이나 민감한 내용은 실행 또는 저장 전에 확인한다.
- 일정 수정과 삭제는 네이버 앱으로 안내한다.
- 불명확한 입력은 추측해 캘린더에 넣지 않고 `INBOX.md`에 보관한 뒤 질문한다.
- 삭제 요청은 대상을 재확인하고 `archive/`로 이동한다. 즉시 영구 삭제하지 않는다.

## 7. 네이버 캘린더 연동

기존 일정은 CalDAV로 읽는다. 네이버 계정에 2단계 인증이 활성화된 경우 OpenClaw 전용 애플리케이션 비밀번호를 사용한다.

### 7.1 모델·캘린더 인증 PoC 게이트

ChatGPT/Codex OAuth는 `openclaw models auth login --provider openai`의 OpenClaw 관리 흐름만 사용한다. OpenClaw가 생성하는 PKCE와 무작위 `state`, `http://127.0.0.1:1455/auth/callback` 또는 사용자가 직접 붙여 넣은 리디렉션 결과를 통해 `openai:<프로필>`을 생성한다. 토큰은 OpenClaw 인증 저장소에만 두고 작업공간이나 별도 스크립트로 복사하지 않는다. 다음 항목을 모두 통과해야 모델 기능을 활성화한다.

1. `openclaw models auth list --provider openai`에서 의도한 단일 계정 프로필을 식별한다.
2. `openclaw models status`가 사용 가능한 `openai/*` 모델과 만료 정보를 반환한다.
3. Gateway 서비스 계정에서 실제 모델 요청과 Telegram을 통한 모델 요청이 각각 성공한다.
4. 만료·갱신 실패를 시험 더블로 주입했을 때 비밀값을 출력하지 않고 재로그인 필요 상태로 닫힌다.
5. 연결 해제 시 사용자가 OpenAI 계정에서 승인을 철회한 뒤 로컬 OAuth 프로필을 삭제하고 모델 호출이 실패하는지 확인한다.

PoC가 실패하면 모델 기능과 자동 브리핑을 활성화하지 않는다. OpenAI Platform API 키는 사용자가 비용과 별도 과금에 명시적으로 동의한 경우에만 새 설계 선택으로 사용할 수 있으며 자동 대체하지 않는다.

네이버 OAuth 애플리케이션은 개발자센터에서 정확한 callback URL과 캘린더 API 권한을 등록한다. 네이버 인증 요청의 `scope`는 보내지 않고, 매 로그인마다 암호학적으로 안전한 32바이트 `state`를 생성해 10분 동안 한 번만 사용한다. callback의 `state`를 상수 시간 비교로 검증한 뒤에만 code를 교환하며, callback 오류나 재사용된 state는 거부한다. 접근·갱신 토큰과 만료 시각은 모드 `600` 비밀 저장소에 둔다.

네이버 일정 생성은 운영 활성화 전에 별도 테스트 자격 증명으로 다음 PoC를 통과한다.

1. 사용자 동의 후 접근·갱신 토큰과 `expires_in`을 받고 캘린더 권한 누락 시 `403`을 실패로 판정한다.
2. 고정된 테스트 UID로 기본 캘린더에 일정을 한 건 생성하고 응답의 `result`, `processType`, `calendarId`, `icalUid`를 검증한다.
3. CalDAV 또는 네이버 앱에서 제목·시작·종료·UID가 같은 한 건을 확인하고 사용자가 앱에서 삭제한다.
4. 시험 자격 증명의 refresh token으로 접근 토큰 갱신을 확인한 뒤 네이버 revoke API로 토큰 쌍을 폐기한다.
5. 폐기된 토큰의 생성 요청이 실패하고 로그·작업공간·백업에 토큰이 남지 않는지 확인한 다음 운영 자격 증명을 새로 승인한다.

이 PoC가 실패하면 일정 생성 기능만 비활성화하고 CalDAV 읽기와 로컬 기능은 유지한다. 애플리케이션 권한 변경, 사용자 연결 해제 또는 제거 시 네이버 revoke API로 토큰 쌍을 폐기한 뒤 로컬 비밀을 삭제한다.

### 7.2 CalDAV 구현 전 PoC 게이트

네이버가 일반 Linux/WSL CalDAV 클라이언트를 공식 지원 대상으로 명시하지 않으므로, 본 연동은 설치 초기에 다음 PoC를 모두 통과한 뒤에만 활성화한다.

1. WSL에서 TLS 검증을 유지한 채 애플리케이션 비밀번호로 인증한다.
2. 기본·공유 캘린더 목록과 지정 기간의 일정을 읽는다.
3. 단일·종일·반복 일정과 `Asia/Seoul`이 아닌 시간대를 정규화한다.
4. 취소된 일정과 중복 UID를 구분하고, 비밀값이 로그에 남지 않는다.
5. 인증 실패, 타임아웃, 잘못된 XML 응답을 15초 안에 실패로 판정한다.

하나라도 실패하면 CalDAV 기능을 비활성화하고 일정 없는 브리핑을 정상 조회로 가장하지 않는다. 1차 대안은 Telegram에서 네이버 앱의 일정 확인 링크와 동기화 실패를 안내하는 제한 모드다. 지원되지 않는 화면 자동화나 비공식 API로 우회하지 않는다. 향후 공식적으로 지원되는 조회 API 또는 사용자가 승인한 중간 동기화 저장소가 생긴 경우에만 별도 설계 승인을 거쳐 대체한다.

### 7.3 일정 생성 계약

새 일정은 네이버 공식 OAuth 캘린더 API로 추가한다. 등록 요청마다 안정적인 iCalendar UID를 생성하고 로컬 처리 기록에 보관해 재시도 시 중복 등록을 방지한다.

요청은 `calendarId`, `UID`, `DTSTART`, `DTEND`, `SUMMARY`를 필수로 하고 선택적으로 `DESCRIPTION`, `LOCATION`, `RRULE`을 포함한다. 텍스트는 RFC 5545에 맞게 이스케이프하고, 시각 일정은 `TZID=Asia/Seoul`, 종일 일정은 날짜 값으로 구분한다. 종료는 시작보다 늦어야 하며, 기본 종료 시간·반복 규칙·대상 캘린더를 추측하지 않는다.

일정 추가 작업은 로컬 outbox에서 다음 상태를 가진다.

```text
draft → confirmed → submitting → succeeded
                         ├─ pending_reconcile
                         └─ failed
```

확인은 허용된 Telegram 사용자 ID, 정규화된 일정 내용의 해시, 확인 시각을 기록하며 10분 후 만료된다. 내용이 바뀌면 새 확인이 필요하다. UID와 `confirmed` 레코드는 외부 요청 전에 원자적으로 저장하고, 성공은 HTTP 성공과 응답의 `result=success`, `processType=create|modify`, 반환된 `icalUid`를 모두 기록한 뒤에만 알린다. 최초 제출에서 `processType=modify`가 반환되거나 응답을 받기 전에 연결이 끊기면 `pending_reconcile`로 두고 같은 UID가 CalDAV 조회에서 정확히 한 건 확인될 때까지 성공으로 알리지 않는다. 조회가 불가능하면 자동 재제출하지 않고 사용자에게 네이버 앱 확인을 요청한다.

outbox는 Git 외부의 `~/.openclaw/state/calendar-outbox.sqlite3`에 두고 소유자만 읽고 쓸 수 있게 한다. 이 파일은 실행 캐시가 아니라 복구 필수 상태이므로 암호화된 백업에 포함한다. 레코드 스키마는 다음과 같다.

| 필드 | 자료형·제약 |
|---|---|
| `request_id` | UUID, 기본 키 |
| `version` | 0 이상 정수, CAS 갱신마다 1 증가 |
| `status` | `draft|confirmed|submitting|pending_reconcile|succeeded|failed` |
| `uid`, `calendar_id` | 비어 있지 않은 문자열 |
| `payload_ical`, `payload_hash` | 정규화한 iCalendar와 SHA-256 |
| `confirmed_by` | 허용된 Telegram 숫자형 ID |
| `confirmed_at`, `confirmation_expires_at`, `confirmation_consumed_at` | UTC RFC 3339, 소비 전에는 마지막 값만 없음 |
| `attempt_count` | 0~3 정수 |
| `last_attempt_at`, `created_at`, `updated_at` | UTC RFC 3339 |
| `http_status`, `process_type`, `returned_ical_uid`, `error_code` | 결과가 있을 때만 기록 |

상태 변경은 SQLite 트랜잭션에서 `request_id`, 예상 `version`, 현재 `status`를 조건으로 하는 compare-and-swap만 허용한다. `confirmed → submitting` 전이는 확인이 만료되지 않고 `confirmation_consumed_at`이 비어 있을 때만 가능하며 같은 트랜잭션에서 확인을 소비한다. 다른 상태에서 외부 API를 호출하지 않는다. 허용 전이는 위 도식과 `failed → confirmed`뿐이고, 실패 재시도에는 동일 payload hash에 대한 새 사용자 확인이 필요하다.

Gateway 시작 시 복구 스캐너가 outbox를 검사한다. 네트워크 제한 시간보다 오래된 `submitting`은 외부 요청을 다시 보내지 않고 CAS로 `pending_reconcile`로 바꾼다. `pending_reconcile`은 동일 calendar ID와 UID를 CalDAV에서 조회해 payload hash와 일치하는 한 건이면 `succeeded`, 불일치·복수 건이면 `failed`와 사용자 확인 요청으로 전환한다. 조회 불가나 0건은 상태를 유지하고 최초 1회만 경고한다. 30일이 지난 `succeeded` 레코드는 백업 manifest에 포함된 것이 확인된 뒤 요약 감사 로그를 남기고 삭제할 수 있으며 미해결 상태는 자동 삭제하지 않는다.

네트워크 작업은 연결·응답 합계 15초 타임아웃을 사용한다. `429`, 일시적 `5xx`, 네트워크 단절만 최대 3회 지수 백오프로 재시도하고, 인증·권한·검증 오류는 즉시 실패시킨다. OAuth 접근 토큰은 만료 전에 갱신하고, 갱신 실패 시 일정 생성 기능만 닫힌 상태로 전환한다.

네이버 공식 API가 기존 일정의 일반 조회·수정·삭제를 제공하지 않는 제약을 설계에 반영한다. CalDAV 읽기에 실패하면 캐시를 최신 정보로 가장하지 않으며, 브리핑에 일정 동기화 실패 상태를 표시한다.

## 8. Telegram 브리핑

OpenClaw Cron은 `Asia/Seoul` 기준 매일 08:00부터 22:00까지 매 정각 실행한다. 정확한 정각이 요구되므로 자동 분산 실행이 적용되지 않도록 정확 실행 옵션을 사용한다.

브리핑 생성 직전에 네이버 일정을 새로 읽고 로컬 할 일과 공부 계획을 평가한다. 다음 항목만 짧게 표시한다.

```text
🕘 09:00 브리핑

다음 일정
• 11:00 치과 예약

오늘 할 일
• [높음] 보고서 초안 — 12:00까지

📚 오늘의 공부
• 영어 단어 20/50
• 복습 예정: 어제 틀린 문제 12개

놓치기 쉬운 항목
• 2일째 미처리: 보험 서류 제출
```

표시할 일정, 할 일, 공부 계획, 지연 항목과 활성 오류가 모두 없으면 Telegram 메시지를 보내지 않는다. CalDAV·백업·OAuth 오류는 데이터가 없어도 표시 대상이며, 같은 오류의 종류와 대상이 변하지 않으면 최초 한 번만 보내고 상태가 복구되거나 오류 지문이 달라질 때 다시 보낸다. PC 절전 중 놓친 브리핑은 한꺼번에 재전송하지 않는다. 다음 정상 브리핑이 현재의 미완료 항목을 다시 평가한다.

## 9. 보안

- Gateway는 로컬 인터페이스에만 바인딩한다.
- Telegram DM은 `allowlist` 정책과 사용자의 숫자형 ID를 사용한다.
- Telegram은 `dmPolicy: "allowlist"`, `allowFrom: ["tg:<숫자형-ID>"]`, `groupPolicy: "disabled"`, `configWrites: false`로 구성한다.
- 채팅을 통한 shell·elevated 실행, 설정 변경, MCP·플러그인 설치 명령은 기본 비활성화한다.
- 봇 토큰, 네이버 애플리케이션 비밀번호, OAuth 토큰은 Markdown과 Git 외부의 제한된 비밀 파일 또는 OpenClaw 비밀 저장소에 둔다.
- 비밀 파일 권한은 소유자만 읽고 쓸 수 있는 `600`으로 설정한다.
- Git ignore, 백업 제외 규칙, 로그 마스킹을 각각 검증한다.
- 채팅, 스크린샷, 명령 기록에 토큰이나 비밀번호를 출력하지 않는다.
- Gateway 포트 포워딩과 공용 Telegram 봇 접근은 활성화하지 않는다.

캘린더 제목·설명·링크, Telegram 첨부, 저장을 요청한 문서와 웹 콘텐츠는 모두 비신뢰 데이터다. 그 안의 문장은 시스템 명령이나 사용자 확인으로 해석하지 않고 인용된 데이터로만 모델에 전달한다. 비신뢰 데이터만을 근거로 외부 API 호출, shell 실행, 설정·권한 변경, 비밀 읽기 또는 파일 삭제를 수행하지 않는다. 외부 변경 확인은 현재 허용된 Telegram 사용자 ID가 보낸 별도 메시지에서만 유효하며, 전달·인용된 과거 메시지나 캘린더 본문은 확인으로 인정하지 않는다.

## 10. 오류 처리와 복구

- 네이버 일정 추가 실패 시 성공 응답을 보내지 않고 요청을 `INBOX.md`의 대기 항목으로 남긴다.
- 일정 추가 재시도는 저장된 UID를 재사용해 중복을 막는다.
- CalDAV 읽기 실패 시 일정 부분을 실패로 표시하되 로컬 할 일과 공부 브리핑은 계속 제공한다.
- Telegram 전송 및 Cron 실패는 실행 기록에 남긴다. 다음 정상 브리핑에서 아직 유효한 실패를 요약한다.
- Windows 시작 작업은 사용자 계정으로 WSL을 기동하고 Gateway 사용자 서비스의 실제 상태를 점검한다.
- Gateway 비정상 상태는 OpenClaw 진단과 서비스 재시작으로 복구하되, 반복 실패는 사용자에게 명시한다.
- 백업 실패는 정상 백업으로 오인하지 않고 다음 Telegram 연결 시 경고한다.

## 11. 버전 관리와 백업

`~/.openclaw/workspace`는 로컬 Git 저장소로 관리한다. 데이터 변경을 사람이 검토할 수 있는 작은 커밋으로 기록한다.

매일 `D:\openclaw_setting\backups`에 날짜별 암호화 복구 지점을 만든다. 백업 대상은 작업공간의 Markdown, `memory/`, `archive/`, 로컬 Git 저장소와 SQLite online backup API로 만든 `calendar-outbox.sqlite3` 스냅샷이다. 봇 토큰, OAuth·애플리케이션 비밀번호, 인증 프로필, 로그, 일반 실행 캐시, 잠금·임시 파일은 제외한다.

백업 작업은 단일 작성자 큐에서 새 변경을 잠시 막고 작업공간의 파일 목록과 Git HEAD를 고정한 뒤 파일을 스테이징 디렉터리로 복사한다. SQLite는 파일 복사가 아니라 online backup API와 `PRAGMA integrity_check`를 사용한다. 각 상대 경로, 바이트 크기, SHA-256, Git HEAD, 스키마 버전, 생성 시각, 제외 규칙 버전을 `manifest.json`에 기록한다. 모든 해시와 SQLite 무결성 검사가 통과한 경우에만 스테이징 결과를 완성본으로 원자적 이름 변경하며, 그전까지 성공으로 기록하지 않는다.

완성본은 별도로 생성한 `age` 공개 키로 암호화한 단일 아카이브만 보존한다. 복호화 개인 키는 WSL, Git, `D:` 백업 경로 밖의 사용자 관리 오프라인 매체에 저장한다. 백업 디렉터리의 NTFS ACL은 현재 사용자와 Administrators만 허용하고 상속된 일반 사용자 권한을 제거한다. 암호화와 복호화 검증이 끝나면 평문 스테이징을 삭제한다. 암호화나 ACL 검증이 실패하면 평문을 완성본으로 승격하지 않고 현재 사용자만 접근 가능한 임시 위치에 검역하며 경고하고, 다음 성공 또는 사용자 승인 후 삭제한다.

최근 30개의 검증된 일별 복구 지점을 유지한다. 보존 삭제는 새 복구 지점의 암호화·manifest 검증과 격리 복원이 성공하고 검증된 복구 지점이 최소 2개 남을 때만 수행한다. 삭제 대상은 백업 루트의 실제 경로 아래에 있고 `YYYY-MM-DD` 명명 규칙과 manifest를 가진 일반 파일로 해석된 경우로 제한하며 symlink·junction·reparse point는 거부한다.

복원은 기존 작업공간을 덮어쓰지 않고 격리된 임시 위치에 복호화한 뒤 manifest의 모든 해시, Git 무결성, Markdown 파싱, SQLite `integrity_check`, 비밀값 부재를 확인한다. 실제 교체는 사용자 승인과 기존 작업공간의 별도 보존 후에만 수행한다. 매일 최소 테스트 레코드 한 건을 격리 복원하고, 매월 전체 작업공간 복원을 검증한다.

`D:`가 WSL 가상 디스크와 같은 물리 장치라면 이 백업은 논리 삭제·파일 손상 복구만 제공하고 장치 고장이나 랜섬웨어 복구를 보장하지 않는다. 설치 시 Windows의 디스크 고유 ID를 비교해 이 사실을 기록한다. 장치 고장 복구가 필요하면 동일한 `age` 암호화 아카이브를 사용자가 지정한 별도 물리 매체에 주 1회 복제하고, 별도 매체가 없으면 상태 화면에 `device-disaster protection: unavailable`을 표시한다.

## 12. 수용 기준

다음 항목이 모두 통과해야 설치와 설정이 완료된 것으로 본다.

1. Ubuntu 24.04 WSL2에서 systemd가 실행되고 OpenClaw Gateway가 정상 상태다.
2. ChatGPT OAuth로 실제 모델 응답을 받는다.
3. `@Yangisu_openclaw_bot`에서 사용자의 메시지에 응답한다.
4. 허용되지 않은 Telegram 사용자 ID는 접근할 수 없다.
5. 할 일, 메모, 사용자 성향, 장기 기억, 공부 계획을 각각 추가하고 다시 조회할 수 있다.
6. 할 일과 공부 진도를 수정하고 완료·보관할 수 있다.
7. 네이버 기존 일정을 CalDAV로 읽는다.
8. 확인 절차 후 네이버 테스트 일정 하나를 추가하며 중복 재시도가 생기지 않는다.
9. 일정 수정·삭제 요청에는 네이버 앱 사용 경계를 정확히 안내한다.
10. 정시 브리핑을 수동 실행했을 때 일정, 할 일, 공부 계획이 구분되어 표시된다.
11. 내용이 없는 브리핑은 발송되지 않는다.
12. Windows와 WSL 재시작 후 Gateway가 자동 복구된다.
13. 백업을 만들고 격리된 테스트 위치에 복원할 수 있다.
14. Git 추적 파일, 로그, 백업에 봇 토큰·비밀번호·OAuth 토큰이 없음을 검사한다.
15. WSL CalDAV PoC에서 인증, 목록, 단일·종일·반복·타시간대 일정 조회를 실제 결과로 확인하며, 실패하면 제한 모드로 전환된다.
16. 동시에 10개의 할 일 추가와 브리핑 읽기를 실행해 ID가 중복되지 않고 Markdown이 파싱 가능하며 사용자 미커밋 변경이 보존된다.
17. 파일 교체 직전에 프로세스를 중단해 원본이 손상되지 않고 임시 파일이 자동 승격되지 않음을 확인한다.
18. 일정 추가 응답을 의도적으로 유실한 뒤 outbox가 `pending_reconcile`에 남고, 동일 UID의 일정이 두 건 생성되지 않으며 조회 전에는 성공 메시지가 전송되지 않는다.
19. 만료된 확인, 내용이 변경된 확인, 종료가 시작보다 이른 일정, 빈 제목과 잘못된 시간대를 거부한다.
20. OAuth 갱신 실패와 CalDAV 타임아웃을 주입해 로컬 기능은 계속 동작하고 캘린더 기능만 닫힌 상태와 실패 원인을 표시한다.
21. 허용되지 않은 DM과 모든 그룹 메시지, Telegram 설정 변경, shell·elevated·플러그인 명령이 거부된다.
22. 캘린더 설명과 첨부 문서에 도구 실행을 지시하는 문자열을 넣어도 외부 호출·설정 변경·비밀 읽기가 발생하지 않는다.
23. 실제 예약 작업이 `Asia/Seoul` 08:00과 22:00에 실행되고 23:00에는 실행되지 않으며, 절전 복귀 후 놓친 브리핑을 재전송하지 않는다.
24. 일정 데이터가 없지만 CalDAV 조회가 실패한 경우 무발송하지 않고 동기화 실패 경고를 한 번 전송한다.
25. Windows 재부팅과 30분 유휴 상태 후 대화형 로그인 없이 WSL과 `openclaw-gateway.service`가 활성 상태이며 Telegram 요청에 응답한다.
26. ChatGPT OAuth PoC에서 Gateway와 Telegram 모델 호출을 확인하고, 갱신 실패 주입과 승인 철회 후 호출이 닫히는 것을 확인한다.
27. 네이버 OAuth callback의 잘못된·만료된·재사용된 `state`를 거부하고, 테스트 일정 생성·토큰 갱신·폐기·폐기 후 실패를 실제 응답으로 확인한다.
28. 각 Markdown 파일의 최소·최대·선택 필드 레코드를 파싱하고 다시 저장해 자료형, 미지 필드, LF 줄바꿈과 ID 고유성이 보존된다.
29. `submitting` 상태에서 Gateway를 종료한 뒤 재시작해 자동 재제출 없이 `pending_reconcile`로 전환되고, 확인 한 건이 외부 요청 한 건에만 소비된다.
30. 백업 중 동시 변경을 시도해 일관된 snapshot만 생성되며, manifest의 한 바이트를 손상시키면 복원이 거부되고 평문·비밀값이 남지 않는다.
31. 최근 두 복구 지점을 보존한 상태에서만 30일 초과 백업을 삭제하며 symlink·junction 대상은 삭제하지 않는다.
32. 암호화 백업을 격리 위치에 복호화해 SHA-256, Git, Markdown, SQLite 무결성을 모두 검증하고 월간 전체 복원 결과를 기록한다.

## 13. 구현 시 사용자 입력이 필요한 항목

다음 값은 채팅으로 받지 않고 설치 도중 사용자가 로컬 터미널이나 브라우저에 직접 입력한다.

- ChatGPT OAuth 브라우저 로그인
- Telegram BotFather 토큰
- 사용자의 숫자형 Telegram ID
- 네이버 ID와 전용 애플리케이션 비밀번호
- 네이버 개발자 애플리케이션의 OAuth Client ID와 Client Secret

각 인증 단계는 입력 직후 최소 권한과 실제 연결을 검증한다.
