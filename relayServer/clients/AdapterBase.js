export class AdapterBase {
    /* 
        ----필수 오버라이드 메서드---- 
    */
    /* 설정값을 불러오는 메서드 */
    getConfigList()      { throw new Error(`${this.constructor.name}: getConfigList() 미구현`) }
    /* 데이터를 조회하고 잠그는 메서드 */
    async fetchAndLock() { throw new Error(`${this.constructor.name}: fetchAndLock() 미구현`) }
    /* 처리 완료 상태로 업데이트하는 메서드 */
    async markDone()     { throw new Error(`${this.constructor.name}: markDone() 미구현`) }
    /* 처리 실패 상태로 업데이트하는 메서드 */
    async markFailed()   { throw new Error(`${this.constructor.name}: markFailed() 미구현`) }

    /* 
        ----기본 구현 메서드---- 
    */
    /* 이벤트 중 특정 메모를 처리하는 메서드 */
    processMemo(rawMemo)   { return rawMemo }
    /* 데이터를 정규화하는 메서드 */
    normalizeRecord(row)   { return row }
}
