# 서버 연락처 / 모니터링 패턴 등록 시스템 — 구축 가이드

WAS 서버의 Node.js가 읽는 JSON 파일에 **서버 정보(호스트네임/IP/부서/이름/핸드폰 + 주간/야간)** 와
**모니터링 패턴(keyword)** 을 등록·관리하는 내부 웹 도구입니다. Node.js는 이 JSON을 **읽기만** 합니다.

- Python 3.13 / Flask / waitress / openpyxl  (외부 폰트·CDN 미사용 = 폐쇄망 OK)
- 로그인 + 권한: **admin**(전체) / **viewer**(조회·export만)
- 쓰기는 **락 + 원자적 교체(temp→os.replace)** 로 안전하게 처리

저장되는 레코드 형태 (Node 계약):
```json
{"hostname":"SCC-IVR01","ip":"1.1.1.1","department":"금융운영팀","name":"이찬행","phone":"01012345678","DAY":"Y","NIGHT":"N","keyword":["error","timeout"]}
```

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
| **`HOST_DATA_FILE`** | **[필수] Node.js가 읽는 JSON 경로.** WAS 로컬 경로로 변경 | `r"D:\was\data\hosts.json"` |
| **`SERVER_HOST`** | 바인딩 IP. `0.0.0.0`=모든 NIC, 특정 IP만 받으려면 그 IP | `0.0.0.0` |
| **`SERVER_PORT`** | 서비스 포트. **Node.js와 다른 포트** 사용 | `8080` |
| `USERS_FILE` | 계정 파일(Node 무관, 비번 해시 저장) | `data\users.json` |
| `AUDIT_FILE` | 변경이력 로그(JSON 라인) | `data\audit.jsonl` |
| `PAGE_SIZE` | 페이지당 건수 | `50` |

환경변수로도 지정 가능: `set HOST_DATA_FILE=D:\was\data\hosts.json` 등.

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
접속: `http://서버IP:8080`  (방화벽 인바운드 허용 필요)

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
| 관리자(admin) | 서버 수기등록·수정·삭제, 일괄등록(import), 모니터링 패턴 등록·삭제, 내보내기, 계정관리 |
| 조회(viewer) | 서버등록/모니터링 화면 **조회**, 내보내기(export)만 (수정·추가 불가) |

---

## 7. 메뉴별 동작 요약

**서버등록**: 호스트네임은 대소문자 무시 고유키(신규 중복은 거부, 수정은 허용). 핸드폰은 두 형식 입력
가능하나 숫자만(010+11자리) 저장. 주간/야간은 체크박스(Y/N, 둘 다 선택/해제 가능). 같은 부서+이름에
다른 번호가 있으면 경고 후 확인 등록(동명이인/번호변경 대비). 50건 페이지네이션.

**일괄등록(import)**: 헤더 필수 `hostname,ip,department,name,phone` + 선택 `DAY,NIGHT`(Y/N).
헤더 대소문자 무관. 기존 호스트네임은 갱신(upsert), 파일 내 중복·형식오류 행은 거부 후 리포트.
**keyword 열은 무시**되며 기존 패턴은 보존됨. CSV는 UTF-8/CP949 자동 인식.
⚠ **엑셀에서 핸드폰 앞 0이 사라지지 않게 열을 "텍스트" 서식으로 하거나 하이픈 포함 입력.**

**모니터링등록**: 셀렉트박스(필드) + LIKE 검색. 좌측 체크박스로 일괄/부분 선택 →
"패턴 등록하기" 버튼으로 모달에서 **선택 서버 전체에 패턴 추가**(중복 자동 무시) 및
**서버별 기존 패턴 줄별 삭제**. keyword는 배열로 저장. 50건 페이지네이션.

**내보내기(export)**: 두 화면 모두 **현재 조회 조건에 맞는 전체**(페이지 무관)를 CSV(UTF-8 BOM)/Excel로.
조건 없으면 전 서버. keyword는 셀 안에서 세미콜론(;)으로 직렬화되어 출력됩니다.

---


**추가 기능 (UI/UX)**: 목록·모니터링 화면은 헤더 클릭 정렬(▲▼) + 헤더 고정, 서버등록 화면 상단에 전체/패턴/주간/야간 요약 바를 제공합니다. 서버 추가·수정 시 **호스트네임 또는 IP가 기존과 중복되면 거부**하며(일괄등록 포함, 파일 내 중복도 거부), IP·전화번호는 입력 즉시 형식이 확인됩니다. 부서·이름은 기존 값 자동완성(datalist)을 제공합니다. 모니터링 화면에서는 "패턴 전체/있음/없음" 필터와 "검색결과 전체에 패턴 적용"이 가능합니다. 관리자 [변경이력] 메뉴에서 시간·접속IP·계정·작업·대상과 [상세] 버튼으로 변경 내용을 확인할 수 있습니다(변경이력은 admin 전용, viewer는 조회 화면만 열람 가능).

## 8. 백업

`data\`(또는 `HOST_DATA_FILE`,`USERS_FILE`) 폴더를 주기적으로 백업하세요.
쓰기가 원자적이라 중간 손상 가능성은 낮지만 정기 백업은 별도 권장합니다.
