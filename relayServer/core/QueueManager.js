import { logger } from '../logger.js';

export class QueueManager {
    // 일관성 유지를 위해 모든 상태는 private 필드로 관리
    #queue         = [];
    #processingIds = new Set();
    #bundleMap     = new Map();
    #maxSize;
    #duplicateBlockMs;

    constructor({ maxSize = 15, duplicateBlockMs = 60 * 1000 } = {}) {
        this.#maxSize       = maxSize;
        this.#duplicateBlockMs = duplicateBlockMs;
    }

    // 큐 상태 정보
    get size() { 
        return this.#queue.length; 
    }
    get vacancy() { 
        return this.#maxSize - this.#queue.length; 
    }
    get isFull() { 
        return this.#queue.length >= this.#maxSize; 
    }
    get processingCount() { 
        return this.#processingIds.size;
    }
    get bundleCount() { 
        return this.#bundleMap.size; 
    }

    isEmpty() { 
        return this.#queue.length === 0; 
    }

    // 큐 조작
    shift() {
        return this.#queue.shift(); 
    }

    // processingIds 조작
    hasProcessing(id) { 
        return this.#processingIds.has(id); 
    }
    addProcessing(id) {
        return this.#processingIds.add(id);
    }
    removeProcessing(id) { 
        this.#processingIds.delete(id); 
    }

    // bundleMap 조작
    getBundle(id) { 
        return this.#bundleMap.get(id); 
    }
    deleteBundle(id) { 
        this.#bundleMap.delete(id); 
    }

    // ── 핵심: DB 레코드 → 번들링 → 큐 적재 ───
    enqueue(records) {
        if (!records || records.length === 0) return;

        const now = Date.now();
        const groupMap = new Map();

        for (const record of records) {
            const key = record.event_pattern
                ? `${record.hostname}|${record.event_pattern}`
                : record.hostname;

            // 중복 방지: duplicateBlockMs 이내 동일 채널(호스트+패턴)이 이미 큐에 있으면 스킵
            const isDuplicate = this.#queue.some(item => {
                const itemTime = new Date(item.created_dt).getTime();
                const itemKey  = item.event_pattern
                    ? `${item.hostname}|${item.event_pattern}`
                    : item.hostname;
                return itemKey === key && Math.abs(now - itemTime) <= this.#duplicateBlockMs;
            });

            if (isDuplicate) {
                logger.info(`[메모리 큐 중복 분기] ID: ${record.id}`);
                continue;
            }

            // 채널(호스트+패턴)별 그룹화: 첫 레코드가 대표, 이후는 대표 bundleIds에 누적
            if (!groupMap.has(key)) {
                record.matchCount = 1;
                record.bundleIds  = [record.id];
                groupMap.set(key, record);
            } else {
                const leader = groupMap.get(key);
                leader.matchCount += 1;
                leader.bundleIds.push(record.id);
                logger.info(`[그룹 바인딩] Key: ${key}에 서브ID: ${record.id}가 묶임 (누적: ${leader.matchCount}건)`);
            }
        }

        // 가공된 번들을 큐에 적재
        for (const [key, leader] of groupMap.entries()) {
            if (this.isFull) {
                logger.info(`최종 적재 중 큐가 찼습니다. [${key}] 그룹은 다음 주기로 이월합니다.`);
                break;
            }

            if (this.hasProcessing(leader.id)) continue;

            this.addProcessing(leader.id);

            this.#bundleMap.set(leader.id, {
                ids:        leader.bundleIds,
                phone:      leader.phone,
                hostname:   leader.hostname,
                prc_id:     leader.prc_id,
                sys_id:     leader.sys_id,
                created_dt: leader.created_dt,
            });

            this.#queue.push(leader);
            logger.info(`[큐 최종 적재] Key: ${key} | 묶인 갯수: ${leader.matchCount}건 | 대표ID: ${leader.id}`);
        }
    }

    // ── 로그용 상태 요약 문자열 ────────────────────────────
    summary() {
        const bundleSummary = Array.from(this.#bundleMap.entries())
            .map(([id, b]) => `ID:${id}(${b.ids.length}건)`)
            .join(', ') || '없음';
        return `큐: ${this.size}건 | 처리중: ${this.processingCount}건 | 번들: ${bundleSummary}`;
    }
}
