# 반입 · 적용 · 검증 가이드

다중 담당자 / 메트릭별 발신 / 재발신·부담당 / 웹 현황 화면 적용 절차입니다.
동작 설계는 [multi-contact-routing.md](multi-contact-routing.md) 참고.

---

## 0. 한눈에 보기

| 순서 | 누가 | 할 일 |
|---|---|---|
| 1 | 본인 | 운영 백업 (relayServer 폴더, 기존 hosts.json, 웹 data 폴더) |
| 2 | **DBA** | 사전 확인 SQL → 스키마 SQL → 권한 SQL 실행 |
| 3 | 본인 | 파일 반입 (relayServer 교체, hostRegistry 교체, hosts.json 위치 이동) |
| 4 | 본인 | 웹 기동 → hosts.json 자동 변환 확인 |
| 5 | 본인 | relayServer 재기동 → 로그 확인 |
| 6 | 본인 + 테스트 담당자 2~3명 | 테스트 서버(TEST-ARS01)로 실제 전화 검증 |
| 7 | 본인 | 실제 서버들에 OS/DBA 규칙·부담당 등록 |

**IVR 시나리오 수정은 없습니다.** 단, IVR 이 무응답·통화중·확인 버튼 미입력을 모두 `call-failed` 로 보내는지만 확인하면 됩니다(6장 T6).

**추가 설치 패키지 없음.** Node 는 기존 `node_modules`(mssql 등) 그대로, Python 은 기존 Flask / waitress / openpyxl 그대로입니다.

---

## 1. 반입 파일

repo 기준 경로입니다. 운영 서버에서는 **relayServer 와 hostRegistry 를 같은 상위 폴더 아래 나란히** 두는 것을 권장합니다
(예: `D:\ARS_AutoOutbound\relayServer`, `D:\ARS_AutoOutbound\hostRegistry`). 다르게 두면 2-3 의 `HOST_DATA_FILE` 설정 필요.

### 1-1. relayServer (Node) — 덮어쓰기 / 신규 / 삭제

| 구분 | 파일 |
|---|---|
| 수정 | `index.js`, `dashboard-server.js` |
| 수정 | `core/Poller.js`, `core/QueueManager.js` |
| **신규** | `core/Router.js`, `core/settings.js` |
| 수정 | `handlers/checkEvent.js`, `handlers/callDone.js`, `handlers/callFailed.js` |
| 수정 | `clients/AdapterBase.js`, `clients/hanwhalife/adapter.js`, `clients/mock/adapter.js` |
| **삭제** | `public/index.html` (화면은 웹으로 이동) |
| 그대로 | `.env`, `logger.js`, `core/HttpServer.js`, `handlers/health.js`, `package.json`, `node_modules/` |

### 1-2. hostRegistry (웹) — 폴더 전체 교체, 단 운영 데이터는 유지

| 구분 | 파일 |
|---|---|
| 교체 | `app.py`, `run_server.py`, `requirements.txt`, `README.md` |
| 교체 | `templates/` 전체 (신규: `dashboard.html`, `_rules.html`) |
| **신규** | `static/rules.js`, `data/metric_catalog.txt` |
| **유지(덮어쓰지 말 것)** | 운영 서버의 `data/users.json`, `data/audit.jsonl`, `data/secret.key`, `venv/` |

### 1-3. DB 스크립트 (DBA 전달)

| 파일 | 용도 |
|---|---|
| `db/001_multi_contact_routing.sql` | 스키마 변경 (재실행 안전) |
| `db/002_grant_runtime_user.sql` | relayServer 계정 권한 (`<DB_USER>` 치환) |
| `db/001_multi_contact_routing_rollback.sql` | 되돌리기 |
| `db/900_test_events.sql` | 검증용 테스트 이벤트 (6장) |

### 1-4. hosts.json 위치 이동

기존 Node 가 읽던 `C:\TEMP\모니터링자동발신시스템구축\hosts.json` 을 **`hostRegistry\data\hosts.json` 으로 복사**합니다.
웹을 처음 띄울 때 새 구조(규칙)로 자동 변환되고 원본은 `hosts.json.<날짜시각>.bak` 으로 남습니다.

---

## 2. DBA 요청 사항

### 2-1. 사전 확인 (001 스크립트 맨 위에도 포함)

```sql
-- ① outbound_queue 컬럼 타입 확인
SELECT c.name, t.name AS type_name, c.max_length, c.is_nullable
FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('IVROWN.outbound_queue') ORDER BY c.column_id;

-- ② status 값에 CHECK 제약이 있는지
SELECT name, definition FROM sys.check_constraints
WHERE parent_object_id = OBJECT_ID('IVROWN.outbound_queue');

-- ③ event_id 중복 여부
SELECT TOP 10 event_id, COUNT(*) FROM IVROWN.outbound_queue GROUP BY event_id HAVING COUNT(*) > 1;
```

