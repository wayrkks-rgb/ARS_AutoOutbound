/* =====================================================================
   900_test_events.sql — 운영 검증용 테스트 이벤트 (테스트 서버 TEST-ARS01 기준)
   - 웹에서 TEST-ARS01 서버와 규칙을 먼저 등록 (docs/deploy-guide.md 4장)
   - outbound_queue 에 NOT NULL 컬럼이 더 있으면 값을 채워서 실행
   - event_id 는 실제 이벤트와 겹치지 않는 큰 값 사용
   - 한 번에 한 블록씩 실행하고 결과 확인 후 다음 블록
   ===================================================================== */

/* T1. 1명 수신 — 가용성 (OS 규칙) */
INSERT INTO IVROWN.outbound_queue (event_id, hostname, metric, metric_value, event_cd, sys_id, memo, status, created_dt)
VALUES (990000001, 'TEST-ARS01', N'가용성', NULL, N'심각', N'', N'[테스트] ping fail', 'pending', GETDATE());

/* T3. 동시 발신 — OS(가용성) + DBA(SQL Server Error Log) 두 사람이 동시에 울려야 함 */
INSERT INTO IVROWN.outbound_queue (event_id, hostname, metric, metric_value, event_cd, sys_id, memo, status, created_dt)
VALUES (990000011, 'TEST-ARS01', N'가용성', NULL, N'심각', N'', N'[테스트] OS down', 'pending', GETDATE()),
       (990000012, 'TEST-ARS01', N'SQL Server Error Log 이벤트 탐지', NULL, N'경고', N'시스템 로그 감시', N'[테스트] DB down', 'pending', GETDATE());

/* T4. 묶음 — 같은 사람(OS) 알람 2건이 1콜로 나가야 함 */
INSERT INTO IVROWN.outbound_queue (event_id, hostname, metric, metric_value, event_cd, sys_id, memo, status, created_dt)
VALUES (990000021, 'TEST-ARS01', N'CPU 사용률', N'97%', N'심각', N'', N'[테스트] cpu', 'pending', GETDATE()),
       (990000022, 'TEST-ARS01', N'메모리 사용률', N'95%', N'심각', N'', N'[테스트] mem', 'pending', GETDATE());

/* T5. 발신 안 함 — '경고' 등급 자원 이벤트 → 대상 없음(no_route) */
INSERT INTO IVROWN.outbound_queue (event_id, hostname, metric, metric_value, event_cd, sys_id, memo, status, created_dt)
VALUES (990000031, 'TEST-ARS01', N'CPU 사용률', N'85%', N'경고', N'', N'[테스트] cpu warn', 'pending', GETDATE());

/* 결과 확인 */
SELECT event_id, status, chain_count, dispatched_dt, completed_dt
FROM IVROWN.outbound_queue WHERE event_id >= 990000000 ORDER BY event_id;

SELECT call_id, event_id, rule_name, contact_seq, contact_name, phone, status, attempt_count, next_attempt_dt
FROM IVROWN.outbound_call WHERE event_id >= 990000000 ORDER BY event_id, chain_no, contact_seq;

SELECT a.call_id, a.attempt_no, a.phone, a.started_dt, a.ended_dt, a.result, a.bundle_id
FROM IVROWN.outbound_call_attempt a
JOIN IVROWN.outbound_call c ON c.call_id = a.call_id
WHERE c.event_id >= 990000000 ORDER BY a.attempt_id;

/* 정리 (검증 끝난 뒤) */
-- DELETE a FROM IVROWN.outbound_call_attempt a JOIN IVROWN.outbound_call c ON c.call_id = a.call_id WHERE c.event_id >= 990000000;
-- DELETE FROM IVROWN.outbound_call  WHERE event_id >= 990000000;
-- DELETE FROM IVROWN.outbound_queue WHERE event_id >= 990000000;
