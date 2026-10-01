import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import { fileURLToPath } from 'url'; // ⭕ ESM 환경에서 경로 처리를 위해 필요

// ⭕ ESM 환경에서 __dirname 직접 구현하기
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logDir = path.join(__dirname, 'logs');

// 로그 포맷 설정
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf((info) => `[${info.timestamp}] ${info.level.toUpperCase()}: ${info.message}`)
);

export const logger = winston.createLogger({
    format: logFormat,
    transports: [
        // 콘솔 출력
        new winston.transports.Console({ level: 'info' }),
        // 1. 일반 로그 (INFO 등급 이상 전체) 날짜별 저장 설정
        new DailyRotateFile({
            level: 'info',
            datePattern: 'YYYY-MM-DD',
            dirname: logDir,
            filename: 'relay-info-%DATE%.log',
            maxFiles: '30d', // 30일치 보관 후 자동 삭제
            zippedArchive: true // 옛날 로그는 압축해서 디스크 절약
        }),
        // 2. 에러 로그 (ERROR 등급만) 날짜별 따로 저장 설정
        new DailyRotateFile({
            level: 'error',
            datePattern: 'YYYY-MM-DD',
            dirname: logDir,
            filename: 'relay-error-%DATE%.log',
            maxFiles: '30d',
            zippedArchive: true
        })
    ]
});

