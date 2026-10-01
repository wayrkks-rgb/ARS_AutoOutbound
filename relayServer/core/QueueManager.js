import { logger } from '../logger.js';

// 발신 건(outbound_call) → 번들링 → IVR 대기 큐
// - 같은 번호 + 같은 호스트의 발신 건은 한 통화로 묶음 (대표 1건만 IVR 로 나감)
// - 아직 IVR 이 가져가지 않은 번들이 있으면 그 번들에 합침
// - 번들은 IVR 콜백 키(event_id 또는 call_id)로 찾음
export class QueueManager {
    // 일관성 유지를 위해 모든 상태는 private 필드로 관리
    #queue     = [];
    #bundleMap = new Map();   // 콜백 키 → { callIds, leaderCallId, phone, hostname, ... }
    #maxSize;
    #keyOf;

    constructor({ maxSize = 15, callbackKey = () => 'event_id' } = {}) {
        this.#maxSize = maxSize;
        this.#keyOf   = task => Number(task[callbackKey()]);
    }

    // 큐 상태 정보
    get size()            { return this.#queue.length; }
    get vacancy()         { return this.#maxSize - this.#queue.length; }
    get isFull()          { return this.#queue.length >= this.#maxSize; }
    get processingCount() { return this.#bundleMap.size; }
    get bundleCount()     { return this.#bundleMap.size; }

    isEmpty() { return this.#queue.length === 0; }

    shift() { return this.#queue.shift(); }

    keyOf(task) { return this.#keyOf(task); }

    getBundle(key)    { return this.#bundleMap.get(key); }
    deleteBundle(key) { this.#bundleMap.delete(key); }

    // ── 핵심: 발신 건 → 번들링 → 큐 적재 ───
    // claim 으로 이미 DB 상 processing 이므로 버리지 않고 반드시 큐(또는 기존 번들)에 넣는다
    enqueue(calls) {
        if (!calls || calls.length === 0) return;

        for (const call of calls) {
            const groupKey = `${call.phone}|${String(call.hostname).toLowerCase()}`;

            const waiting = this.#queue.find(t => t.groupKey === groupKey);
            if (waiting) {
                const bundle = this.#bundleMap.get(this.#keyOf(waiting));
                bundle.callIds.push(call.call_id);
                waiting.matchCount += 1;
                logger.info(`[그룹 바인딩] ${groupKey} 대표 call_id: ${waiting.call_id} 에 call_id: ${call.call_id}(event_id: ${call.event_id}) 묶음 (누적: ${waiting.matchCount}건)`);
                continue;
            }

            call.groupKey   = groupKey;
            call.matchCount = 1;
            this.#bundleMap.set(this.#keyOf(call), {
                callIds:      [call.call_id],
                leaderCallId: call.call_id,
                event_id:     call.event_id,
                phone:        call.phone,
                contact_name: call.contact_name,
                hostname:     call.hostname,
                prc_id:       call.prc_id,
                sys_id:       call.sys_id,
                attempt:      call.attempt_count,
                created_dt:   call.created_dt,
            });
            this.#queue.push(call);
            logger.info(`[큐 적재] call_id: ${call.call_id} | event_id: ${call.event_id} | ${call.rule_name ?? '-'} ${call.contact_seq}순위 ${call.contact_name ?? ''}(${call.phone}) | 시도: ${call.attempt_count}/${call.max_attempts}`);
        }
    }

    // ── 로그용 상태 요약 문자열 ────────────────────────────
    summary() {
        const bundleSummary = Array.from(this.#bundleMap.entries())
            .map(([key, b]) => `${key}(${b.callIds.length}건)`)
            .join(', ') || '없음';
        return `큐: ${this.size}건 | 진행중 번들: ${bundleSummary}`;
    }
}