확인 기준:
- `event_id` 가 **INT** 인지 (BIGINT 면 신규 테이블의 `event_id INT` 를 BIGINT 로 바꿔서 실행 — 알려주시면 맞춰 드립니다)
- `status` 컬럼 길이 **10자 이상** (`dispatched` 10자, `no_route` 8자, `partial` 7자 저장)
- `status` 에 CHECK 제약이 있으면 `dispatched`, `partial`, `no_route` 값 추가 필요
- `event_id` 중복이 없어야 함 (있으면 알려주세요)

### 2-2. 스키마 변경 — `001_multi_contact_routing.sql`

| 대상 | 변경 | 기존 영향 |
|---|---|---|
| `IVROWN.outbound_queue` | 컬럼 추가 `dispatched_dt DATETIME NULL`, `chain_count TINYINT NULL` | NULL 허용 → 관제 적재 로직 수정 불필요 |
| `IVROWN.outbound_queue` | 인덱스 추가 `IX_outbound_queue_event_id`, `IX_outbound_queue_poll(status, created_dt)` | 없음 |
| `IVROWN.outbound_call` | **신규 테이블** — 이벤트 × 담당자 발신 건 (`call_id` IDENTITY PK) | — |
| `IVROWN.outbound_call_attempt` | **신규 테이블** — 전화 시도 이력 | — |
| 프로시저 5개 | `usp_outbound_call_claim / _done / _failed / _recover`, `usp_outbound_event_finalize` | — |
| 뷰 | `v_outbound_call_history` | — |

- 기존 데이터/컬럼은 삭제·변경하지 않음. `outbound_queue.phone`, `retry_count` 는 새 코드에서 안 씀(그대로 둠)
- 실행 계정: `IVROWN` 스키마에 CREATE TABLE / PROCEDURE / VIEW, `outbound_queue` ALTER 권한

### 2-3. 권한 — `002_grant_runtime_user.sql`

`<DB_USER>` 를 relayServer `.env` 의 `DB_USER` 로 바꿔서 실행 (신규 테이블 SELECT/INSERT/UPDATE, 프로시저 EXECUTE).

---

## 3. 설정

### 3-1. relayServer `.env` — 추가 없이 동작 (기본값)

필요할 때만 추가:

| 키 | 기본값 | 바꿀 때 |
|---|---|---|
| `HOST_DATA_FILE` | `..\hostRegistry\data\hosts.json` | 웹과 폴더를 나란히 두지 않을 때 (웹에도 같은 값) |
| `DASHBOARD_PORT` | `8080` | WAS 에서 8080 을 이미 다른 프로그램이 쓸 때 (웹 `RELAY_STATUS_URL` 도 같이 변경) |
| `IVR_CALLBACK_KEY` | `call_id` | IVR 이 event_id 값을 다른 용도에도 쓰는 게 확인되면 `event_id` |
| `RETRY_INTERVAL_SEC` / `ESCALATE_DELAY_SEC` | `60` / `60` | 재발신 / 부담당 넘김 간격 |

### 3-2. 웹 (환경변수, 기본값이면 생략)

| 키 | 기본값 |
|---|---|
| `SERVER_PORT` | `8458` |
| `HOST_DATA_FILE` | `hostRegistry\data\hosts.json` |
| `RELAY_STATUS_URL` | `http://127.0.0.1:8080` |

### 3-3. 방화벽

- 외부 → WAS : **8458** (웹) 인바운드 허용
- 8080 은 127.0.0.1 전용이라 **열 필요 없음**
- 41001 (IVR → relay) 은 기존 그대로

---

## 4. 기동 순서와 기동 직후 확인

### 4-1. 웹
```bat
cd D:\ARS_AutoOutbound\hostRegistry
venv\Scripts\python run_server.py
```
- [ ] `data\hosts.json.<날짜>.bak` 생성됨
- [ ] 로그인 → 첫 화면 [현황] (relayServer 기동 전이면 "중계서버에 연결할 수 없습니다" 표시가 정상)
- [ ] [서버등록] 108대, 각 서버에 '기본' 규칙 1개, 담당자/주야간 기존과 동일
- [ ] SCC-IVR01 / SCC-IVR02 '기본' 규칙에 memo 키워드 error, warning, critical 유지

### 4-2. relayServer
```bat
cd D:\ARS_AutoOutbound\relayServer
node index.js
```
로그에 아래 3줄이 나오면 정상:
```
[설정] IVR 콜백 키: call_id | 재발신 간격: 60초 | 부담당 넘김 대기: 60초 | 기본 등급: 심각
[READY] 서버 기동 — http://<IVR_IP>:41001
[STATUS API] 발신 현황 API 시작 - http://127.0.0.1:8080
```
- [ ] 웹 [현황] 새로고침 → 오류 배너 사라지고 숫자 표시

---

## 5. 테스트 서버 등록 (웹)

[서버추가] → `TEST-ARS01`, IP `10.255.255.1`(미사용 IP), 부서 아무거나. 규칙 2개:

