import http from 'http';
import iconv from 'iconv-lite';
import { logger } from '../logger.js';
import { createCheckEventHandler } from '../handlers/checkEvent.js';
import { createCallDoneHandler }   from '../handlers/callDone.js';
import { createCallFailedHandler } from '../handlers/callFailed.js';
import { createHealthHandler }     from '../handlers/health.js';

// relay-server.js의 http.createServer() 블록에 해당
// EUC-KR 인코딩, $contents$ 기반 라우팅 처리

export function createHttpServer({ pool, queueManager, adapter }) {

    // 핸들러 인스턴스 생성 (의존성 주입)
    const handlers = {
        'check-event': createCheckEventHandler({ queueManager, adapter }),
        'call-done':   createCallDoneHandler({ pool, queueManager, adapter }),
        'call-failed': createCallFailedHandler({ pool, queueManager, adapter }),
        'health':      createHealthHandler({ queueManager }),
    };

    return http.createServer((req, res) => {
        const respond = (statusCode, data) => {
            const encoded = iconv.encode(JSON.stringify(data), 'euc-kr');
            res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=EUC-KR' });
            res.end(encoded);
        };

        let body = '';
        req.on('error', err => {
            logger.error(`[REQ STREAM ERROR] ${err.message}`);
            respond(500, { result: 'error', message: err.message });
        });
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data     = body ? JSON.parse(body) : {};
                const contents = data['$contents$'];
                const eventId  = data['$event-id$'];

                logger.info(`[REQ] contents=${contents} | id=${eventId}`);

                const handler = handlers[contents];
                if (!handler) {
                    return respond(404, { result: 'error', message: `unknown contents: ${contents}` });
                }

                const result = await handler(data);
                respond(200, result);

            } catch (err) {
                logger.error(`[HTTP ERROR] ${err.message}`);
                respond(500, { result: 'error', message: err.message });
            }
        });
    });
}
