/* =====================================================================
   001_multi_contact_routing.sql
   - 한 이벤트 → 여러 담당자(메트릭별 규칙) 동시 발신
   - 담당자별 최대 2회 재발신(총 3회) 후 미응답 시 다음 담당자(부담당자)로 넘김
   - 대상: MSSQL (SSMS 또는 sqlcmd 로 실행, GO 구분자 사용)
   - 재실행해도 안전하게(IF NOT EXISTS) 작성됨
   설계 문서: docs/multi-contact-routing.md
   ===================================================================== */

/* ---------------------------------------------------------------------
   0. 사전 확인 (실행 전 결과를 눈으로 확인)
      - status 컬럼 길이: 'dispatched'(10자), 'no_route'(8자) 를 담을 수 있어야 함
      - event_id 가 중복 없이 들어오는지
   --------------------------------------------------------------------- */
SELECT c.name, t.name AS type_name, c.max_length, c.is_nullable
FROM sys.columns c
JOIN sys.types   t ON t.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('IVROWN.outbound_queue')
ORDER BY c.column_id;

SELECT TOP 10 event_id, COUNT(*) AS cnt
FROM IVROWN.outbound_queue
GROUP BY event_id
HAVING COUNT(*) > 1;
GO

/* ---------------------------------------------------------------------
   1. outbound_queue (이벤트 원장) — 컬럼/인덱스 추가
      status 값 흐름 (신규 Node 기준)
        pending → dispatched(담당자 발신건 생성됨) → processed | partial | failed
        pending → no_route (매칭되는 규칙/담당자 없음)
      phone 컬럼은 더 이상 사용하지 않음(기존 데이터 보존용으로 유지)
   --------------------------------------------------------------------- */
IF COL_LENGTH('IVROWN.outbound_queue', 'dispatched_dt') IS NULL
    ALTER TABLE IVROWN.outbound_queue ADD dispatched_dt DATETIME NULL;
IF COL_LENGTH('IVROWN.outbound_queue', 'chain_count') IS NULL
    ALTER TABLE IVROWN.outbound_queue ADD chain_count TINYINT NULL;   -- 이 이벤트로 생성된 발신 체인 수
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE object_id = OBJECT_ID('IVROWN.outbound_queue') AND name = 'IX_outbound_queue_event_id')
    CREATE INDEX IX_outbound_queue_event_id ON IVROWN.outbound_queue (event_id);
IF NOT EXISTS (SELECT 1 FROM sys.indexes
               WHERE object_id = OBJECT_ID('IVROWN.outbound_queue') AND name = 'IX_outbound_queue_poll')
    CREATE INDEX IX_outbound_queue_poll ON IVROWN.outbound_queue (status, created_dt) INCLUDE (hostname);
GO

/* ---------------------------------------------------------------------
   2. outbound_call — 담당자별 발신 건 (이벤트 1 : N)
      chain_no    : 이벤트 안에서 매칭된 규칙(=담당 그룹) 번호. 체인끼리는 동시에 발신
      contact_seq : 체인 안 순번. 1=정담당, 2=부담당 ... (앞 사람이 소진되면 다음 사람)
      status
        standby    : 대기(앞 순번 담당자가 아직 진행 중)
        pending    : 발신 대상
        processing : IVR 이 가져가서 발신 중
        retry_wait : 미응답, next_attempt_dt 이후 재발신
        answered   : 수신 완료 → 같은 체인의 standby 는 cancelled
        exhausted  : max_attempts 모두 미응답 → 다음 순번을 pending 으로
        cancelled  : 앞 순번이 받아서 발신 불필요
   --------------------------------------------------------------------- */
