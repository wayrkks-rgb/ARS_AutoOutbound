// 운영 설정 (relayServer/.env 로 재정의)
// index.js 에서 dotenv.config() 가 import 이후에 실행되므로, 값은 항상 호출 시점에 읽는다
const num = (key, def) => {
    const v = Number(process.env[key]);
    return Number.isFinite(v) && process.env[key] !== '' ? v : def;
};
const str = (key, def) => (process.env[key] ?? '').trim() || def;

export const settings = {
    // 같은 담당자 재발신 간격 / 다음 담당자(부담당)로 넘어갈 때 대기 (초)
    get retryIntervalSec()  { return num('RETRY_INTERVAL_SEC', 60); },
    get escalateDelaySec()  { return num('ESCALATE_DELAY_SEC', 60); },
    // IVR 콜백($event-id$) 으로 통화를 식별하는 키
    //   call_id (기본) : check-event 응답의 event_id 필드에 call_id 를 담아 보냄 → IVR 은 그대로 돌려줌(시나리오 수정 불필요)
    //                    같은 이벤트의 여러 담당자도 동시 발신
    //   event_id       : 실제 event_id 를 보냄. 같은 이벤트는 한 번에 1통화씩
    get callbackKey()       { return str('IVR_CALLBACK_KEY', 'call_id') === 'event_id' ? 'event_id' : 'call_id'; },
    // 등급 무관(any_level) 이 아닌 규칙은 이 event_cd 만 발신
    get severity()          { return str('SEVERITY_LEVEL', '심각'); },
    // catch-all('*') 규칙에서 제외할 로그 감시 sys_id (기존 필터 유지)
    get logSysId()          { return str('LOG_SYS_ID', '시스템 로그 감시'); },
    // 이 시간 이내에 발생한 이벤트만 배정
    get eventWindowHours()  { return num('EVENT_WINDOW_HOURS', 3); },
    // 주간 시간대 [dayStart, dayEnd)
    get dayStart()          { return num('DAY_START_HOUR', 9); },
    get dayEnd()            { return num('DAY_END_HOUR', 18); },
    // IVR 결과가 이 시간(분) 안에 안 오면 미응답(timeout) 처리
    get recoverTimeoutMin() { return num('RECOVER_TIMEOUT_MIN', 10); },
    // 폴링 1회에 배정할 최대 이벤트 수
    get dispatchBatch()     { return num('DISPATCH_BATCH', 100); },
    // 현황 API (hostRegistry 웹이 같은 서버에서 프록시로 호출) — 외부 노출 안 함
    get statusApiHost()     { return str('DASHBOARD_HOST', '127.0.0.1'); },
    get statusApiPort()     { return num('DASHBOARD_PORT', 8080); },
};
