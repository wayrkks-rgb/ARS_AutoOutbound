import { AdapterBase } from '../AdapterBase.js';

class MockAdapter extends AdapterBase {

    getConfigList() {
        return [];
    }

    async fetchAndLock() {
        return [];
    }

    async markDone(pool, targetIds) {
        return { rowsAffected: [targetIds.length] };
    }

    async markFailed(pool, evtId) {
        return 1;
    }
}

export const adapter = new MockAdapter();
