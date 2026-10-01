// hosts.json(hostRegistry 가 관리) → 이벤트별 발신 체인 계산
// - 한 이벤트에 매칭되는 규칙마다 체인 1개 (체인끼리는 동시 발신)
// - 체인 안 contacts 순서 = 정담당 → 부담당 → ...
// DB 접근 없음 (순수 함수) — 고객사 adapter 가 가져다 씀

const LOG_SUFFIX_RE = /\s*이벤트\s*탐지\s*$/;

/* 관제 metric 정규화: 앞뒤 공백 제거 + 끝의 ' 이벤트 탐지' 제거
   (같은 감시항목이 'X' / 'X 이벤트 탐지' 두 형태로 들어옴) */
export function normalizeMetric(metric) {
    return String(metric ?? '').trim().replace(LOG_SUFFIX_RE, '').trim();
}

/* 패턴 문법: '*' 만 와일드카드, 나머지는 글자 그대로 (대소문자 무시)
   metric 에 '.*httpd.*', '[YYYY]' 같은 특수문자가 그대로 들어있어 정규식/LIKE 로 쓰면 안 됨 */
export function compilePattern(pattern) {
    const p = normalizeMetric(pattern);
    if (p === '' || p === '*') return null;   // null = 전체
    const body = p.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
    return new RegExp(`^${body}$`, 'i');
}

const isCatchAllMetrics = metrics => metrics.length === 0 || metrics.every(m => compilePattern(m) === null);

function toList(v) {
    if (Array.isArray(v)) return v.map(x => String(x).trim()).filter(Boolean);
    if (typeof v === 'string') return v.split(/[;\n]/).map(x => x.trim()).filter(Boolean);
    return [];
}

const yn = v => (String(v ?? '').trim().toUpperCase() === 'Y' ? 'Y' : 'N');

/* 기존(규칙 없는) 레코드도 받아줌: 서버당 '기본' 규칙 1개로 변환
   기존 동작 그대로 — keyword 가 있으면 memo 키워드 조건 + 등급 무관, 없으면 심각만 */
export function normalizeHost(raw) {
    const host = {
        hostname:   String(raw.hostname ?? '').trim(),
        ip:         String(raw.ip ?? '').trim(),
        department: String(raw.department ?? '').trim(),
        rules:      [],
    };

    const rawRules = Array.isArray(raw.rules)
        ? raw.rules
        : [{
            id: 'default', name: '기본', metrics: ['*'],
            keywords: raw.keyword, any_level: toList(raw.keyword).length ? 'Y' : 'N',
            DAY: raw.DAY, NIGHT: raw.NIGHT,
            contacts: raw.phone ? [{ name: raw.name, phone: raw.phone }] : [],
        }];

    rawRules.forEach((r, i) => {
        const keywords = toList(r.keywords ?? r.keyword);
        const metrics  = toList(r.metrics);
        const contacts = (Array.isArray(r.contacts) ? r.contacts : [])
            .map(c => ({ name: String(c.name ?? '').trim(), phone: String(c.phone ?? '').replace(/\D/g, '') }))
            .filter(c => c.phone);
        if (contacts.length === 0) return;
        host.rules.push({
            id:        String(r.id ?? `r${i + 1}`),
            name:      String(r.name ?? `규칙${i + 1}`).trim(),
            metrics:   metrics.length ? metrics : ['*'],
            matchers:  (metrics.length ? metrics : ['*']).map(compilePattern),
            keywords,
            any_level: keywords.length ? 'Y' : yn(r.any_level),
            DAY:       yn(r.DAY),
            NIGHT:     yn(r.NIGHT),
            contacts,
            catchAll:  isCatchAllMetrics(metrics) && keywords.length === 0,
        });
    });
    return host;
}

export function buildHostIndex(configList) {
    const index = new Map();
    for (const raw of configList ?? []) {
        const host = normalizeHost(raw);
        if (host.hostname && host.rules.length) index.set(host.hostname.toLowerCase(), host);
    }
    return index;
}

/**
 * 이벤트 1건 → 발신할 규칙 목록
 * @param event { hostname, metric, memo, event_cd, sys_id, created_hour }
 * @param opts  { severity, logSysId, dayStart, dayEnd }
 *
 * 1) 우선순위: metric 지정 규칙 / memo 키워드 규칙 (catch-all 이 아닌 규칙) — 매칭되는 것 전부
 * 2) 1)에서 발신할 규칙이 하나도 없으면 catch-all('*') 규칙
 * 공통 조건: 주간/야간(이벤트 발생 시각 기준), 등급(any_level=N 이면 severity 만)
 * catch-all 규칙은 기존과 같이 로그 감시(sys_id=logSysId) 이벤트를 제외
 */
export function matchRules(host, event, opts) {
    const metric   = normalizeMetric(event.metric);
    const memo     = String(event.memo ?? '').toLowerCase();
    const isDay    = event.created_hour >= opts.dayStart && event.created_hour < opts.dayEnd;
    const isLogEvt = opts.logSysId && String(event.sys_id ?? '').trim() === opts.logSysId;

    const timeOk  = r => (isDay ? r.DAY === 'Y' : r.NIGHT === 'Y');
    const levelOk = r => r.any_level === 'Y' || String(event.event_cd ?? '').trim() === opts.severity;
    const kwOk    = r => r.keywords.length === 0 || r.keywords.some(k => memo.includes(k.toLowerCase()));
    const metricOk = r => r.matchers.some(m => m === null || m.test(metric));

    const specific = host.rules.filter(r => !r.catchAll && metricOk(r) && kwOk(r) && timeOk(r) && levelOk(r));
    if (specific.length) return specific;

    if (isLogEvt) return [];
    return host.rules.filter(r => r.catchAll && timeOk(r) && levelOk(r));
}
