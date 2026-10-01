import http from 'http';
import sql from 'mssql';
import { settings } from './core/settings.js';

// 발신 현황 API (JSON 전용)
// 화면은 hostRegistry 웹(8458)의 [현황] 메뉴가 같은 서버에서 이 API 를 프록시로 호출해서 그림
// DB 접속 정보는 relayServer/.env 한 곳에만 둠. 기본 127.0.0.1 바인딩(외부 노출 안 함)

// 이벤트(outbound_queue) 단위 상태
//   pending 배정 대기 / dispatched 발신 진행 / processed 성공 / partial 일부 수신 / failed 실패 / no_route 대상 없음
// 발신(outbound_call) 단위 상태
//   standby / pending / processing / retry_wait / answered / exhausted / cancelled

const PAGE_SIZE = 50;

function eventWhere(sp, request) {
    const cond = ['1=1'];
    const status = sp.get('status');
    const date   = sp.get('date');
    const host   = sp.get('host');
    const metric = sp.get('metric');
    if (status) { request.input('status', sql.VarChar, status);         cond.push('q.status = @status'); }
    if (date)   { request.input('date',   sql.VarChar, date);           cond.push('CAST(q.created_dt AS DATE) = @date'); }
    if (host)   { request.input('host',   sql.NVarChar, `%${host}%`);   cond.push('q.hostname LIKE @host'); }
    if (metric) { request.input('metric', sql.NVarChar, `%${metric}%`); cond.push('q.metric LIKE @metric'); }
    return cond.join(' AND ');
}

function callWhere(sp, request) {
    const cond = ['1=1'];
    const status = sp.get('status');
    const date   = sp.get('date');
    const host   = sp.get('host');
    const phone  = sp.get('phone');
    const name   = sp.get('name');
    if (status) { request.input('status', sql.VarChar, status);         cond.push('c.status = @status'); }
    if (date)   { request.input('date',   sql.VarChar, date);           cond.push('CAST(c.created_dt AS DATE) = @date'); }
    if (host)   { request.input('host',   sql.NVarChar, `%${host}%`);   cond.push('c.hostname LIKE @host'); }
    if (phone)  { request.input('phone',  sql.VarChar, `%${phone.replace(/\D/g, '')}%`); cond.push('c.phone LIKE @phone'); }
    if (name)   { request.input('name',   sql.NVarChar, `%${name}%`);   cond.push('c.contact_name LIKE @name'); }
    return cond.join(' AND ');
}

const pageOf = sp => Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);