IF OBJECT_ID('IVROWN.outbound_call', 'U') IS NULL
BEGIN
    CREATE TABLE IVROWN.outbound_call (
        call_id          INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_outbound_call PRIMARY KEY,
        event_id         INT            NOT NULL,           -- outbound_queue.event_id
        hostname         NVARCHAR(100)  NOT NULL,
        metric           NVARCHAR(400)  NULL,               -- 매칭 당시 metric (조회 편의용 복사본)
        rule_id          VARCHAR(50)    NULL,               -- hosts.json 규칙 id
        rule_name        NVARCHAR(100)  NULL,               -- 예: OS, DBA, 기본
        chain_no         TINYINT        NOT NULL,
        contact_seq      TINYINT        NOT NULL,
        contact_name     NVARCHAR(50)   NULL,
        phone            VARCHAR(20)    NOT NULL,
        status           VARCHAR(20)    NOT NULL CONSTRAINT DF_outbound_call_status   DEFAULT ('standby'),
        attempt_count    TINYINT        NOT NULL CONSTRAINT DF_outbound_call_attempt  DEFAULT (0),
        max_attempts     TINYINT        NOT NULL CONSTRAINT DF_outbound_call_max      DEFAULT (3),  -- 최초 1 + 재발신 2
        next_attempt_dt  DATETIME       NULL,
        last_attempt_dt  DATETIME       NULL,
        completed_dt     DATETIME       NULL,
        created_dt       DATETIME       NOT NULL CONSTRAINT DF_outbound_call_created  DEFAULT (GETDATE()),
        CONSTRAINT CK_outbound_call_status CHECK (status IN
            ('standby','pending','processing','retry_wait','answered','exhausted','cancelled')),
        CONSTRAINT UQ_outbound_call_chain UNIQUE (event_id, chain_no, contact_seq)
    );
    CREATE INDEX IX_outbound_call_poll  ON IVROWN.outbound_call (status, next_attempt_dt) INCLUDE (event_id, hostname, phone);
    CREATE INDEX IX_outbound_call_event ON IVROWN.outbound_call (event_id, chain_no);
END
GO

/* ---------------------------------------------------------------------
   3. outbound_call_attempt — 실제 발신 시도 이력 (발신 1 : 시도 N)
   --------------------------------------------------------------------- */
IF OBJECT_ID('IVROWN.outbound_call_attempt', 'U') IS NULL
BEGIN
    CREATE TABLE IVROWN.outbound_call_attempt (
        attempt_id   BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_outbound_call_attempt PRIMARY KEY,
        call_id      INT          NOT NULL CONSTRAINT FK_outbound_call_attempt_call
                                           REFERENCES IVROWN.outbound_call (call_id),
        attempt_no   TINYINT      NOT NULL,
        phone        VARCHAR(20)  NOT NULL,
        started_dt   DATETIME     NOT NULL CONSTRAINT DF_outbound_call_attempt_started DEFAULT (GETDATE()),
        ended_dt     DATETIME     NULL,
        result       VARCHAR(20)  NULL,     -- answered / failed / timeout
        bundle_id    INT          NULL      -- 같이 묶여 한 통화로 나간 대표 call_id
    );
    CREATE INDEX IX_outbound_call_attempt_call ON IVROWN.outbound_call_attempt (call_id);
END
GO

/* ---------------------------------------------------------------------
   4. 이벤트 종결 판단 — 진행 중인 발신이 하나도 없으면 outbound_queue.status 확정
        모든 체인 수신   → processed
        일부 체인만 수신 → partial
        아무도 미수신    → failed
   --------------------------------------------------------------------- */
IF OBJECT_ID('IVROWN.usp_outbound_event_finalize', 'P') IS NOT NULL
    DROP PROCEDURE IVROWN.usp_outbound_event_finalize;
GO
CREATE PROCEDURE IVROWN.usp_outbound_event_finalize
    @event_id INT
AS
BEGIN
    SET NOCOUNT ON;

    IF EXISTS (SELECT 1 FROM IVROWN.outbound_call
               WHERE event_id = @event_id
                 AND status IN ('standby','pending','processing','retry_wait'))
        RETURN;

    DECLARE @chains INT, @answered INT;
    SELECT @chains = COUNT(DISTINCT chain_no)
    FROM IVROWN.outbound_call
    WHERE event_id = @event_id;

    SELECT @answered = COUNT(DISTINCT chain_no)
    FROM IVROWN.outbound_call
    WHERE event_id = @event_id AND status = 'answered';

    IF @chains = 0 RETURN;

    UPDATE IVROWN.outbound_queue
    SET status       = CASE WHEN @answered = @chains THEN 'processed'
                            WHEN @answered = 0       THEN 'failed'
                            ELSE 'partial' END,
        completed_dt = GETDATE()
    WHERE event_id = @event_id
      AND status = 'dispatched';
END
GO

/* ---------------------------------------------------------------------
   5. 발신 대상 가져오기 (Node 폴링) — pending / 재발신 시각 도래한 retry_wait
   --------------------------------------------------------------------- */
IF OBJECT_ID('IVROWN.usp_outbound_call_claim', 'P') IS NOT NULL
    DROP PROCEDURE IVROWN.usp_outbound_call_claim;
