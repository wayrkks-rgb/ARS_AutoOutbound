import { logger } from '../logger.js';

// relay-server.js handlers['check-event'] 에 해당
// memo 가공은 고객사마다 다르므로 adapter.processMemo() 위임

export function createCheckEventHandler({ queueManager, adapter }) {
    return async () => {
        try {
            if (queueManager.isEmpty()) {
                return { result: 'empty', message: 'No tasks' };
            }

            const task = queueManager.shift();

            logger.info(`[발신 시작] 번호: ${task.phone} | 호스트: ${task.hostname} | 유형: ${task.prc_id} | 시스템: ${task.sys_id} | 발생시각: ${task.created_dt} | ID: ${task.id}`);

            return {
                result: 'ok',
                event: {
                    queue_id:    task.id,
                    status:      task.status,
                    sys_id:      task.sys_id,
                    sys_ip:      task.sys_ip,
                    prc_id:      task.prc_id,
                    event_id:    task.event_id,
                    phone:       task.phone,
                    memo:        adapter.processMemo(task.memo ?? ''),
                    hostname:    task.hostname,
                    created_dt:  task.created_dt,
                    retry_count: task.retry_count,
                }
            };
        } catch (err) {
            logger.error(`[CHECK-EVENT ERROR] ${err.message}`);
            return { result: 'error', message: err.message };
        }
    };
}
