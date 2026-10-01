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

            logger.info(`[발신 시작] 번호: ${task.phone}(${task.contact_name ?? '-'}) | 호스트: ${task.hostname} | metric: ${task.metric ?? '-'} | ${task.rule_name ?? '-'} ${task.contact_seq}순위 | 시도: ${task.attempt_count}/${task.max_attempts} | event_id: ${task.event_id} | call_id: ${task.call_id} | 묶음: ${task.matchCount}건`);

            return {
                result: 'ok',
                event: {
                    queue_id:     task.queue_id,
                    call_id:      task.call_id,
                    status:       'processing',
                    sys_id:       task.sys_id,
                    sys_ip:       task.sys_ip,
                    prc_id:       task.prc_id,
                    event_id:     task.event_id,
                    phone:        task.phone,
                    contact_name: task.contact_name,
                    memo:         adapter.processMemo(task.memo ?? ''),
                    metric:       task.metric,
                    metric_value: task.metric_value,
                    hostname:     task.hostname,
                    created_dt:   task.created_dt,
                    retry_count:  task.attempt_count - 1,
                }
            };
        } catch (err) {
            logger.error(`[CHECK-EVENT ERROR] ${err.message}`);
            return { result: 'error', message: err.message };
        }
    };
}