export function startDashboard(pool) {
    const host = settings.statusApiHost;
    const port = settings.statusApiPort;

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost`);
        const pathname = url.pathname;
        const sp = url.searchParams;

        const json = (data, statusCode = 200) => {
            res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(data));
        };

        try {
            // 오늘 요약: 이벤트 결과 + 발신 건/시도 수
            if (pathname === '/api/stats/today') {
                const result = await pool.request().query(`
                    SELECT
                        COUNT(*) AS events,
                        SUM(CASE WHEN status = 'processed'  THEN 1 ELSE 0 END) AS processed,
                        SUM(CASE WHEN status = 'partial'    THEN 1 ELSE 0 END) AS partial,
                        SUM(CASE WHEN status = 'failed'     THEN 1 ELSE 0 END) AS failed,
                        SUM(CASE WHEN status IN ('pending','dispatched','processing') THEN 1 ELSE 0 END) AS inProgress,
                        SUM(CASE WHEN status = 'no_route'   THEN 1 ELSE 0 END) AS noRoute
                    FROM IVROWN.outbound_queue
                    WHERE created_dt >= CAST(GETDATE() AS DATE);

                    SELECT
                        COUNT(*) AS calls,
                        SUM(CASE WHEN status = 'answered'  THEN 1 ELSE 0 END) AS answered,
                        SUM(CASE WHEN status = 'exhausted' THEN 1 ELSE 0 END) AS exhausted,
                        SUM(CASE WHEN status IN ('pending','processing','retry_wait') THEN 1 ELSE 0 END) AS active,
                        ISNULL(SUM(attempt_count), 0) AS attempts
                    FROM IVROWN.outbound_call
                    WHERE created_dt >= CAST(GETDATE() AS DATE);
                `);
                return json({ ...result.recordsets[0][0], ...result.recordsets[1][0] });
            }

            // 최근 30일 일별 이벤트 결과
            if (pathname === '/api/stats/daily') {
                const result = await pool.request().query(`
                    SELECT
                        CONVERT(varchar(10), created_dt, 23) AS date,
                        COUNT(*) AS total,
                        SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) AS processed,
                        SUM(CASE WHEN status = 'partial'   THEN 1 ELSE 0 END) AS partial,
                        SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed,
                        SUM(CASE WHEN status = 'no_route'  THEN 1 ELSE 0 END) AS noRoute
                    FROM IVROWN.outbound_queue
                    WHERE created_dt >= DATEADD(DAY, -29, CAST(GETDATE() AS DATE))
                    GROUP BY CONVERT(varchar(10), created_dt, 23)
                    ORDER BY date ASC
                `);
                return json(result.recordset);
            }

            // 이벤트 목록 (필터 + 페이지네이션) — 이벤트별 발신 요약 포함
            if (pathname === '/api/events') {
                const page = pageOf(sp);
                const r1 = pool.request();
                const where = eventWhere(sp, r1);
                r1.input('offset', sql.Int, (page - 1) * PAGE_SIZE);
                r1.input('limit',  sql.Int, PAGE_SIZE);
                const rows = await r1.query(`
                    SELECT q.event_id, q.hostname, q.metric, q.metric_value, q.event_cd, q.sys_id, q.prc_id,
                           q.status, q.chain_count, q.created_dt, q.dispatched_dt, q.completed_dt,
                           s.calls, s.answered, s.attempts, s.contacts
                    FROM IVROWN.outbound_queue q
                    OUTER APPLY (
                        SELECT COUNT(*) AS calls,
                               SUM(CASE WHEN c.status = 'answered' THEN 1 ELSE 0 END) AS answered,
                               SUM(c.attempt_count) AS attempts,
                               STUFF((SELECT ', ' + ISNULL(c2.contact_name, c2.phone) + ':' + c2.status
                                      FROM IVROWN.outbound_call c2
                                      WHERE c2.event_id = q.event_id AND c2.status <> 'standby'
                                      ORDER BY c2.chain_no, c2.contact_seq
                                      FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 2, '') AS contacts
                        FROM IVROWN.outbound_call c
                        WHERE c.event_id = q.event_id
                    ) s
                    WHERE ${where}
                    ORDER BY q.created_dt DESC
                    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
                `);
                const r2 = pool.request();
                eventWhere(sp, r2);
                const cnt = await r2.query(`SELECT COUNT(*) AS total FROM IVROWN.outbound_queue q WHERE ${where}`);
                const total = cnt.recordset[0].total;
                return json({ data: rows.recordset, total, page, limit: PAGE_SIZE, totalPages: Math.ceil(total / PAGE_SIZE) });
            }

            // 이벤트 상세: 체인/담당자별 발신 + 시도 이력
            const evMatch = pathname.match(/^\/api\/events\/(\d+)$/);
            if (evMatch) {
                const result = await pool.request()
                    .input('event_id', sql.Int, Number(evMatch[1]))
                    .query(`
                        SELECT TOP 1 event_id, hostname, metric, metric_value, event_cd, sys_id, sys_ip, prc_id, memo,
                               status, chain_count, created_dt, dispatched_dt, completed_dt
                        FROM IVROWN.outbound_queue WHERE event_id = @event_id;

                        SELECT call_id, rule_name, chain_no, contact_seq, contact_name, phone, status,
                               attempt_count, max_attempts, next_attempt_dt, last_attempt_dt, completed_dt
                        FROM IVROWN.outbound_call WHERE event_id = @event_id
                        ORDER BY chain_no, contact_seq;

                        SELECT a.call_id, a.attempt_no, a.phone, a.started_dt, a.ended_dt, a.result, a.bundle_id
                        FROM IVROWN.outbound_call_attempt a
                        JOIN IVROWN.outbound_call c ON c.call_id = a.call_id
                        WHERE c.event_id = @event_id
                        ORDER BY a.started_dt, a.attempt_id;
                    `);
                const [ev, calls, attempts] = result.recordsets;
                if (!ev[0]) return json({ error: 'Not found' }, 404);
                return json({ event: ev[0], calls, attempts });
            }

            // 발신 이력: 누구에게 / 어떤 번호로 / 어떤 이벤트에 대해 / 결과
            if (pathname === '/api/calls') {
                const page = pageOf(sp);
                const r1 = pool.request();
                const where = callWhere(sp, r1);
                r1.input('offset', sql.Int, (page - 1) * PAGE_SIZE);
                r1.input('limit',  sql.Int, PAGE_SIZE);
                const rows = await r1.query(`
                    SELECT c.call_id, c.event_id, c.hostname, c.metric, q.metric_value, q.event_cd, q.prc_id,
                           c.rule_name, c.chain_no, c.contact_seq, c.contact_name, c.phone,
                           c.status, c.attempt_count, c.max_attempts,
                           c.created_dt, c.last_attempt_dt, c.next_attempt_dt, c.completed_dt,
                           q.status AS event_status
                    FROM IVROWN.outbound_call c
                    JOIN IVROWN.outbound_queue q ON q.event_id = c.event_id
                    WHERE ${where}
                    ORDER BY c.created_dt DESC, c.chain_no, c.contact_seq
                    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
                `);
                const r2 = pool.request();
                callWhere(sp, r2);
                const cnt = await r2.query(`SELECT COUNT(*) AS total FROM IVROWN.outbound_call c WHERE ${where}`);
                const total = cnt.recordset[0].total;
                return json({ data: rows.recordset, total, page, limit: PAGE_SIZE, totalPages: Math.ceil(total / PAGE_SIZE) });
            }

            json({ error: 'Not found' }, 404);

        } catch (err) {
            json({ error: err.message }, 500);
        }
    });

    server.listen(port, host, () => {
        console.log(`[STATUS API] 발신 현황 API 시작 - http://${host}:${port} (화면: hostRegistry 웹 [현황])`);
    });
    return server;
}
