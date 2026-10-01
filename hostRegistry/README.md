# 서버 연락처 / 수신 규칙 등록 시스템 — 구축 가이드

WAS 서버의 Node.js(relayServer)가 읽는 JSON 파일에 **서버 정보(호스트네임/IP/부서)** 와
**수신 규칙(어떤 metric 이 오면 누구에게, 정→부 순서로 전화할지)** 을 등록·관리하는 내부 웹 도구입니다.
Node.js는 이 JSON을 **읽기만** 합니다. 발신 동작 설계는 [`docs/multi-contact-routing.md`](../docs/multi-contact-routing.md) 참고.

- Python 3.13 / Flask / waitress / openpyxl  (외부 폰트·CDN 미사용 = 폐쇄망 OK)
- 로그인 + 권한: **admin**(전체) / **viewer**(조회·export만)
- 쓰기는 **락 + 원자적 교체(temp→os.replace)** 로 안전하게 처리

저장되는 레코드 형태 (Node 계약):
```json
{"hostname":"hl_rec_db","ip":"10.5.240.5","department":"금융운영팀",
 "rules":[
   {"id":"r1a2b3","name":"OS","metrics":["가용성","*사용률"],"keywords":[],"any_level":"N","DAY":"Y","NIGHT":"Y",
    "contacts":[{"name":"홍기웅","phone":"01012345678"},{"name":"부담당","phone":"01023456789"}]},
   {"id":"r4c5d6","name":"기본","metrics":["*"],"keywords":[],"any_level":"N","DAY":"N","NIGHT":"Y",
    "contacts":[{"name":"홍기웅","phone":"01012345678"}]}]}
```
- `metrics`: 관제 metric 이름 또는 `*` 패턴. `["*"]` 는 기본 담당(다른 규칙이 하나도 안 맞을 때만)
- `keywords`: memo 에 포함되면 발신(있으면 등급 무관). `any_level`: N 이면 event_cd "심각"만
- `contacts`: 위에서부터 정 → 부 순서. 각자 60초 간격 3회 미응답 시 다음 사람
- 이전 형식(서버당 `name/phone/DAY/NIGHT/keyword`) 파일은 **첫 기동 시 '기본' 규칙으로 자동 변환**되고
  원본은 `hosts.json.<날짜>.bak` 으로 보관됩니다. Node 는 두 형식 모두 읽습니다.

---

## 1. pip 설치 패키지

`requirements.txt` 의 직접 의존성은 **3개**입니다.
```
Flask==3.1.0
waitress==3.0.2
openpyxl==3.1.5
```
설치 시 함께 따라오는 의존성(전이 패키지)까지 포함하면 총 10개입니다:
`Flask, waitress, openpyxl, Werkzeug, Jinja2, MarkupSafe, itsdangerous, click, blinker, et-xmlfile`

> 이 중 **MarkupSafe만 C-확장(플랫폼별 휠)** 이고 나머지는 순수 파이썬입니다.
> 그래서 오프라인 반입 시 **반드시 대상 서버와 같은 환경(Windows 64bit / Python 3.13 = cp313)** 의 휠을 받아야 합니다.

---

## 2. 폐쇄망 설치 (오프라인)

### (A) 인터넷 되는 PC에서 — 휠 내려받기
```bat
pip download -r requirements.txt -d wheels --only-binary=:all: ^
  --python-version 3.13 --platform win_amd64
```
`wheels` 폴더 + 프로젝트 전체를 zip으로 묶어 반입합니다.
(인터넷 PC에도 Python 3.13을 깔아두면 위 플래그 없이도 정확히 맞는 휠을 받습니다.)

### (B) 폐쇄망 서버에서 — venv 구성 + 설치
```bat
cd C:\app\host-registry
python -m venv venv
venv\Scripts\python -m pip install --no-index --find-links=wheels -r requirements.txt
```

---

## 3. ★ 수정해야 하는 부분 (app.py 상단 설정 블록)

`app.py` 의 `▼▼▼ 설정 ▼▼▼` ~ `▲▲▲ 설정 끝 ▲▲▲` 사이만 환경에 맞게 바꾸면 됩니다.

| 변수 | 설명 | 예시 / 기본값 |
|------|------|--------------|
| **`HOST_DATA_FILE`** | Node.js(relayServer)와 공유하는 JSON 경로. 기본값 그대로 쓰면 양쪽이 같은 파일을 봄 | `hostRegistry\data\hosts.json` |
| **`SERVER_HOST`** | 바인딩 IP. `0.0.0.0`=모든 NIC, 특정 IP만 받으려면 그 IP | `0.0.0.0` |
| **`SERVER_PORT`** | 서비스 포트. **Node.js와 다른 포트** 사용 (relay 41001, dashboard 8080) | `8458` |
| `USERS_FILE` | 계정 파일(Node 무관, 비번 해시 저장) | `data\users.json` |
| `AUDIT_FILE` | 변경이력 로그(JSON 라인) | `data\audit.jsonl` |
| `PAGE_SIZE` | 페이지당 건수 | `50` |

