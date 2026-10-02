/* =====================================================================
   002_grant_runtime_user.sql
   relayServer(.env 의 DB_USER) 계정에 신규 테이블/프로시저 권한 부여
   - <DB_USER> 를 relayServer/.env 의 DB_USER 로 바꿔서 실행
   - 001_multi_contact_routing.sql 실행 후에 실행
   ===================================================================== */

-- 발신 처리 (배정 시 INSERT, 대시보드 조회)
GRANT SELECT, INSERT, UPDATE ON IVROWN.outbound_call         TO [<DB_USER>];
GRANT SELECT, INSERT, UPDATE ON IVROWN.outbound_call_attempt TO [<DB_USER>];
GRANT SELECT                 ON IVROWN.v_outbound_call_history TO [<DB_USER>];

-- 기존 이벤트 테이블 (이미 있으면 생략 가능)
GRANT SELECT, UPDATE ON IVROWN.outbound_queue TO [<DB_USER>];

-- 발신 가져오기 / 결과 반영 / 복구 프로시저
GRANT EXECUTE ON IVROWN.usp_outbound_call_claim     TO [<DB_USER>];
GRANT EXECUTE ON IVROWN.usp_outbound_call_done      TO [<DB_USER>];
GRANT EXECUTE ON IVROWN.usp_outbound_call_failed    TO [<DB_USER>];
GRANT EXECUTE ON IVROWN.usp_outbound_call_recover   TO [<DB_USER>];
GRANT EXECUTE ON IVROWN.usp_outbound_event_finalize TO [<DB_USER>];
GO
