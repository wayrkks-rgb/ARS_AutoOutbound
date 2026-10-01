/* 001_multi_contact_routing.sql 되돌리기
   - outbound_call / outbound_call_attempt 의 발신 이력이 삭제되니, 필요하면 먼저 백업할 것
   - outbound_queue 에 추가한 컬럼/인덱스도 제거 */

IF OBJECT_ID('IVROWN.v_outbound_call_history', 'V')     IS NOT NULL DROP VIEW      IVROWN.v_outbound_call_history;
IF OBJECT_ID('IVROWN.usp_outbound_call_recover', 'P')   IS NOT NULL DROP PROCEDURE IVROWN.usp_outbound_call_recover;
IF OBJECT_ID('IVROWN.usp_outbound_call_failed', 'P')    IS NOT NULL DROP PROCEDURE IVROWN.usp_outbound_call_failed;
IF OBJECT_ID('IVROWN.usp_outbound_call_done', 'P')      IS NOT NULL DROP PROCEDURE IVROWN.usp_outbound_call_done;
IF OBJECT_ID('IVROWN.usp_outbound_call_claim', 'P')     IS NOT NULL DROP PROCEDURE IVROWN.usp_outbound_call_claim;
IF OBJECT_ID('IVROWN.usp_outbound_event_finalize', 'P') IS NOT NULL DROP PROCEDURE IVROWN.usp_outbound_event_finalize;
IF OBJECT_ID('IVROWN.outbound_call_attempt', 'U')       IS NOT NULL DROP TABLE     IVROWN.outbound_call_attempt;
IF OBJECT_ID('IVROWN.outbound_call', 'U')               IS NOT NULL DROP TABLE     IVROWN.outbound_call;
GO

IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('IVROWN.outbound_queue') AND name = 'IX_outbound_queue_poll')
    DROP INDEX IX_outbound_queue_poll ON IVROWN.outbound_queue;
IF EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('IVROWN.outbound_queue') AND name = 'IX_outbound_queue_event_id')
    DROP INDEX IX_outbound_queue_event_id ON IVROWN.outbound_queue;
IF COL_LENGTH('IVROWN.outbound_queue', 'chain_count')   IS NOT NULL ALTER TABLE IVROWN.outbound_queue DROP COLUMN chain_count;
IF COL_LENGTH('IVROWN.outbound_queue', 'dispatched_dt') IS NOT NULL ALTER TABLE IVROWN.outbound_queue DROP COLUMN dispatched_dt;
GO