GO
CREATE PROCEDURE IVROWN.usp_outbound_call_claim
    @limit INT
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @claimed TABLE (call_id INT, phone VARCHAR(20), attempt_count TINYINT);

    BEGIN TRAN;

    WITH target AS (
        SELECT TOP (@limit) *
        FROM IVROWN.outbound_call WITH (ROWLOCK, UPDLOCK, READPAST)
        WHERE status IN ('pending','retry_wait')
          AND (next_attempt_dt IS NULL OR next_attempt_dt <= GETDATE())
        ORDER BY ISNULL(next_attempt_dt, created_dt), call_id
    )
    UPDATE target
    SET status          = 'processing',
        attempt_count   = attempt_count + 1,
        last_attempt_dt = GETDATE()
    OUTPUT INSERTED.call_id, INSERTED.phone, INSERTED.attempt_count INTO @claimed;

    INSERT INTO IVROWN.outbound_call_attempt (call_id, attempt_no, phone)
    SELECT call_id, attempt_count, phone FROM @claimed;

    COMMIT;

    SELECT c.call_id, c.event_id, c.hostname, c.metric, c.rule_name,
           c.chain_no, c.contact_seq, c.contact_name, c.phone,
           c.attempt_count, c.max_attempts,
           q.sys_id, q.sys_ip, q.prc_id, q.event_cd, q.memo, q.metric_value, q.created_dt
    FROM @claimed k
    JOIN IVROWN.outbound_call  c ON c.call_id  = k.call_id
    JOIN IVROWN.outbound_queue q ON q.event_id = c.event_id
    ORDER BY c.call_id;
END
GO

/* ---------------------------------------------------------------------
   6. 수신 완료 (IVR call-done)
      @bundle_id : 같이 묶여 나간 대표 call_id (없으면 NULL)
   --------------------------------------------------------------------- */
IF OBJECT_ID('IVROWN.usp_outbound_call_done', 'P') IS NOT NULL
    DROP PROCEDURE IVROWN.usp_outbound_call_done;
GO
CREATE PROCEDURE IVROWN.usp_outbound_call_done
    @call_id   INT,
    @bundle_id INT = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @event_id INT, @chain_no TINYINT;

    BEGIN TRAN;

    UPDATE IVROWN.outbound_call
    SET status       = 'answered',
        completed_dt = GETDATE(),
        @event_id    = event_id,
        @chain_no    = chain_no
    WHERE call_id = @call_id
      AND status  = 'processing';

    IF @@ROWCOUNT = 0
    BEGIN
        ROLLBACK;
        SELECT CAST(0 AS INT) AS updated;
        RETURN;
    END

    UPDATE IVROWN.outbound_call_attempt
    SET ended_dt = GETDATE(), result = 'answered', bundle_id = @bundle_id
    WHERE call_id = @call_id AND ended_dt IS NULL;

    -- 같은 체인의 다음 순번(부담당자)은 더 이상 발신하지 않음
    UPDATE IVROWN.outbound_call
    SET status = 'cancelled', completed_dt = GETDATE()
    WHERE event_id = @event_id
      AND chain_no = @chain_no
      AND status   = 'standby';

    EXEC IVROWN.usp_outbound_event_finalize @event_id;

    COMMIT;
    SELECT CAST(1 AS INT) AS updated;
END
GO

/* ---------------------------------------------------------------------
   7. 미응답/실패 (IVR call-failed)
      attempt_count < max_attempts → retry_wait (@retry_interval_sec 뒤 재발신)
      그 외                        → exhausted + 같은 체인 다음 순번을 pending 으로
   --------------------------------------------------------------------- */
IF OBJECT_ID('IVROWN.usp_outbound_call_failed', 'P') IS NOT NULL
    DROP PROCEDURE IVROWN.usp_outbound_call_failed;
