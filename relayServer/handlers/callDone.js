import { logger } from '../logger.js';

// relay-server.js handlers['call-done'] 에 해당
// 수신 완료 → 같은 체인의 부담당 발신 취소, 이벤트 종결 판단은 adapter.markDone()(DB 프로시저) 위임

export async function resolveBundle({ pool, queueManager, adapter }, key) {
    const bundle = queueManager.getBundle(key);
    if (bundle) return bundle;
    // 재기동 등으로 메모리에 번들 정보가 없으면 DB 에서 진행 중인 건을 찾음
    const callIds = await adapter.findProcessingCallIds(pool, key);
    return { callIds, leaderCallId: callIds[0] ?? null, phone: '-', hostname: '-', contact_name: '-', prc_id: '-', sys_id: '-' };
}

export function createCallDoneHandler(deps) {
    const { pool, queueManager, adapter } = deps;
    return async (data) => {
        try {
            const key    = Number(data['$event-id$']);
            const bundle = await resolveBundle(deps, key);

            const updated = await adapter.markDone(pool, bundle.callIds, bundle.leaderCallId);

            logger.info(`[발신 완료:수신] 번호: ${bundle.phone}(${bundle.contact_name ?? '-'}) | 호스트: ${bundle.hostname} | 유형: ${bundle.prc_id} | 시스템: ${bundle.sys_id} | 키: ${key} | call_id: ${bundle.callIds.join(',')} | 반영: ${updated}건`);

            queueManager.deleteBundle(key);
            logger.info(`[CALL-DONE] 정리 후 상태 | ${queueManager.summary()}`);

            return { result: 'ok', updatedCount: updated };
        } catch (err) {
            logger.error(`[CALL-DONE ERROR] ${err.message}`);
            return { result: 'error', message: err.message };
        }
    };
}
