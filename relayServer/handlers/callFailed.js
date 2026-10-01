import { logger } from '../logger.js';

// relay-server.js handlers['call-failed'] 에 해당
// DB 업데이트 쿼리(테이블명 등)는 고객사마다 다르므로 adapter.markFailed() 위임

export function createCallFailedHandler({ pool, queueManager, adapter }) {
    return async (data) => {
        try {
            const evtId  = Number(data['$event-id$']);
            const bundle = queueManager.getBundle(evtId) ?? {
                phone: '-', hostname: '-', prc_id: '-', sys_id: '-'
            };

            const retryCount = await adapter.markFailed(pool, evtId);

            queueManager.removeProcessing(evtId);
            queueManager.deleteBundle(evtId);

            logger.warn(`[발신 완료:실패] 번호: ${bundle.phone} | 호스트: ${bundle.hostname} | 유형: ${bundle.prc_id} | 시스템: ${bundle.sys_id} | ID: ${evtId} | 재시도: ${retryCount}회차`);

            return { result: 'ok' };
        } catch (err) {
            logger.error(`[CALL-FAILED ERROR] ${err.message}`);
            return { result: 'error', message: err.message };
        }
    };
}
