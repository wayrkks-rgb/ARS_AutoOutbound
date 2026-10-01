import sql from 'mssql';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { AdapterBase } from '../AdapterBase.js';
import { buildHostIndex, matchRules } from '../../core/Router.js';
import { settings } from '../../core/settings.js';
import { logger } from '../../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// hostRegistry(Flask)가 기록하는 hosts.json 을 그대로 읽음 (Node 는 읽기 전용)
// 기본값: <repo>/hostRegistry/data/hosts.json — 운영에서 위치를 바꾸면 양쪽 모두 HOST_DATA_FILE 로 동일하게 지정
const DEFAULT_HOST_DATA_FILE = path.resolve(__dirname, '../../../hostRegistry/data/hosts.json');

class HanwhaLifeAdapter extends AdapterBase {

    getConfigList() {
        try {
            const hostDataFile = process.env.HOST_DATA_FILE || DEFAULT_HOST_DATA_FILE;
            const content = fs.readFileSync(hostDataFile, 'utf-8');
            return JSON.parse(content);
        } catch (err) {
            logger.error(`[CONFIG] 설정 파일 로드 에러: ${err.message}`);
            return [];
        }
    }

    // 신규 이벤트(pending) → 규칙 매칭 → outbound_call 생성 (이벤트 단위 트랜잭션)
    async dispatchEvents(pool, configList) {
        const hostIndex = buildHostIndex(configList);
        if (hostIndex.size === 0) return { dispatched: 0, noRoute: 0 };

        const sel = pool.request();
        const hostParams = [...hostIndex.values()].map((h, i) => {
            sel.input(`h${i}`, sql.NVarChar, h.hostname);
            return `@h${i}`;
        });
        sel.input('limit', sql.Int, settings.dispatchBatch);
        sel.input('win',   sql.Int, settings.eventWindowHours);

        const { recordset: events } = await sel.query(`
            SELECT TOP (@limit)
                   event_id, hostname, metric, memo, event_cd, sys_id,
                   DATEPART(HOUR, created_dt) AS created_hour
            FROM IVROWN.outbound_queue
            WHERE status = 'pending'
              AND dispatched_dt IS NULL
              AND created_dt >= DATEADD(HOUR, -@win, GETDATE())
              AND hostname IN (${hostParams.join(', ')})
            ORDER BY created_dt ASC
        `);

        const opts = {
            severity: settings.severity, logSysId: settings.logSysId,
            dayStart: settings.dayStart, dayEnd: settings.dayEnd,
        };
        let dispatched = 0, noRoute = 0;

        for (const ev of events) {
            const host  = hostIndex.get(String(ev.hostname).trim().toLowerCase());
            const rules = host ? matchRules(host, ev, opts) : [];
            const tx = new sql.Transaction(pool);
            await tx.begin();
            try {
                const req = new sql.Request(tx);
                req.input('event_id', sql.Int, ev.event_id);
                req.input('chains',   sql.TinyInt, rules.length);

                // 다른 프로세스가 먼저 가져갔으면(0건) 건너뜀
                const upd = await req.query(`
                    UPDATE IVROWN.outbound_queue
                    SET status        = CASE WHEN @chains = 0 THEN 'no_route' ELSE 'dispatched' END,
                        chain_count   = @chains,
                        dispatched_dt = GETDATE()
                    WHERE event_id = @event_id AND status = 'pending' AND dispatched_dt IS NULL
                `);
                if (upd.rowsAffected[0] === 0) { await tx.rollback(); continue; }

                const values = [];
                const ins = new sql.Request(tx);
                ins.input('event_id', sql.Int, ev.event_id);
                ins.input('hostname', sql.NVarChar, ev.hostname);
                ins.input('metric',   sql.NVarChar, ev.metric ?? null);
                rules.forEach((rule, ci) => {
                    ins.input(`rid${ci}`,   sql.VarChar,  rule.id);
                    ins.input(`rname${ci}`, sql.NVarChar, rule.name);
                    rule.contacts.forEach((c, si) => {
                        const k = `${ci}_${si}`;
                        ins.input(`cn${k}`, sql.NVarChar, c.name || null);
                        ins.input(`ph${k}`, sql.VarChar,  c.phone);
                        values.push(`(@event_id, @hostname, @metric, @rid${ci}, @rname${ci}, ${ci + 1}, ${si + 1}, @cn${k}, @ph${k}, '${si === 0 ? 'pending' : 'standby'}')`);
                    });
                });
                if (values.length) {
                    await ins.query(`
                        INSERT INTO IVROWN.outbound_call
                            (event_id, hostname, metric, rule_id, rule_name, chain_no, contact_seq, contact_name, phone, status)
                        VALUES ${values.join(',\n')}
                    `);
                }
                await tx.commit();
            } catch (err) {
                await tx.rollback().catch(() => {});
                throw err;
            }

            if (rules.length) {
                dispatched++;
                const desc = rules.map(r => `${r.name}(${r.contacts.map(c => c.name || c.phone).join('→')})`).join(', ');
                logger.info(`[배정] event_id: ${ev.event_id} | 호스트: ${ev.hostname} | metric: ${ev.metric} | 체인: ${desc}`);
            } else {
                noRoute++;
                logger.info(`[배정 없음] event_id: ${ev.event_id} | 호스트: ${ev.hostname} | metric: ${ev.metric} | 등급: ${ev.event_cd} | 매칭 규칙 없음`);
            }
        }
        return { dispatched, noRoute };
    }

