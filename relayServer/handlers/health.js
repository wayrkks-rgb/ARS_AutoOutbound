// relay-server.js handlers['health'] 에 해당

export function createHealthHandler({ queueManager }) {
    return async () => {
        return {
            result:       'ok',
            queueSize:    queueManager.size,
            processing:   queueManager.processingCount,
            bundleCount:  queueManager.bundleCount,
            timestamp:    new Date(),
        };
    };
}