GO
CREATE PROCEDURE IVROWN.usp_outbound_call_failed
    @call_id            INT,
    @retry_interval_sec INT = 180,
    @result             VARCHAR(20) = 'failed',   -- failed / timeout
    @bundle_id          INT = NULL,
    @silent             BIT = 0                   -- 1 이면 결과셋 생략(복구 프로시저에서 호출 시)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;

    DECLARE @event_id INT, @chain_no TINYINT, @seq TINYINT,
            @attempt TINYINT, @max TINYINT, @new_status VARCHAR(20), @next_seq TINYINT;

    BEGIN TRAN;

    SELECT @event_id = event_id, @chain_no = chain_no, @seq = contact_seq,
           @attempt  = attempt_count, @max = max_attempts
    FROM IVROWN.outbound_call WITH (UPDLOCK, ROWLOCK)
    WHERE call_id = @call_id
      AND status  = 'processing';

    IF @event_id IS NULL
    BEGIN
        ROLLBACK;
        IF @silent = 0
            SELECT CAST(NULL AS VARCHAR(20)) AS new_status, CAST(NULL AS TINYINT) AS attempt_count,
                   CAST(NULL AS TINYINT) AS next_contact_seq;
        RETURN;
    END

    UPDATE IVROWN.outbound_call_attempt
    SET ended_dt = GETDATE(), result = @result, bundle_id = @bundle_id
    WHERE call_id = @call_id AND ended_dt IS NULL;

    IF @attempt < @max
    BEGIN
        SET @new_status = 'retry_wait';
        UPDATE IVROWN.outbound_call
        SET status          = 'retry_wait',
            next_attempt_dt = DATEADD(SECOND, @retry_interval_sec, GETDATE())
        WHERE call_id = @call_id;
    END
    ELSE
    BEGIN
        SET @new_status = 'exhausted';
        UPDATE IVROWN.outbound_call
        SET status = 'exhausted', completed_dt = GETDATE()
        WHERE call_id = @call_id;

        SELECT @next_seq = MIN(contact_seq)
        FROM IVROWN.outbound_call
        WHERE event_id = @event_id AND chain_no = @chain_no
          AND contact_seq > @seq AND status = 'standby';

        IF @next_seq IS NOT NULL
            UPDATE IVROWN.outbound_call
            SET status = 'pending', next_attempt_dt = GETDATE()
            WHERE event_id = @event_id AND chain_no = @chain_no AND contact_seq = @next_seq;
    END

    EXEC IVROWN.usp_outbound_event_finalize @event_id;

    COMMIT;
    IF @silent = 0
        SELECT @new_status AS new_status, @attempt AS attempt_count, @next_seq AS next_contact_seq;
END
GO

/* ---------------------------------------------------------------------
   8. 장애 복구 — IVR 콜백 유실 / Node 재기동으로 processing 에 멈춘 건 정리
      @timeout_min 이 지나도록 결과가 없으면 미응답(timeout)으로 처리
      Node 기동 시 + 주기적으로 호출
   --------------------------------------------------------------------- */
IF OBJECT_ID('IVROWN.usp_outbound_call_recover', 'P') IS NOT NULL
    DROP PROCEDURE IVROWN.usp_outbound_call_recover;
GO
CREATE PROCEDURE IVROWN.usp_outbound_call_recover
    @timeout_min        INT = 10,
    @retry_interval_sec INT = 180
AS
BEGIN
    SET NOCOUNT ON;

    DECLARE @stuck TABLE (call_id INT PRIMARY KEY);
    INSERT INTO @stuck (call_id)
    SELECT call_id FROM IVROWN.outbound_call
    WHERE status = 'processing'
      AND last_attempt_dt < DATEADD(MINUTE, -@timeout_min, GETDATE());

    DECLARE @id INT, @recovered INT = 0;

    WHILE 1 = 1
    BEGIN
        SELECT TOP 1 @id = call_id FROM @stuck ORDER BY call_id;
        IF @@ROWCOUNT = 0 BREAK;
        DELETE FROM @stuck WHERE call_id = @id;

        EXEC IVROWN.usp_outbound_call_failed @call_id = @id,
             @retry_interval_sec = @retry_interval_sec, @result = 'timeout', @silent = 1;
        SET @recovered += 1;
    END

    SELECT @recovered AS recovered;
END
GO

/* ---------------------------------------------------------------------
   9. 대시보드/이력 조회용 뷰
   --------------------------------------------------------------------- */
IF OBJECT_ID('IVROWN.v_outbound_call_history', 'V') IS NOT NULL
    DROP VIEW IVROWN.v_outbound_call_history;
GO
CREATE VIEW IVROWN.v_outbound_call_history AS
SELECT c.call_id, c.event_id, q.created_dt AS event_dt,
       c.hostname, c.metric, q.metric_value, q.event_cd, q.sys_id, q.prc_id, q.memo,
       c.rule_name, c.chain_no, c.contact_seq, c.contact_name, c.phone,
       c.status, c.attempt_count, c.max_attempts,
       c.last_attempt_dt, c.next_attempt_dt, c.completed_dt,
       q.status AS event_status
FROM IVROWN.outbound_call  c
JOIN IVROWN.outbound_queue q ON q.event_id = c.event_id;
GO
