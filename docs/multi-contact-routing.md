# 다중 담당자 · 메트릭별 발신 설계

## 요구사항
1. 한 서버(hostname)의 이벤트도 **metric 에 따라 담당자가 다름**
   (예: DB 서버 OS Down → `가용성` 은 OS 담당, `SQL Server Error Log`·DB 프로세스 Down 은 DBA)
2. 한 이벤트에 **여러 담당 그룹이 매칭되면 모두에게 동시에** 발신
3. 담당자가 받지 않으면 **최대 2회 재발신(총 3회)**, 그래도 안 받으면 **다음 담당자(부담당자)** 에게 발신
4. 콜백 식별은 `event_id`(이벤트 적재 idx) 기준 — `id` 아님

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

## 바꿔야 할 코드

**Node (relayServer)**
- `adapter.fetchAndLock` → 이벤트 배정(dispatch)으로 변경:
  `pending` 이벤트를 `dispatched` 로 잠그고 → 규칙 매칭 → `outbound_call` INSERT(체인별 1번 `pending`, 나머지 `standby`)를 **한 트랜잭션**으로. 매칭 0건이면 `no_route`
- 폴링: `usp_outbound_call_claim` 결과를 큐에 적재. 같은 **번호+호스트** 건은 지금처럼 한 통화로 묶음(bundle)
- `check-event` 응답의 IVR 콜백 식별값을 **`call_id`** 로 (아래 확인사항 1)
- `call-done` / `call-failed` → 묶인 call_id 마다 SP 호출
- 기동 시 + 주기적으로 `usp_outbound_call_recover`
- 기존 버그 해소: 실패 건이 `phone IS NULL` 조건에 걸려 재발신되지 않던 문제, `id`/`event_id` 혼용

**웹 (hostRegistry)**
- 서버 정보(hostname/IP/부서)와 **수신 규칙(메트릭·주야간·담당자 순서)** 편집 화면 분리
- 일괄등록 양식에 `rule_name, metrics, contact_seq` 열 추가
- metric 입력 시 실제 metric 목록 자동완성(첨부 목록 기반)
- `대시보드(dashboard-server.js)` 는 `v_outbound_call_history` 기준으로 조회 변경

## 확인 필요
1. IVR 시나리오가 콜백 `$event-id$` 에 **어떤 응답 필드를 되돌려 주는지**. 한 이벤트에 여러 명이 동시에 걸리므로 `event_id` 만으로는 어느 통화인지 구분이 안 됨 → `call_id` 를 돌려받도록 시나리오 수정 가능한지
2. **재발신 간격**(SQL 기본값 180초) 과 다음 담당자로 넘어갈 때 대기 시간(현재 즉시)
3. 어떤 IVR 결과를 "미응답"으로 볼지(무응답 / 통화중 / 받았지만 확인 버튼 미입력 …)
4. 현재 keyword 가 없을 때 적용되는 `event_cd = '심각' AND sys_id <> '시스템 로그 감시'` 필터를 유지할지.
   유지하면 **로그 감시 이벤트가 전부 제외**되어 로그별 담당자 지정이 의미가 없어짐
5. 이벤트 상태 `partial`(일부 체인만 수신) 을 대시보드에서 성공/실패 중 어디로 셀지
