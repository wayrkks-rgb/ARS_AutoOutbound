# -*- coding: utf-8 -*-
"""운영 구동용 (waitress). 윈도우 서버에서 이 파일로 실행하세요.
   IP/PORT 는 app.py 상단의 SERVER_HOST / SERVER_PORT 또는 환경변수로 조정."""
from waitress import serve
from app import app, SERVER_HOST, SERVER_PORT

if __name__ == "__main__":
    print(f" * Host Registry running on http://{SERVER_HOST}:{SERVER_PORT}")
    serve(app, host=SERVER_HOST, port=SERVER_PORT, threads=6)
