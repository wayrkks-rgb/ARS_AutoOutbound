import { logger } from '../logger.js';
import { resolveBundle } from './callDone.js';

// relay-server.js handlers['call-failed'] 에 해당
// 무응답 / 통화중 / 확인 버튼 미입력 모두 미응답으로 처리
// 재발신(최대 횟수까지) → 소진 시 다음 담당자 넘김은 adapter.markFailed()(DB 프로시저) 위임

const STATUS_LABEL = { retry_wait: '재발신 대기', exhausted: '재발신 소진' };

export function createCallFailedHandler(deps) {
    const { pool, queueManager, adapter } = deps;
    return async (data) => {
        try {
            const key    = Number(data['$event-id$']);
            const bundle = await resolveBundle(deps, key);

            const results = await adapter.markFailed(pool, bundle.callIds, bundle.leaderCallId);
            queueManager.deleteBundle(key);

            for (const r of results) {
                const next = r.new_status === 'exhausted'
                    ? (r.next_contact_seq ? ` → ${r.next_contact_seq}순위 담당자 발신 예정` : ' → 다음 담당자 없음')
                    : '';
                logger.warn(`[발신 완료:미응답] 번호: ${bundle.phone}(${bundle.contact_name ?? '-'}) | 호스트: ${bundle.hostname} | 유형: ${bundle.prc_id} | 키: ${key} | call_id: ${r.call_id} | ${r.attempt_count ?? '-'}회차 ${STATUS_LABEL[r.new_status] ?? '반영 안 됨'}${next}`);
            }

            return { result: 'ok' };
        } catch (err) {
            logger.error(`[CALL-FAILED ERROR] ${err.message}`);
            return { result: 'error', message: err.message };
        }
    };
}
