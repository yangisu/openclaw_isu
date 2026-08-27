# OpenClaw Google Calendar 전용 캘린더 설계

작성일: 2026-08-27  
상태: 사용자 승인 완료

## 1. 목적과 확정 선택

OpenClaw 개인 비서의 네이버 Calendar/CalDAV 연동을 Google Calendar 공식 API로 교체한다. 대상 계정은 `yangisu12@gmail.com`이고, OpenClaw가 OAuth 애플리케이션으로 직접 만든 보조 캘린더 `openclaw_cal`만 조회·생성·수정·삭제한다.

확정된 보안 경계는 다음과 같다.

- Calendar 데이터 권한은 `https://www.googleapis.com/auth/calendar.app.created` 하나만 요청하고, 실제 계정 검증을 위해 `openid email` 식별 범위를 함께 요청한다.
- OAuth 로그인 계정 선택에는 `login_hint=yangisu12@gmail.com`을 사용한다. 토큰 발급 직후와 모든 Calendar API 요청 직전에 Google UserInfo의 검증된 이메일이 정확히 일치하는지 확인한다.
- 기본 캘린더, 기존 보조 캘린더, Calendar ACL, 공유 설정에는 접근하지 않는다.
- `openclaw_cal`의 불변 Google calendar ID를 owner-private 바인딩 파일에 저장한다.
- 도구와 API 클라이언트 양쪽에서 저장된 calendar ID 외의 값을 거부한다.
- Telegram 소유자 ID `6520016662`만 일정 도구를 실행할 수 있다.
- 일정 생성·수정·삭제는 소유자 요청에 즉시 실행하며 별도 2단계 확인은 요구하지 않는다.
- 초대 대상, 참석자, 회의 링크, 이메일 알림, ACL 변경, 캘린더 삭제는 1차 범위에서 제외한다.
- 기존 네이버 비밀 파일은 활성 구성에서 분리하지만 자동 삭제하거나 revoke하지 않는다.

Google은 `calendar.app.created` 범위를 이 애플리케이션이 만든 보조 캘린더 및 그 일정의 조회·생성·변경·삭제 권한으로 정의한다. 구현은 이 권한 자체와 로컬 calendar ID 고정을 함께 사용한다.

## 2. 사용자 기능

### 2.1 조회

`assistant_query`의 calendar 조회는 지정된 최대 31일 범위에서 `openclaw_cal` 일정만 반환한다. 단일 일정, 종일 일정, 반복 일정과 반복 예외를 Google event ID, ETag, 시작·종료, 제목, 장소, 반복 규칙, 상태로 정규화한다. 외부 일정 제목·설명·장소는 신뢰할 수 없는 인용 데이터로 계속 취급한다.

### 2.2 생성·수정·삭제

새 도구 `assistant_calendar_manage`가 다음 세 작업을 제공한다.

- `create`: 제목, 시작, 종료, 선택적 장소·설명·반복 규칙과 `requestId`를 받는다.
- `update`: 정확한 Google event ID와 직전 조회에서 받은 ETag, 변경할 필드를 받는다.
- `delete`: 정확한 Google event ID와 직전 조회에서 받은 ETag를 받는다.

수정과 삭제는 `If-Match`로 ETag를 전송한다. 다른 클라이언트가 일정을 변경해 ETag가 달라졌으면 `calendar_conflict`로 닫고 최신 조회를 요구한다. 생성은 `requestId`에서 결정적으로 만든 Google event ID를 사용하여 네트워크 응답 유실이나 모델 재시도에도 중복 일정을 만들지 않는다.

### 2.3 반복 일정 경계

1차 버전은 반복 시리즈 전체의 생성·수정·삭제를 지원한다. 개별 회차 수정·삭제는 잘못된 시리즈 변경을 막기 위해 거부하고 후속 설계 대상으로 둔다. Google의 RFC 5545 recurrence 문자열은 허용된 `DAILY|WEEKLY|MONTHLY|YEARLY`, interval, count, until, byday에서만 생성한다.

## 3. 구성과 비밀 저장

활성 플러그인 구성의 calendar 섹션은 다음 필드만 허용한다.

```json
{
  "provider": "google",
  "googleOAuthClientFile": "/home/user/.openclaw/secrets/google-oauth-client",
  "googleTokenFile": "/home/user/.openclaw/secrets/google-oauth-token",
  "googleCalendarBindingFile": "/home/user/.openclaw/secrets/google-calendar-binding",
  "expectedAccount": "yangisu12@gmail.com"
}
```

