export class AdapterBase {
    /*
        ----필수 오버라이드 메서드----
    */
    /* 설정값(호스트별 수신 규칙)을 불러오는 메서드 */
    getConfigList()       { throw new Error(`${this.constructor.name}: getConfigList() 미구현`) }
    /* 신규 이벤트를 규칙에 따라 담당자별 발신 건으로 배정하는 메서드 */
    async dispatchEvents() { throw new Error(`${this.constructor.name}: dispatchEvents() 미구현`) }
    /* 발신할 건을 가져오고 잠그는 메서드 */
    async claimCalls()    { throw new Error(`${this.constructor.name}: claimCalls() 미구현`) }
    /* 수신 완료로 업데이트하는 메서드 */
    async markDone()      { throw new Error(`${this.constructor.name}: markDone() 미구현`) }
    /* 미응답(재발신/다음 담당자)으로 업데이트하는 메서드 */
    async markFailed()    { throw new Error(`${this.constructor.name}: markFailed() 미구현`) }

    /*
        ----기본 구현 메서드----
    */
    /* 콜백 유실 등으로 멈춘 발신 건 정리 */
    async recover()        { return 0 }
    /* 이벤트 중 특정 메모를 처리하는 메서드 */
    processMemo(rawMemo)   { return rawMemo }
    /* 데이터를 정규화하는 메서드 */
    normalizeRecord(row)   { return row }
}
