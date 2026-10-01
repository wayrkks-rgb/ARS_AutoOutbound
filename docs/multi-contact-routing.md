# 다중 담당자 · 메트릭별 발신 설계

## 요구사항
1. 한 서버(hostname)의 이벤트도 **metric 에 따라 담당자가 다름**
   (예: DB 서버 OS Down → `가용성` 은 OS 담당, `SQL Server Error Log`·DB 프로세스 Down 은 DBA)
2. 한 이벤트에 **여러 담당 그룹이 매칭되면 모두에게 동시에** 발신
3. 담당자가 받지 않으면 **60초 간격 최대 2회 재발신(총 3회)**, 그래도 안 받으면 **60초 뒤 다음 담당자(부담당자)** 에게 같은 방식으로 발신
4. 무응답 / 통화중 / 받았지만 확인 버튼 미입력 → **모두 미응답**
5. 발신 기준: 기본은 event_cd **"심각"** 만. 로그 패턴(memo 키워드)이나 '등급 무관' 규칙은 등급과 상관없이 발신(1순위)
6. 콜백 식별은 `event_id`(이벤트 적재 idx) 기준 — `id` 아님

## 전체 흐름

```
[관제 DB] outbound_queue (이벤트 1건)
     │  Node: 규칙 매칭 (hosts.json: hostname + metric → 담당 그룹 N개)
     ▼
outbound_call  ── 체인1(OS)  : 정담당(pending) → 부담당(standby) …
               └─ 체인2(DBA) : 정담당(pending) → 부담당(standby) …
     │  Node 폴링: usp_outbound_call_claim → IVR check-event
     ▼
IVR 발신 ─ call-done   → usp_outbound_call_done   : answered, 같은 체인 standby 취소
         └ call-failed → usp_outbound_call_failed : 3회 미만 retry_wait / 3회째 exhausted → 다음 순번 pending
     ▼
모든 체인 종료 시 outbound_queue.status = processed(전원 수신) | partial(일부) | failed(아무도 못 받음)
```

| 테이블/프로시저 | 역할 |
|---|---|
| `outbound_queue` (기존) | 이벤트 원장. `dispatched_dt`, `chain_count` 컬럼 추가. `phone` 은 더 이상 사용 안 함 |
| `outbound_call` (신규) | 이벤트 × 담당자 발신 건. 재발신 횟수·다음 발신 시각·체인/순번 보관 |
| `outbound_call_attempt` (신규) | 실제 전화 시도 이력(시도마다 1행) |
| `usp_outbound_call_claim` | 발신할 건 가져오기(pending + 재발신 시각 도래한 retry_wait) |
| `usp_outbound_call_done` / `_failed` | IVR 결과 반영 + 재발신/부담당 넘김 + 이벤트 종결을 **한 트랜잭션**으로 처리 |
| `usp_outbound_call_recover` | 콜백 유실/재기동으로 `processing` 에 멈춘 건을 timeout 처리 |
| `v_outbound_call_history` | 대시보드용 조회 뷰 |

SQL: [`db/001_multi_contact_routing.sql`](../db/001_multi_contact_routing.sql) (되돌리기: `001_multi_contact_routing_rollback.sql`)

## metric 분석 (첨부 파일 45,408건, 고유값 약 360종)

| 분류 | 예시 | 비고 |
|---|---|---|
| 자원 사용률 | `메모리 사용률`(17k), `CPU 사용률`, `가상메모리 스왑 사용률`, `C 사용률`, `/hli_app/app 사용률`, `… Inode 사용률`, `디스크 Top I/O 처리율` | 수치는 `metric_value` |
| 프로세스 | `DHmp 프로세스 개수`, `.*httpd.* 프로세스 개수`, `LINUX-PROCESS_… 프로세스 개수` | |
| 가용성 | `가용성`, `.*tomcat.* 가용성`, `LISTENER_DHIT 가용성` | ping fail / 서비스 Down |
| 로그 감시 | `IVR_Error_log_TEST`, `riv_app.log[Read timed out]`, `SQL Server Error Log`, `Log Monitor`, `jboss_access[YYYY]-[MM]-[DD].log`, `Pod 이벤트 탐지` | 어떤 로그인지가 metric 자체 |
| 기타 | `서버 기동 지속시간`, `NTP 서버와 시간 차이`, `점검` | |

