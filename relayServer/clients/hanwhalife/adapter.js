import sql from 'mssql';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AdapterBase } from '../AdapterBase.js';
import { all } from 'axios';
import { logger } from '../../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

class HanwhaLifeAdapter extends AdapterBase {

    getConfigList() {
        try {
            const content = fs.readFileSync('C:\\TEMP\\모니터링자동발신시스템구축\\hosts.json', 'utf-8');
            return JSON.parse(content);
        } catch (err) {
            console.error('[SCC] 설정 파일 로드 에러:', err.message);
            return [];
        }
    }

    async fetchAndLock(request, { config, vacancy }) {
        const targetAni = config.phone;
        const hostServer = config.hostname;
        const keywords = Array.isArray(config.keyword) ? config.keyword : [];
        const fetchLimit = vacancy * 3;
        const nowHour = new Date().getHours(); // 현재 시각
        const isDayTime = nowHour >= 9 && nowHour < 18;

        const allowDay = config.DAY == 'Y';
        const allowNight = config.NIGHT == 'Y';

        request.input('host', hostServer);
        request.input('ani', targetAni);
        request.input('fetchLimit', fetchLimit);

        if (isDayTime && !allowDay) {
            logger.info(`[POLLKING SKIP] 호스트 : ${hostServer} - 주간 미지원으로 스킵 | 담당자: ${targetAni} 미발송 `);
            return;
        }

        if (!isDayTime && !allowNight) {
            logger.info(`[POLLKING SKIP] 호스트 : ${hostServer} - 야간 미지원으로 스킵 | 담당자: ${targetAni} 미발송`);
            return;
        }


        let filterSubQuery;
        if (keywords.length > 0) {
            const clauses = [];
            keywords.forEach((word, index) => {
                const paramName = `keyword_${index}`;
                request.input(paramName, `%${word}%`);
                clauses.push(`memo LIKE @${paramName}`);
            });
            filterSubQuery = `AND (${clauses.join(' OR ')})`;
        } else {
            filterSubQuery = `AND event_cd = '심각' AND sys_id <> '시스템 로그 감시'`;
        }

        let timeZoneQuery = '';
        if (isDayTime) {
            timeZoneQuery = `AND DATEPART(HOUR, created_dt) >= 9 AND DATEPART(HOUR, created_dt) < 18`;
        } else {
            timeZoneQuery = `AND (DATEPART(HOUR, created_dt) >= 18 OR DATEPART(HOUR, created_dt) < 9)`;
        }
        // keyword 뺀 임시로직 - 나중에 제거
        const result = await request.query(`
                WITH TargetCall as (
                    SELECT TOP (@fetchLimit) *
                    FROM IVROWN.outbound_queue
                    WHERE hostname = @host
                        AND phone is NULL
                        AND (status = 'pending' or (status = 'failed' and retry_count < 2))
                        AND created_dt >= DATEADD(HOUR, -3, GETDATE())
                        ${filterSubQuery}
                        ${timeZoneQuery}
                    ORDER BY created_dt ASC
                )
                UPDATE TargetCall
                SET phone = @ani,
                    status = 'processing',
                    processed_dt = GETDATE()
                OUTPUT  INSERTED.id, 
                        INSERTED.event_id, 
                        INSERTED.phone, 
                        INSERTED.status, 
                        INSERTED.sys_id, 
                        INSERTED.sys_ip, 
                        INSERTED.prc_id, 
                        INSERTED.event_cd, 
                        INSERTED.memo, 
                        INSERTED.retry_count, 
                        INSERTED.channel_id, 
                        INSERTED.env, 
                        INSERTED.hostname, 
                        INSERTED.metric, 
                        INSERTED.metric_value, 
                        INSERTED.created_dt;
            `);

        return result.recordset.map(row => this.normalizeRecord(row));
    }

    async markDone(pool, targetIds) {
        const request = pool.request();
        const params = targetIds.map((id, i) => {
            request.input(`id_${i}`, sql.Int, id);
            return `@id_${i}`;
        });
        return request.query(`
            UPDATE IVROWN.outbound_queue
            SET status       = 'processed',
                completed_dt = GETDATE()
            WHERE event_id IN (${params.join(', ')})
        `);
    }

    async markFailed(pool, evtId) {
        const result = await pool.request()
            .input('id', sql.Int, evtId)
            .query(`
                UPDATE IVROWN.outbound_queue
                SET status       = 'failed',
                    retry_count  = retry_count + 1,
                    processed_dt = GETDATE()
                WHERE event_id = @id;

                SELECT retry_count FROM IVROWN.outbound_queue WHERE event_id = @id;
            `);

        return result.recordset[0]?.retry_count;
    }

    processMemo(rawMemo) {
        return /\.\w+$/.test(rawMemo.trim())
            ? '로그 에러가 발생하였습니다'
            : rawMemo;
    }

    normalizeRecord(row) {
        return {
            id: row.id,
            hostname: row.hostname,
            phone: row.phone,
            status: row.status,
            prc_id: row.prc_id,
            sys_id: row.sys_id,
            sys_ip: row.sys_ip,
            memo: row.memo,
            event_id: row.event_id,
            created_dt: row.created_dt,
            retry_count: row.retry_count,
        };
    }
}

export const adapter = new HanwhaLifeAdapter();