세 파일은 모두 일반 파일, 현재 WSL 사용자 소유, mode `0600`이어야 하고 비밀 디렉터리는 mode `0700`이어야 한다. 심볼릭 링크, hard-link 교체, 루트 밖 경로, 과대 파일, 알 수 없는 JSON 필드를 거부한다.

- client 파일: Google Cloud에서 내려받은 Desktop app OAuth JSON을 정규화한 client ID, client secret, loopback redirect URI.
- token 파일: access token, refresh token, 만료 시각, 정확한 허용 scope 집합.
- binding 파일: 버전, calendar ID, `openclaw_cal` summary, `Asia/Seoul` time zone, 생성 시각.

토큰과 client secret은 로그, CLI 인자, Telegram, acceptance artifact에 출력하지 않는다. 오류는 고정된 redacted error code로만 노출한다.

## 4. OAuth와 캘린더 부트스트랩

Google Desktop app의 권장 loopback redirect와 PKCE S256을 사용한다. CLI는 임의 loopback 포트에 일회용 HTTP 서버를 열고 시스템 브라우저용 URL을 출력한다. state와 PKCE verifier는 owner-private SQLite에 10분 만료·1회 사용으로 저장한다. callback은 정확한 loopback origin/path, `code`와 `state`만 허용하고 성공 또는 오류 안내 HTML을 반환한 뒤 서버를 닫는다.

인증 요청은 `access_type=offline`, `prompt=consent`, 정확한 `openid email calendar.app.created` scope 집합과 계정 login hint를 사용한다. token 응답에 refresh token이 없거나 scope가 다르면 설치를 닫는다. 토큰 발급·갱신 후와 Calendar API 호출 직전에 Google UserInfo의 `email_verified=true` 및 `email=yangisu12@gmail.com`을 검증한다. access token은 만료 5분 전 refresh하고, 동시 refresh는 한 요청만 수행한다.

Google Cloud OAuth 동의 화면이 External/Testing 상태이면 Calendar scope refresh token은 7일 후 만료될 수 있다. 설치 안내와 doctor는 Testing 상태의 운영 위험을 명시하고, 지속 운영은 동의 화면을 Production으로 전환한 뒤 다시 인증하는 절차를 요구한다.

OAuth 성공 후 `calendar bootstrap`은 빈 바인딩 상태에서만 `calendars.insert`로 summary `openclaw_cal`, timeZone `Asia/Seoul`을 생성한다. 응답의 calendar ID를 원자적으로 저장한다. 바인딩 파일이 이미 있으면 새 캘린더를 만들지 않고 `calendars.get`으로 ID·summary·timeZone을 검증한다. 불일치, 404 또는 권한 상실은 자동 재생성하지 않고 `calendar_binding_invalid`로 닫는다.

## 5. Google API 어댑터

외부 호출은 Node 내장 `fetch`와 공식 HTTPS endpoint만 사용한다. 새 런타임 의존성은 추가하지 않는다.

- `POST /calendar/v3/calendars`: 전용 캘린더 최초 생성.
- `GET /calendar/v3/calendars/{calendarId}`: 고정 바인딩 검증.
- `GET /calendar/v3/calendars/{calendarId}/events`: 범위 조회. `singleEvents=false`, `showDeleted=false`, 제한된 page token 순회.
- `POST /calendar/v3/calendars/{calendarId}/events`: 결정적 event ID로 생성.
- `PATCH /calendar/v3/calendars/{calendarId}/events/{eventId}`: ETag 조건부 수정.
- `DELETE /calendar/v3/calendars/{calendarId}/events/{eventId}`: ETag 조건부 삭제.

각 요청은 15초 timeout, 최대 1 MiB 응답, bounded JSON parser, URL path segment 인코딩을 적용한다. 401은 한 번 refresh 후 재시도한다. 403, 404, 409, 412, 429, 5xx와 timeout을 서로 다른 고정 오류 코드로 매핑한다. 429/5xx는 도구 호출 안에서 자동 반복하지 않아 모델과 HTTP 계층의 중복 재시도를 막는다.

## 6. 멱등성과 불확실한 결과

Google event ID는 UUID requestId의 하이픈을 제거한 소문자 값에 고정 접두사를 붙인 허용 문자 ID로 만든다. 같은 requestId와 같은 정규화 payload는 기존 한 건을 성공으로 반환한다. 같은 requestId와 다른 payload는 `calendar_idempotency_conflict`로 거부한다.

