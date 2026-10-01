import { logger } from '../logger.js';

// 1) 신규 이벤트 → 규칙 매칭 → 담당자별 발신 건 생성 (adapter.dispatchEvents)
// 2) 발신할 건(신규/재발신 시각 도래/부담당 차례) 가져오기 (adapter.claimCalls)
// 3) 번들링 후 IVR 대기 큐 적재 (QueueManager.enqueue)
// 주기적으로 콜백이 오지 않아 멈춘 건 정리 (adapter.recover)

const RECOVER_EVERY = 6;   // 폴링 6회마다(기본 10초 주기 → 1분)

export function createPoller({ pool, queueManager, adapter }) {
    let tick = 0;
    let running = false;

    async function checkAndProcess() {
        if (running) return;          // 이전 주기가 아직 끝나지 않았으면 건너뜀
        running = true;
        try {
            if (tick++ % RECOVER_EVERY === 0) {
                const recovered = await adapter.recover(pool);
                if (recovered) logger.warn(`[복구] 결과 미수신 발신 ${recovered}건 미응답(timeout) 처리`);
            }

            const configList = adapter.getConfigList();
            if (configList && configList.length > 0) {
                const { dispatched, noRoute } = await adapter.dispatchEvents(pool, configList);
                if (dispatched || noRoute) logger.info(`[배정] 발신 배정 ${dispatched}건 | 매칭 없음 ${noRoute}건`);
            }

            const vacancy = queueManager.vacancy;
            if (vacancy <= 0) {
                logger.info(`[POLLING] 큐 가득참 - 다음 주기 처리 | ${queueManager.summary()}`);
                return;
            }
            const calls = await adapter.claimCalls(pool, vacancy);
            if (calls.length) {
                queueManager.enqueue(calls);
                logger.info(`[POLLING] 발신 ${calls.length}건 적재 | ${queueManager.summary()}`);
            }
        } catch (err) {
            logger.error(`[POLLING ERROR] ${err.message}${err.originalError ? ` | 원인: ${err.originalError.message}` : ''} | stack: ${err.stack}`);
        } finally {
            running = false;
        }
    }

    return { checkAndProcess };
}
