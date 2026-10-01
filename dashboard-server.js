import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import sql from 'mssql';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 8080;

function buildWhere(searchParams, request) {
    const conditions = ['1=1'];
    const phone  = searchParams.get('phone');
    const status = searchParams.get('status');
    const date   = searchParams.get('date');
    const host   = searchParams.get('host');

    if (phone)  { request.input('phone',  sql.VarChar, `%${phone}%`);  conditions.push('phone LIKE @phone'); }
    if (status) { request.input('status', sql.VarChar, status);         conditions.push('status = @status'); }
    if (date)   { request.input('date',   sql.VarChar, date);           conditions.push('CAST(created_dt AS DATE) = @date'); }
    if (host)   { request.input('host',   sql.VarChar, `%${host}%`);   conditions.push('hostname LIKE @host'); }

    return conditions.join(' AND ');
}

export function startDashboard(pool) {
    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, `http://localhost`);
        const pathname = url.pathname;

        const json = (data, statusCode = 200) => {
            res.writeHead(statusCode, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            });
            res.end(JSON.stringify(data));
        };

        try {
            // 정적 파일 서빙
            if (pathname === '/' || pathname === '/index.html') {
                const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                return res.end(html);
            }

            // 오늘 통계
            if (pathname === '/api/stats/today') {
                const result = await pool.request().query(`
                    SELECT
                        COUNT(*) AS total,
                        SUM(CASE WHEN status = 'processed'  THEN 1 ELSE 0 END) AS success,
                        SUM(CASE WHEN status = 'failed'     THEN 1 ELSE 0 END) AS failed,
                        SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS inProgress
                    FROM IVROWN.outbound_queue
                    WHERE CAST(created_dt AS DATE) = CAST(GETDATE() AS DATE)
                `);
                return json(result.recordset[0]);
            }

            // 최근 30일 일별 통계
            if (pathname === '/api/stats/daily') {
                const result = await pool.request().query(`
                    SELECT
                        CONVERT(varchar(10), created_dt, 23) AS date,
                        COUNT(*) AS total,
                        SUM(CASE WHEN status = 'processed' THEN 1 ELSE 0 END) AS success,
                        SUM(CASE WHEN status = 'failed'    THEN 1 ELSE 0 END) AS failed
                    FROM IVROWN.outbound_queue
                    WHERE created_dt >= DATEADD(DAY, -29, CAST(GETDATE() AS DATE))
                    GROUP BY CONVERT(varchar(10), created_dt, 23)
                    ORDER BY date ASC
                `);
                return json(result.recordset);
            }

            // 발신 이력 (필터 + 페이지네이션)
            if (pathname === '/api/calls') {
                const page   = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
                const limit  = 50;
                const offset = (page - 1) * limit;

                const req1 = pool.request();
                const whereClause = buildWhere(url.searchParams, req1);
                req1.input('limit',  sql.Int, limit);
                req1.input('offset', sql.Int, offset);

                const result = await req1.query(`
                    SELECT
                        id, phone, hostname, prc_id, sys_id, status,
                        retry_count, created_dt, processed_dt, completed_dt
                    FROM IVROWN.outbound_queue
                    WHERE ${whereClause}
                    ORDER BY created_dt DESC
                    OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY
                `);

                const req2 = pool.request();
                buildWhere(url.searchParams, req2);
                const countResult = await req2.query(`
                    SELECT COUNT(*) AS total FROM IVROWN.outbound_queue WHERE ${whereClause}
                `);

                const total = countResult.recordset[0].total;
                return json({ data: result.recordset, total, page, limit, totalPages: Math.ceil(total / limit) });
            }

            // 특정 ANI 전체 이력
            if (pathname.startsWith('/api/calls/ani/')) {
                const phone = decodeURIComponent(pathname.replace('/api/calls/ani/', ''));
                const result = await pool.request()
                    .input('phone', sql.VarChar, phone)
                    .query(`
                        SELECT
                            id, phone, hostname, prc_id, sys_id, status,
                            retry_count, created_dt, processed_dt, completed_dt
                        FROM IVROWN.outbound_queue
                        WHERE phone = @phone
                        ORDER BY created_dt DESC
                    `);
                return json(result.recordset);
            }

            // 에러(실패) 목록
            if (pathname === '/api/errors') {
                const days = Math.min(30, parseInt(url.searchParams.get('days') || '7'));
                const result = await pool.request()
                    .input('days', sql.Int, days)
                    .query(`
                        SELECT TOP 200
                            id, phone, hostname, prc_id, sys_id, status,
                            retry_count, created_dt, processed_dt, completed_dt
                        FROM IVROWN.outbound_queue
                        WHERE status = 'failed'
                            AND created_dt >= DATEADD(DAY, -@days, GETDATE())
                        ORDER BY processed_dt DESC
                    `);
                return json(result.recordset);
            }

            json({ error: 'Not found' }, 404);

        } catch (err) {
            json({ error: err.message }, 500);
        }
    });

    server.listen(DASHBOARD_PORT, () => {
        console.log(`[DASHBOARD] 대시보드 서버 시작 - http://localhost:${DASHBOARD_PORT}`);
    });
}