생성 응답 전에 연결이 끊기면 동일 event ID를 GET해 정규화 payload가 일치하는지 확인한다. 정확히 일치하면 성공, 404면 한 번만 재제출, 그 밖의 결과는 `calendar_result_unknown`으로 닫는다. 수정·삭제의 응답 유실은 자동 반복하지 않고 최신 GET으로 사후 상태를 확인한다. 수정 payload 일치 또는 삭제 404가 확인된 경우에만 성공으로 처리한다.

SQLite mutation ledger에는 request ID, action, event ID, 이전 ETag, payload hash, 상태, 생성·완료 시각, redacted error code만 저장한다. 일정 본문과 OAuth 비밀은 원장에 중복 저장하지 않는다.

## 7. OpenClaw 도구와 브리핑 변경

등록·허용 도구는 정확히 다음 네 개다.

1. `assistant_query`
2. `assistant_mutate`
3. `assistant_calendar_manage`
4. `assistant_briefing`

네이버 전용 `assistant_calendar_prepare`와 `assistant_calendar_confirm`은 등록과 allowlist에서 제거한다. 기존 구현 파일은 마이그레이션 커밋에서 삭제하거나 Google 도구로 교체하고, 런타임 검증기는 네 도구의 정확한 집합을 검사한다.

브리핑은 Google 조회 결과를 사용한다. Google OAuth, binding 또는 API 장애 시 일정 부분만 fail-closed로 표시하고 로컬 할 일·메모·공부 기능은 계속 동작한다. 같은 장애 지문은 기존 durable one-time warning 규칙을 유지한다.

## 8. 설치·마이그레이션

설치기는 Google OAuth client/token/binding 파일을 owner-private secret tree 계약에 포함한다. 네이버 파일은 활성 설치 필수 목록에서 제거하지만 기존 파일을 삭제하지 않는다. 구성 템플릿, hardened config validator, runtime tool validator, dry-run 문구, doctor와 acceptance 기준을 Google 경계로 갱신한다.

운영 전환 순서는 다음과 같다.

1. Google Cloud 프로젝트에서 Calendar API를 활성화하고 Desktop app OAuth client JSON을 로컬에 저장한다.
2. OAuth 동의 화면의 테스트 사용자에 `yangisu12@gmail.com`을 추가한다.
3. CLI로 client 파일을 가져오고 브라우저에서 해당 계정으로 동의한다.
4. `openclaw_cal`을 API로 한 번 생성하고 바인딩을 저장한다.
5. 구성·플러그인을 설치하고 Gateway를 재시작한다.
6. 조회 후 테스트 일정 생성→수정→삭제를 실행한다.
7. 테스트 일정 0건과 다른 캘린더 접근 거부를 확인한다.

기존 사용자가 Google Calendar 화면에서 미리 만든 동명 캘린더는 이 범위에 포함하지 않는다. `calendar.app.created` 최소 권한을 보장하기 위해 OpenClaw가 API로 새 캘린더를 만들며, 필요하면 사용자가 기존 동명 캘린더의 이름을 먼저 바꾼다.

## 9. 검증 기준

- OAuth URL은 PKCE S256, 10분 state, 정확한 scope와 login hint를 포함한다.
- 잘못되거나 만료·재사용된 state와 잘못된 callback origin/path를 교환 전에 거부한다.
- token/client/binding 파일의 형식·권한·교체 공격을 거부하고 비밀이 출력되지 않는다.
- 부트스트랩 재실행은 캘린더를 중복 생성하지 않는다.
- client와 도구는 저장된 calendar ID 이외의 ID를 거부한다.
- timed, all-day, recurring 이벤트가 조회·생성된다.
- 생성 재시도는 정확히 한 일정만 남긴다.
- 올바른 ETag의 수정·삭제는 성공하고 오래된 ETag는 충돌로 닫힌다.
- 참석자, 초대, ACL, conference data, calendar delete 입력 표면이 없다.
- Google 오류가 있어도 로컬 query/mutate와 briefing의 로컬 부분은 동작한다.
- 런타임에는 정확히 네 optional tool만 보인다.
- 전체 unit/integration test, typecheck, build, plugin validation, installer `--check`가 통과한다.
- 실제 `openclaw_cal`에서 `[OpenClaw PoC]` 일정 한 건을 생성·수정·삭제하고 잔여 PoC 일정이 0건이다.

## 10. 범위 밖

- 기본 또는 기존 Google Calendar 접근
- 일정 참석자 초대, 이메일 발송, Meet 생성
- 캘린더 공유·ACL·색상·삭제 관리
- 개별 반복 회차 변경
- 네이버 일정 자동 이전
- Google OAuth 검증 심사 대행