    async claimCalls(pool, limit) {
        if (limit <= 0) return [];
        const result = await pool.request()
            .input('limit', sql.Int, limit)
            .input('one_per_event', sql.Bit, settings.callbackKey === 'event_id' ? 1 : 0)
            .execute('IVROWN.usp_outbound_call_claim');
        return result.recordset.map(row => this.normalizeRecord(row));
    }

    // 콜백 키로 진행 중인 발신 건 찾기 (재기동으로 메모리 번들 정보가 없을 때)
    async findProcessingCallIds(pool, key) {
        const col = settings.callbackKey === 'call_id' ? 'call_id' : 'event_id';
        const result = await pool.request()
            .input('key', sql.Int, key)
            .query(`SELECT call_id FROM IVROWN.outbound_call WHERE ${col} = @key AND status = 'processing'`);
        return result.recordset.map(r => r.call_id);
    }

    async markDone(pool, callIds, bundleId) {
        let updated = 0;
        for (const id of callIds) {
            const result = await pool.request()
                .input('call_id',   sql.Int, id)
                .input('bundle_id', sql.Int, bundleId ?? null)
                .execute('IVROWN.usp_outbound_call_done');
            updated += result.recordset?.[0]?.updated ?? 0;
        }
        return updated;
    }

    // 반환: [{ call_id, new_status: retry_wait|exhausted|null, attempt_count, next_contact_seq }]
    async markFailed(pool, callIds, bundleId) {
        const out = [];
        for (const id of callIds) {
            const result = await pool.request()
                .input('call_id',            sql.Int, id)
                .input('retry_interval_sec', sql.Int, settings.retryIntervalSec)
                .input('escalate_delay_sec', sql.Int, settings.escalateDelaySec)
                .input('result',             sql.VarChar, 'failed')
                .input('bundle_id',          sql.Int, bundleId ?? null)
                .execute('IVROWN.usp_outbound_call_failed');
            out.push({ call_id: id, ...(result.recordset?.[0] ?? {}) });
        }
        return out;
    }

    async recover(pool) {
        const result = await pool.request()
            .input('timeout_min',        sql.Int, settings.recoverTimeoutMin)
            .input('retry_interval_sec', sql.Int, settings.retryIntervalSec)
            .input('escalate_delay_sec', sql.Int, settings.escalateDelaySec)
            .execute('IVROWN.usp_outbound_call_recover');
        return result.recordset?.[0]?.recovered ?? 0;
    }

    processMemo(rawMemo) {
        return /\.\w+$/.test(rawMemo.trim())
            ? '로그 에러가 발생하였습니다'
            : rawMemo;
    }

    normalizeRecord(row) {
        return {
            call_id:       row.call_id,
            event_id:      row.event_id,
            queue_id:      row.queue_id,
            hostname:      row.hostname,
            phone:         row.phone,
            contact_name:  row.contact_name,
            rule_name:     row.rule_name,
            chain_no:      row.chain_no,
            contact_seq:   row.contact_seq,
            attempt_count: row.attempt_count,
            max_attempts:  row.max_attempts,
            prc_id:        row.prc_id,
            sys_id:        row.sys_id,
            sys_ip:        row.sys_ip,
            event_cd:      row.event_cd,
            metric:        row.metric,
            metric_value:  row.metric_value,
            memo:          row.memo,
            created_dt:    row.created_dt,
        };
    }
}

export const adapter = new HanwhaLifeAdapter();