매칭할 때 주의할 점:
- 같은 감시항목이 `X` 와 `X 이벤트 탐지` 두 형태로 들어옴 → **끝의 ` 이벤트 탐지` 와 앞뒤 공백을 떼고** 비교
- `.*httpd.*`, `[YYYY]`, `[Read timed out]` 처럼 정규식/LIKE 특수문자가 **글자 그대로** 들어있음
  → SQL `LIKE` 로 매칭하면 `[ ]` 가 오동작함. **매칭은 Node(JS)에서** 하고, 패턴 문법은 `*`(아무 문자열) 하나만 지원

## hosts.json 새 구조

```json
{
  "hostname": "hl_rec_db", "ip": "10.5.240.5", "department": "금융운영팀",
  "rules": [
    { "id": "r1", "name": "OS",  "metrics": ["가용성", "*사용률"],
      "DAY": "Y", "NIGHT": "Y",
      "contacts": [ {"name": "홍기웅", "phone": "010…"}, {"name": "부담당", "phone": "010…"} ] },
    { "id": "r2", "name": "DBA", "metrics": ["SQL Server Error Log", "*프로세스 개수"],
      "DAY": "Y", "NIGHT": "Y",
      "contacts": [ {"name": "DBA정", "phone": "010…"}, {"name": "DBA부", "phone": "010…"} ] },
    { "id": "r3", "name": "기본", "metrics": ["*"],
      "DAY": "N", "NIGHT": "Y",
      "contacts": [ {"name": "홍기웅", "phone": "010…"} ] }
  ]
}
```

- `metrics` : 정확한 이름 또는 `*` 와일드카드(`*사용률`, `riv_app.log*`). 대소문자 무시
- **매칭된 규칙마다 체인 1개** → 동시에 발신. 같은 metric 에 OS·DBA 를 둘 다 걸고 싶으면 두 규칙에 모두 넣으면 됨
- `["*"]` 규칙은 **다른 규칙이 하나도 안 맞을 때만** 적용(기본 담당)
- `contacts` 순서 = 정 → 부 → … (각자 최대 3회)
- `DAY`/`NIGHT` 는 규칙 단위(현재 서버 단위에서 이동)
- 기존 데이터 이전: 서버마다 `{"name":"기본","metrics":["*"], 기존 DAY/NIGHT, contacts:[기존 담당자]}` 1개로 자동 변환

## 규칙 매칭 순서 (relayServer/core/Router.js)

1. 이벤트 hostname 의 규칙 중 **metric 을 지정했거나 memo 키워드가 있는 규칙**을 모두 확인
   → metric 일치 + 키워드 일치 + 주간/야간(이벤트 발생 시각 기준) + 등급(any_level=N 이면 "심각"만) 을 만족하는 규칙 **전부** 발신
2. 1에서 하나도 없으면 **`*` 기본 규칙** — "심각"만, 로그 감시(`sys_id = '시스템 로그 감시'`) 이벤트는 제외 (기존 필터 그대로)
3. 둘 다 없으면 이벤트 상태 `no_route` (대시보드 '대상 없음')

## IVR 콜백 키 (IVR 시나리오 수정 없음)

IVR 은 check-event 응답의 `event_id` 값을 콜백 `$event-id$` 로 그대로 돌려줍니다. 중계서버는 이 자리에 무엇을 담을지만 정합니다.

