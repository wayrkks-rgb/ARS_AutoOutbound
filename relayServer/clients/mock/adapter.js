import { AdapterBase } from '../AdapterBase.js';

class MockAdapter extends AdapterBase {

    getConfigList() {
        return [];
    }

    async dispatchEvents() {
        return { dispatched: 0, noRoute: 0 };
    }

    async claimCalls() {
        return [];
    }

    async findProcessingCallIds() {
        return [];
    }

    async markDone(pool, callIds) {
        return callIds.length;
    }

    async markFailed(pool, callIds) {
        return callIds.map(call_id => ({ call_id, new_status: 'retry_wait', attempt_count: 1 }));
    }
}

export const adapter = new MockAdapter();
