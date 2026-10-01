import { logger } from '../logger.js';

// relay-server.js handlers['call-done'] 에 해당
// DB 업데이트 쿼리(테이블명 등)는 고객사마다 다르므로 adapter.markDone() 위임

export function createCallDoneHandler({ pool, queueManager, adapter }) {
    return async (data) => {
        try {
            const evtId  = Number(data['$event-id$']);
            const bundle = queueManager.getBundle(evtId) ?? {
                ids: [evtId], phone: '-', hostname: '-', prc_id: '-', sys_id: '-'
            };

            const result = await adapter.markDone(pool, bundle.ids);

            logger.info(`[발신 완료:정상] 번호: ${bundle.phone} | 호스트: ${bundle.hostname} | 유형: ${bundle.prc_id} | 시스템: ${bundle.sys_id} | ID: ${evtId} | 처리건수: ${bundle.ids.length}건`);

            queueManager.removeProcessing(evtId);
            queueManager.deleteBundle(evtId);

            logger.info(`[CALL-DONE] 정리 후 상태 | 큐: ${queueManager.size}건 | 처리중: ${queueManager.processingCount}건 | 번들맵: ${queueManager.bundleCount}개`);

            return { result: 'ok', updatedCount: result.rowsAffected[0] };
        } catch (err) {
            logger.error(`[CALL-DONE ERROR] ${err.message}`);
            return { result: 'error', message: err.message };
        }
    };
}