환경변수로도 지정 가능: `set HOST_DATA_FILE=D:\was\data\hosts.json` 등.

> **JSON 경로 공유**: `relayServer/clients/hanwhalife/adapter.js` 도 같은 기본값
> (`<repo>\hostRegistry\data\hosts.json`)을 읽습니다. 경로를 바꾸려면 **Flask 환경변수와
> `relayServer\.env` 양쪽에 같은 `HOST_DATA_FILE`** 을 지정하세요.

> JSON과 WAS가 **같은 머신·같은 볼륨**이어야 원자적 교체가 보장됩니다(이미 그렇게 구성).
> 기존 5필드 JSON 파일이 있으면, 첫 기동 시 `DAY/NIGHT/keyword`를 기본값으로 자동 보정합니다.

---

## 4. 실행

```bat
:: 개발/테스트
venv\Scripts\python app.py

:: 운영 (waitress)
venv\Scripts\python run_server.py
```
접속: `http://서버IP:8458`  (방화벽 인바운드 허용 필요)

---

## 5. 윈도우 서비스 등록 (재부팅 자동기동) — NSSM

```bat
nssm install HostRegistry "C:\app\host-registry\venv\Scripts\python.exe" "C:\app\host-registry\run_server.py"
nssm set HostRegistry AppDirectory "C:\app\host-registry"
nssm start HostRegistry
```

---

## 6. 최초 로그인 / 권한

- 기본 관리자: **admin / admin** (로그인 후 상단 배너에서 비밀번호 변경 권장)
- [계정관리]에서 사용자 추가·권한변경·비번초기화·삭제

| 권한 | 가능 작업 |
|------|----------|
| 관리자(admin) | 서버·수신 규칙 등록·수정·삭제, 일괄등록(import), 규칙 일괄적용, 내보내기, 계정관리 |
| 조회(viewer) | 서버등록/규칙 일괄적용 화면 **조회**, 내보내기(export)만 (수정·추가 불가) |

---

## 7. 메뉴별 동작 요약

**서버등록 / 서버추가·수정**: 호스트네임은 대소문자 무시 고유키, 호스트네임·IP 중복은 거부(IP 는 서버에서도 형식 검사).
서버마다 **수신 규칙**을 여러 개 등록합니다. 규칙 = 규칙명 + metric 조건(자동완성: `data/metric_catalog.txt`) +
memo 키워드(선택) + 주간/야간 + 등급 무관 여부 + 담당자 목록(↑↓ 로 순서 변경). 같은 이름의 담당자가 다른 번호로
등록돼 있으면 경고 후 확인 저장. 검색은 호스트네임/IP/부서/담당자/번호/규칙명/metric 으로 가능, 50건 페이지네이션.

**일괄등록(import)**: **한 행 = 서버 × 규칙 × 담당자.**
헤더 필수 `hostname,ip,department,name,phone` + 선택 `rule_name,metrics,keywords,any_level,DAY,NIGHT,contact_seq`.
metrics/keywords 는 `;` 구분, rule_name 없으면 '기본', contact_seq 로 정(1)·부(2…) 순서.
파일에 있는 서버는 **규칙 전체를 파일 내용으로 교체**(없는 열은 같은 이름 기존 규칙 값 유지), 한 서버의 행 중 하나라도
오류면 그 서버는 반영 안 함. 이전 형식(규칙 열 없는 파일)도 그대로 올릴 수 있습니다.
⚠ **엑셀에서 핸드폰 앞 0이 사라지지 않게 열을 "텍스트" 서식으로 하거나 하이픈 포함 입력.**

**규칙 일괄적용**: 검색 + 체크박스로 서버 선택(또는 검색결과 전체) → 같은 규칙을 **추가/교체**(같은 이름이 있으면 교체)
하거나 규칙명으로 **삭제**(서버의 마지막 규칙은 삭제 안 함). 예: 모든 DB 서버에 'DBA' 규칙 한 번에 추가.

**내보내기(export)**: 현재 조회 조건에 맞는 전체를 일괄등록과 **같은 형식**(CSV UTF-8 BOM / Excel)으로.
내보낸 파일을 수정해 그대로 다시 올릴 수 있습니다.

관리자 [변경이력] 메뉴에서 시간·접속IP·계정·작업·대상과 [상세] 버튼으로 변경 전/후 규칙을 확인할 수 있습니다.

## 8. 백업

`data\`(또는 `HOST_DATA_FILE`,`USERS_FILE`) 폴더를 주기적으로 백업하세요.
쓰기가 원자적이라 중간 손상 가능성은 낮지만 정기 백업은 별도 권장합니다.