| 규칙명 | metric 조건 | 등급 무관 | 주간/야간 | 담당자 (순서) |
|---|---|---|---|---|
| OS | `가용성`, `*사용률` | 체크 안 함 | 둘 다 체크 | 테스터A(정) → 테스터B(부) |
| DBA | `SQL Server Error Log` | **체크** | 둘 다 체크 | 테스터C |

---

## 6. 검증 시나리오 (`db/900_test_events.sql`)

**한 블록씩** 실행하고, 전화 / 웹 [현황] / 결과 확인 SELECT 로 확인합니다. (같은 사람 건이 겹치면 1콜로 묶이므로)

| # | 실행 | 기대 결과 | 확인 위치 |
|---|---|---|---|
| T1 | T1 블록 (가용성 1건) | 10초 안에 테스터A 착신 → 받고 확인 버튼 | [현황] 이벤트 '성공', call `answered` |
| T2 | T1 블록의 event_id 만 바꿔 다시 실행 | 테스터A **받지 않기** → 60초 간격 총 3번 → 60초 뒤 테스터B 착신 → 받기 | 이벤트 상세: A `3회 미응답`(시도 3/3), B `수신`, 이벤트 '성공' |
| T3 | T3 블록 (가용성 + SQL 로그) | 테스터A, 테스터C **동시에** 착신 | 이벤트 2건 각각 담당자 표시. SQL 로그는 '경고'지만 DBA 규칙이 등급 무관이라 발신 |
| T4 | T4 블록 (CPU + 메모리) | 테스터A 에게 **1콜만** | 2건 모두 같은 시각 결과, attempt 의 `bundle_id` 같음 |
| T5 | T5 블록 ('경고' CPU) | 전화 안 옴 | 이벤트 '대상 없음' |
| T6 | T1 블록 반복하며 ① 통화중 ② 수신 거절 ③ 받고 확인 버튼 안 누름 | 셋 다 60초 뒤 재발신 | 로그 `[발신 완료:미응답]`. **재발신이 안 되면 IVR 이 해당 경우에 call-failed 를 안 보내는 것** → IVR 담당 확인 |
| T7 | 전화 받는 중 relayServer 중지 → 재기동 | 10분 뒤 그 건이 미응답(timeout) 처리되고 재발신 | attempt `result = timeout` |
| T8 | 웹 [규칙 일괄적용] / 일괄등록 / 내보내기 | 규칙 반영, 내보낸 파일 재업로드 시 동일 | [변경이력] 상세 |

추가 확인:
- relayServer 로그 `[배정] event_id: ... | 체인: OS(테스터A→테스터B)` 로 어떤 규칙이 매칭됐는지 확인
- 검증 후 900 스크립트 맨 아래 정리 SQL 로 테스트 데이터 삭제, TEST-ARS01 서버 삭제

---

## 7. 실서버 규칙 등록

- 서버별 OS / DBA / 업무 담당 규칙과 부담당자 등록 — [규칙 일괄적용]으로 여러 서버에 한 번에 적용 가능
- 또는 [내보내기]로 현재 목록을 받아 엑셀로 규칙·부담당 행을 추가한 뒤 [일괄등록]
- metric 은 **정확히 일치**하므로 계열 전체는 `*` 사용 (예: `*가용성`, `*프로세스 개수`, `riv_app.log*`)
- 규칙을 추가하지 않은 서버는 기존과 같이 '기본' 규칙(심각만, 로그 감시 제외)으로 발신

---

## 8. 롤백

| 상황 | 방법 |
|---|---|
| 코드만 되돌리기 | relayServer 백업 폴더 복원 + **기존 형식 hosts.json(.bak) 을 원래 경로로 복원** (이전 Node 는 새 규칙 형식을 못 읽음). 웹도 백업본으로 복원 |
| DB 까지 되돌리기 | 위 + `001_multi_contact_routing_rollback.sql` (발신 이력 테이블 삭제됨). 추가 컬럼은 이전 코드에 영향 없어 **DB 는 그대로 둬도 됨** |

교체 시점 주의: 이전 코드가 `processing` 으로 잡고 있던 이벤트는 새 코드가 다시 걸지 않습니다. 발신이 한가한 시간에 교체하세요.

---

## 9. 이미 검증한 것 / 운영에서 처음 확인되는 것

| 개발 환경에서 검증함 | 운영에서 처음 확인 |
|---|---|
| SQL Server 2019 에 스키마 적용·재적용·롤백 | 실제 `outbound_queue` 컬럼 타입·제약 (2-1) |
| 재발신 3회 → 부담당 넘김, 동시 발신, 묶음, 콜백 유실 복구 | 실제 IVR 연동, 무응답/통화중/확인 미입력 시 call-failed 여부 (T6) |
| IVR 요청을 흉내 낸 HTTP 호출로 call_id 콜백 왕복 | IVR 이 event_id 값을 콜백 외 용도로 쓰는지 |
| 실제 hosts.json 108건 자동 변환, 웹 전 화면, 현황 프록시 | Windows / Python 3.13 / Node 22 실서버 기동 (개발 검증은 Linux, Python 3.11, Node 22) |