| | `IVR_CALLBACK_KEY=call_id` (**기본**) | `IVR_CALLBACK_KEY=event_id` |
|---|---|---|
| 응답의 `event_id` 필드에 담는 값 | `call_id` (발신 1건 번호, 실제 이벤트 번호는 `source_event_id`) | 실제 `event_id` |
| IVR 시나리오 | 변경 없음 | 변경 없음 |
| 같은 이벤트에 담당 그룹 2개 이상 | **동시에** 발신 | 한 번에 1통화씩 |

전제: IVR 이 `event_id` 값을 콜백으로 돌려주는 것 외에 다른 용도(자체 DB 기록 등)로 쓰지 않을 것.

## relayServer 설정 (.env, 모두 선택)

| 키 | 기본값 | 설명 |
|---|---|---|
| `IVR_CALLBACK_KEY` | `call_id` | 위 표 참고 |
| `RETRY_INTERVAL_SEC` | `60` | 같은 담당자 재발신 간격 |
| `ESCALATE_DELAY_SEC` | `60` | 3회 미응답 후 다음 담당자 발신까지 대기 |
| `SEVERITY_LEVEL` | `심각` | 등급 무관이 아닌 규칙이 발신하는 event_cd |
| `LOG_SYS_ID` | `시스템 로그 감시` | 기본(`*`) 규칙에서 제외할 로그 감시 sys_id |
| `EVENT_WINDOW_HOURS` | `3` | 이 시간 이내 발생 이벤트만 배정 |
| `DAY_START_HOUR` / `DAY_END_HOUR` | `9` / `18` | 주간 시간대 |
| `RECOVER_TIMEOUT_MIN` | `10` | IVR 결과가 이 시간 안에 안 오면 미응답(timeout) 처리 |
| `DISPATCH_BATCH` | `100` | 폴링 1회 배정 최대 이벤트 수 |
| `DASHBOARD_HOST` / `DASHBOARD_PORT` / `DASHBOARD_ENABLED` | `127.0.0.1` / `8080` / `Y` | 현황 API (웹 [현황] 화면이 같은 서버에서 호출, 외부 노출 안 함) |
| `HOST_DATA_FILE` | `<repo>/hostRegistry/data/hosts.json` | 규칙 파일 (웹과 같은 경로) |

## 현황 화면 (웹 http://서버:8458 메인)

화면은 웹(hostRegistry)의 첫 화면 [현황] 입니다. 웹이 같은 서버의 relayServer 현황 API(127.0.0.1:8080)를
프록시로 호출하므로 DB 접속 정보는 relayServer/.env 한 곳에만 있습니다. relayServer 가 꺼져 있으면 화면에 연결 오류가 표시됩니다.


- 오늘 이벤트: 성공(전원 수신) / 일부 수신 / 실패(아무도 미수신) / 진행 중 / 대상 없음
- 오늘 발신: 담당자 기준 발신 건, 수신, 3회 미응답, 총 전화 시도 수
- 최근 30일 일별 결과 그래프 (외부 CDN 없이 동작 — 폐쇄망 OK)
- **이벤트별 현황**: 이벤트마다 담당자·상태 요약 → 클릭 시 규칙/순위/번호/시도 이력 상세
- **발신 이력**: 누구에게, 어떤 번호로, 어떤 이벤트(metric·event_id·등급)에 대해, 결과(수신/재발신 대기/3회 미응답/취소)와 시도 횟수

## 적용 순서

1. DB: `db/001_multi_contact_routing.sql` 실행 (되돌리기: `001_multi_contact_routing_rollback.sql`)
2. 기존 `hosts.json` 을 `hostRegistry/data/hosts.json` 으로 복사 → 웹(`run_server.py`) 첫 기동 시 규칙 구조로 자동 변환(.bak 보관)
3. relayServer 재기동 (교체 시점에 이전 코드가 `processing` 으로 잡고 있던 건은 이전 방식대로 남음)
4. 웹에서 서버별 OS/DBA 등 규칙과 부담당자 등록 (또는 [규칙 일괄적용] / 일괄등록 파일)
5. IVR 시나리오에서 무응답·통화중·확인 버튼 미입력을 모두 `call-failed` 로 보내는지 확인
