import dotenv from 'dotenv';
dotenv.config();

import sql from 'mssql';
import { adapter }          from './clients/hanwhalife/adapter.js';
import { QueueManager }     from './core/QueueManager.js';
import { createPoller }     from './core/Poller.js';
import { createHttpServer } from './core/HttpServer.js';
import { logger }           from './logger.js';

const PORT   = process.env.PORT   || 41001;
const IVR_IP = process.env.IVR_IP;

const dbConfig = {
    user:              process.env.DB_USER,
    password:          process.env.DB_PASSWORD,
    server:            process.env.DB_SERVER,
    database:          process.env.DB_DATABASE,
    port:              Number(process.env.DB_PORT) || 1433,
    connectionTimeout: 10000,  // 최초 연결 대기 10초
    requestTimeout:    15000,  // 쿼리 실행 대기 15초
    options:           { encrypt: false, trustServerCertificate: true },
    pool:              { max: 10, min: 1, idleTimeoutMillis: 30000, acquireTimeoutMillis: 15000 },
};

const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 10_000;

async function main() {
    const pool = await sql.connect(dbConfig);
    logger.info('[DB] MSSQL 연결 완료');

    const queueManager = new QueueManager();
    const { checkAndProcess } = createPoller({ pool, queueManager, adapter });

    await checkAndProcess();
    setInterval(checkAndProcess, POLL_INTERVAL_MS);
    logger.info(`[POLLING] ${POLL_INTERVAL_MS / 1000}초 주기 DB 감시 시작`);

    const server = createHttpServer({ pool, queueManager, adapter });
    const listenHost = IVR_IP || '0.0.0.0';
    server.listen(PORT, listenHost, () => {
        logger.info(`[READY] 서버 기동 — http://${listenHost}:${PORT}`);
    });
}

process.on('uncaughtException', err => {
    logger.error(`[UNCAUGHT EXCEPTION] ${err.message} | stack: ${err.stack}`);
});

process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    logger.error(`[UNHANDLED REJECTION] ${msg}`);
});

main().catch(err => {
    logger.error(`[FATAL] 서버 초기화 실패: ${err.message}`);
    process.exit(1);
});
