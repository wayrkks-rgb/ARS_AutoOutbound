import { logger } from '../logger.js';

// relay-server.js checkAndProcess() 에 해당
// 번들링 알고리즘(공통)은 QueueManager.enqueue()가 담당
// SQL 실행은 adapter.fetchAndLock()이 담당
// Poller는 둘을 연결하는 루프 역할만 함

export function createPoller({ pool, queueManager, adapter }) {

    async function checkAndProcess() {
        try {
            const configList = adapter.getConfigList();
            if (!configList || configList.length === 0) return;

            logger.info(`[POLLING] 시작 | ${queueManager.summary()}`);

            for (const config of configList) {
                const vacancy = queueManager.vacancy;
                if (vacancy <= 0) {
                    logger.info(`[POLLING] 큐 가득참 - 다음 주기 혹은 이월 처리`);
                    break;
                }

                // config 전체를 넘김 → 필드명(ani/phone 등)은 adapter가 직접 해석
                const records = await adapter.fetchAndLock(pool.request(), { config, vacancy });
                queueManager.enqueue(records);
            }

            logger.info(`[POLLING] 종료 | 큐: ${queueManager.size}건 | 번들맵: ${queueManager.bundleCount}개`);

        } catch (err) {
            logger.error(`[POLLING ERROR] ${err.message}${err.originalError ? ` | 원인: ${err.originalError.message}` : ''} | stack: ${err.stack}`);
        }
    }

    return { checkAndProcess };
}
