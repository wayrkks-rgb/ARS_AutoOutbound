# -*- coding: utf-8 -*-
"""
서버 연락처 / 모니터링 패턴 등록 시스템
- Python 3.13 / Flask / waitress / openpyxl
- WAS 와 같은 머신, Node.js 가 읽는 JSON 을 로컬 경로에 원자적 기록 (Node 는 읽기만)
- 로그인 + 권한(admin/viewer) / 서버등록 / 일괄등록 / 모니터링등록 / 계정관리 / 변경이력
- 레코드: hostname, ip, department, name, phone, DAY(Y/N), NIGHT(Y/N), keyword(배열)
"""

import csv
import io
import json
import os
import re
import secrets
import tempfile
import threading
import math
from datetime import datetime
from functools import wraps

from flask import (
    Flask, render_template, request, redirect, url_for,
    session, flash, send_file, abort, Response, jsonify,
)
from werkzeug.security import generate_password_hash, check_password_hash
from openpyxl import Workbook, load_workbook

# ===========================================================================
#  ▼▼▼ 설정 — 운영 환경에 맞게 이 블록만 수정하세요 ▼▼▼
# ===========================================================================
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# [필수] Node.js 가 읽는 호스트 데이터 JSON 경로 (윈도우 경로는 r"..." 로!)
#   예) HOST_DATA_FILE = r"D:\was\data\hosts.json"
HOST_DATA_FILE = os.environ.get(
    "HOST_DATA_FILE", os.path.join(BASE_DIR, "data", "hosts.json")
)

SERVER_HOST = os.environ.get("SERVER_HOST", "0.0.0.0")    # 바인딩 IP
SERVER_PORT = int(os.environ.get("SERVER_PORT", "8458"))  # Node 와 다른 포트로!

USERS_FILE = os.environ.get("USERS_FILE", os.path.join(BASE_DIR, "data", "users.json"))
AUDIT_FILE = os.environ.get("AUDIT_FILE", os.path.join(BASE_DIR, "data", "audit.jsonl"))

PAGE_SIZE = 50
ALLOWED_EXT = {".csv", ".xlsx"}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
# ===========================================================================
#  ▲▲▲ 설정 끝 ▲▲▲
# ===========================================================================

SECRET_FILE = os.path.join(BASE_DIR, "data", "secret.key")

CORE_FIELDS = ["hostname", "ip", "department", "name", "phone"]
FLAG_FIELDS = ["DAY", "NIGHT"]
SORT_FIELDS = CORE_FIELDS + FLAG_FIELDS + ["keyword"]
SEARCH_FIELDS = CORE_FIELDS
FIELD_LABELS = {
    "hostname": "호스트네임", "ip": "IP", "department": "부서", "name": "이름",
    "phone": "핸드폰번호", "DAY": "주간", "NIGHT": "야간", "keyword": "패턴",
}
ACTION_LABELS = {
    "login": "로그인", "logout": "로그아웃", "add": "서버추가", "edit": "서버수정",
    "delete": "서버삭제", "import": "일괄등록", "monitor_patterns": "패턴변경",
    "user_add": "계정생성", "user_role": "권한변경", "user_reset": "비번초기화",
    "user_delete": "계정삭제", "change_password": "비번변경",
}

# ===========================================================================
app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES
_hosts_lock = threading.Lock()
_users_lock = threading.Lock()
_audit_lock = threading.Lock()


def _load_or_create_secret():
    os.makedirs(os.path.dirname(SECRET_FILE), exist_ok=True)
    if os.path.exists(SECRET_FILE):
        with open(SECRET_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(SECRET_FILE, "w", encoding="utf-8") as f:
        f.write(key)
    return key


app.secret_key = _load_or_create_secret()


# ===========================================================================
#  저장소
# ===========================================================================
def _atomic_write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.flush(); os.fsync(f.fileno())
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _normalize_record(r):
    out = {f: str(r.get(f, "") or "").strip() for f in CORE_FIELDS}
    for f in FLAG_FIELDS:
        out[f] = "Y" if str(r.get(f, "")).strip().upper() == "Y" else "N"
    kw = r.get("keyword", [])
    if isinstance(kw, str):
        kw = [p.strip() for p in kw.split(";") if p.strip()] if kw else []
    elif isinstance(kw, list):
        kw = [str(p).strip() for p in kw if str(p).strip()]
    else:
        kw = []
    out["keyword"] = kw
    return out


def load_hosts():
    if not os.path.exists(HOST_DATA_FILE):
        return []
    try:
        with open(HOST_DATA_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return [_normalize_record(r) for r in data] if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def save_hosts(data):
    _atomic_write_json(HOST_DATA_FILE, data)


def migrate_existing():
    if not os.path.exists(HOST_DATA_FILE):
        return
    try:
        with open(HOST_DATA_FILE, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (json.JSONDecodeError, OSError):
        return
    if isinstance(raw, list) and any(
            not all(k in r for k in (FLAG_FIELDS + ["keyword"])) for r in raw):
        with _hosts_lock:
            save_hosts([_normalize_record(r) for r in raw])


def load_users():
    if not os.path.exists(USERS_FILE):
        return []
    try:
        with open(USERS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError):
        return []


def save_users(users):
    _atomic_write_json(USERS_FILE, users)


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def ensure_default_admin():
    with _users_lock:
        users = load_users()
        if not any(u.get("username") == "admin" for u in users):
            users.append({"username": "admin", "password_hash": generate_password_hash("admin"),
                          "role": "admin", "is_default": True, "created_at": _now()})
            save_users(users)


def audit(action, target="", detail=None):
    try:
        ip = request.remote_addr or "-"
    except Exception:
        ip = "-"
    entry = {"ts": _now(), "ip": ip, "user": session.get("username", "-"),
             "action": action, "target": target, "detail": detail}
    with _audit_lock:
        os.makedirs(os.path.dirname(AUDIT_FILE), exist_ok=True)
        with open(AUDIT_FILE, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")


# ===========================================================================
#  검증 / 조회
# ===========================================================================
PHONE_RE = re.compile(r"^010\d{8}$")


def normalize_phone(raw):
    return re.sub(r"\D", "", raw or "")


def is_valid_phone(d):
    return bool(PHONE_RE.match(d))


def find_host(hosts, hostname):
    key = (hostname or "").strip().lower()
    return next((h for h in hosts if h.get("hostname", "").strip().lower() == key), None)


def find_by_ip(hosts, ip, exclude_hostname=None):
    ip = (ip or "").strip()
    excl = (exclude_hostname or "").strip().lower()
    if not ip:
        return None
    for h in hosts:
        if h.get("hostname", "").strip().lower() == excl:
            continue
        if h.get("ip", "").strip() == ip:
            return h
    return None


def contact_conflicts(hosts, department, name, phone, exclude_hostname=None):
    out, excl = [], (exclude_hostname or "").strip().lower()
    for h in hosts:
        if h.get("hostname", "").strip().lower() == excl:
            continue
        if (h.get("department", "").strip() == (department or "").strip()
                and h.get("name", "").strip() == (name or "").strip()
                and h.get("phone", "") != phone):
            out.append(h)
    return out


def validate_core(rec):
    errors, out = [], {}
    for f in CORE_FIELDS:
        v = (rec.get(f) or "").strip()
        out[f] = v
        if not v:
            errors.append(f"{FIELD_LABELS[f]} 누락")
    out["phone"] = normalize_phone(out.get("phone", ""))
    if out["phone"] and not is_valid_phone(out["phone"]):
        errors.append("핸드폰번호 형식 오류(010으로 시작하는 11자리)")
    for f in FLAG_FIELDS:
        out[f] = "Y" if str(rec.get(f, "")).strip().upper() == "Y" else "N"
    return errors, out


def sort_hosts(hosts, sort, direction):
    if sort not in SORT_FIELDS:
        sort = "hostname"
    rev = (direction == "desc")
    if sort == "keyword":
        key = lambda h: len(h.get("keyword", []))
    elif sort == "ip":
        def key(h):
            try:
                return tuple(int(x) for x in h.get("ip", "").split("."))
            except (ValueError, AttributeError):
                return (0,)
    else:
        key = lambda h: str(h.get(sort, "")).lower()
    return sorted(hosts, key=key, reverse=rev)


def summary(hosts):
    return {"total": len(hosts),
            "with_pattern": sum(1 for h in hosts if h.get("keyword")),
            "day": sum(1 for h in hosts if h.get("DAY") == "Y"),
            "night": sum(1 for h in hosts if h.get("NIGHT") == "Y")}



def record_detail(rec):
    d = {FIELD_LABELS[f]: rec.get(f, "") for f in CORE_FIELDS + FLAG_FIELDS}
    d[FIELD_LABELS["keyword"]] = rec.get("keyword", [])
    return d

def distinct_values(hosts, field):
    return sorted({h.get(field, "").strip() for h in hosts if h.get(field, "").strip()})


def paginate(items, page):
    pages = max(1, math.ceil(len(items) / PAGE_SIZE))
    page = max(1, min(page, pages))
    s = (page - 1) * PAGE_SIZE
    return items[s:s + PAGE_SIZE], page, pages, len(items)


# ===========================================================================
#  인증
# ===========================================================================
def login_required(f):
    @wraps(f)
    def w(*a, **k):
        if not session.get("username"):
            return redirect(url_for("login", next=request.path))
        return f(*a, **k)
    return w


def admin_required(f):
    @wraps(f)
    def w(*a, **k):
        if not session.get("username"):
            return redirect(url_for("login", next=request.path))
        if session.get("role") != "admin":
            abort(403)
        return f(*a, **k)
    return w


@app.context_processor
def inject():
    return {"current_user": session.get("username"), "current_role": session.get("role"),
            "CORE_FIELDS": CORE_FIELDS, "FLAG_FIELDS": FLAG_FIELDS,
            "FIELD_LABELS": FIELD_LABELS, "SEARCH_FIELDS": SEARCH_FIELDS}


# ===========================================================================
@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        u = next((x for x in load_users()
                  if x.get("username") == request.form.get("username", "").strip()), None)
        if u and check_password_hash(u["password_hash"], request.form.get("password", "")):
            session["username"] = u["username"]
            session["role"] = u["role"]
            session["is_default_pw"] = bool(u.get("is_default"))
            audit("login")
            return redirect(request.args.get("next") or url_for("index"))
        flash("아이디 또는 비밀번호가 올바르지 않습니다.", "error")
    return render_template("login.html")


@app.route("/logout")
def logout():
    audit("logout")
    session.clear()
    return redirect(url_for("login"))


# ===========================================================================
#  서버등록 목록
# ===========================================================================
def _filter_all(hosts, q):
    if not q:
        return hosts
    ql = q.lower()
    return [h for h in hosts if any(ql in str(h.get(f, "")).lower() for f in CORE_FIELDS)]


@app.route("/")
@login_required
def index():
    q = request.args.get("q", "").strip()
    sort = request.args.get("sort", "hostname")
    direction = request.args.get("dir", "asc")
    page = int(request.args.get("page", 1) or 1)
    allh = load_hosts()
    hosts = sort_hosts(_filter_all(allh, q), sort, direction)
    rows, page, pages, total = paginate(hosts, page)
    return render_template("index.html", hosts=rows, q=q, sort=sort, dir=direction,
                           page=page, pages=pages, total=total, stats=summary(allh))


# ===========================================================================
#  서버 추가 / 수정 / 삭제
# ===========================================================================
def _dup_errors(hosts, norm, exclude_hostname=None):
    errs = []
    if find_host(hosts, norm["hostname"]) and (exclude_hostname is None or
            norm["hostname"].strip().lower() != exclude_hostname.strip().lower()):
        errs.append(f"호스트네임 '{norm['hostname']}' 은(는) 이미 등록되어 있습니다.")
    ip_owner = find_by_ip(hosts, norm["ip"], exclude_hostname=exclude_hostname)
    if ip_owner:
        errs.append(f"IP '{norm['ip']}' 은(는) 이미 '{ip_owner['hostname']}' 에 등록되어 있습니다.")
    return errs


@app.route("/add", methods=["GET", "POST"])
@admin_required
def add():
    if request.method == "POST":
        rec = {f: request.form.get(f, "") for f in CORE_FIELDS}
        rec["DAY"] = "Y" if request.form.get("DAY") else "N"
        rec["NIGHT"] = "Y" if request.form.get("NIGHT") else "N"
        confirm = request.form.get("confirm_override") == "1"
        errors, norm = validate_core(rec)
        with _hosts_lock:
            hosts = load_hosts()
            if not errors:
                errors += _dup_errors(hosts, norm)
            if errors:
                return _form("add", norm, errors, [], "", hosts)
            conflicts = contact_conflicts(hosts, norm["department"], norm["name"], norm["phone"])
            if conflicts and not confirm:
                return _form("add", norm, [], conflicts, "", hosts)
            out = {f: norm[f] for f in CORE_FIELDS + FLAG_FIELDS}
            out["keyword"] = []
            hosts.append(out)
            save_hosts(hosts)
        audit("add", norm["hostname"], record_detail(out))
        flash(f"'{norm['hostname']}' 등록 완료.", "success")
        return redirect(url_for("index"))
    blank = {f: "" for f in CORE_FIELDS}
    blank.update({"DAY": "N", "NIGHT": "N"})
    return _form("add", blank, [], [], "", load_hosts())


def _form(mode, rec, errors, warnings, original_hostname, hosts):
    return render_template("form.html", mode=mode, rec=rec, errors=errors, warnings=warnings,
                           original_hostname=original_hostname,
                           departments=distinct_values(hosts, "department"),
                           names=distinct_values(hosts, "name"))


@app.route("/edit/<path:hostname>", methods=["GET", "POST"])
@admin_required
def edit(hostname):
    with _hosts_lock:
        target = find_host(load_hosts(), hostname)
        if not target:
            abort(404)
        original_hostname = target["hostname"]
    if request.method == "POST":
        rec = {f: request.form.get(f, "") for f in CORE_FIELDS}
        rec["DAY"] = "Y" if request.form.get("DAY") else "N"
        rec["NIGHT"] = "Y" if request.form.get("NIGHT") else "N"
        confirm = request.form.get("confirm_override") == "1"
        errors, norm = validate_core(rec)
        with _hosts_lock:
            hosts = load_hosts()
            target = find_host(hosts, original_hostname)
            if not target:
                abort(404)
            before = {f: target.get(f) for f in CORE_FIELDS + FLAG_FIELDS}
            if not errors:
                errors += _dup_errors(hosts, norm, exclude_hostname=original_hostname)
            if errors:
                return _form("edit", norm, errors, [], original_hostname, hosts)
            conflicts = contact_conflicts(hosts, norm["department"], norm["name"],
                                          norm["phone"], exclude_hostname=original_hostname)
            if conflicts and not confirm:
                return _form("edit", norm, [], conflicts, original_hostname, hosts)
            for f in CORE_FIELDS + FLAG_FIELDS:
                target[f] = norm[f]
            save_hosts(hosts)
        changed = {FIELD_LABELS[f]: [before[f], norm[f]] for f in CORE_FIELDS + FLAG_FIELDS if before[f] != norm[f]}
        audit("edit", original_hostname, {"changed": changed})
        flash(f"'{norm['hostname']}' 수정 완료.", "success")
        return redirect(url_for("index"))
    return _form("edit", target, [], [], original_hostname, load_hosts())


@app.route("/delete/<path:hostname>", methods=["POST"])
@admin_required
def delete(hostname):
    with _hosts_lock:
        hosts = load_hosts()
        target = find_host(hosts, hostname)
        if not target:
            abort(404)
        snapshot = dict(target)
        hosts = [h for h in hosts if h is not target]
        save_hosts(hosts)
    audit("delete", target["hostname"], record_detail(snapshot))
    flash(f"'{target['hostname']}' 삭제 완료.", "success")
    return redirect(url_for("index"))


# ===========================================================================
#  Export (조회조건 기준 전체)
# ===========================================================================
EXPORT_HEADER = CORE_FIELDS + FLAG_FIELDS + ["keyword"]


def _export_rows(hosts):
    rows = [EXPORT_HEADER]
    for h in hosts:
        rows.append([h.get(f, "") for f in CORE_FIELDS + FLAG_FIELDS] + [";".join(h.get("keyword", []))])
    return rows


def _hosts_for_export():
    hosts = load_hosts()
    q = request.args.get("q", "").strip()
    field = request.args.get("field", "").strip()
    kw = request.args.get("kw", "").strip()
    pat = request.args.get("pat", "all").strip()
    if field and field in CORE_FIELDS and kw:
        hosts = [h for h in hosts if kw.lower() in str(h.get(field, "")).lower()]
    elif q:
        hosts = _filter_all(hosts, q)
    if pat == "has":
        hosts = [h for h in hosts if h.get("keyword")]
    elif pat == "none":
        hosts = [h for h in hosts if not h.get("keyword")]
    return sort_hosts(hosts, request.args.get("sort", "hostname"), request.args.get("dir", "asc"))


@app.route("/export/csv")
@login_required
def export_csv():
    hosts = _hosts_for_export()
    buf = io.StringIO(); w = csv.writer(buf)
    for r in _export_rows(hosts):
        w.writerow(r)
    audit("export_csv", f"{len(hosts)}건")
    fname = f"hosts_{datetime.now():%Y%m%d_%H%M%S}.csv"
    return Response(("\ufeff" + buf.getvalue()).encode("utf-8"), mimetype="text/csv",
                    headers={"Content-Disposition": f"attachment; filename={fname}"})


@app.route("/export/xlsx")
@login_required
def export_xlsx():
    hosts = _hosts_for_export()
    wb = Workbook(); ws = wb.active; ws.title = "hosts"
    for r in _export_rows(hosts):
        ws.append(r)
    bio = io.BytesIO(); wb.save(bio); bio.seek(0)
    audit("export_xlsx", f"{len(hosts)}건")
    fname = f"hosts_{datetime.now():%Y%m%d_%H%M%S}.xlsx"
    return send_file(bio, as_attachment=True, download_name=fname,
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


# ===========================================================================
#  Import 양식 / 처리
# ===========================================================================
IMPORT_HEADER = CORE_FIELDS + FLAG_FIELDS
IMPORT_SAMPLE = ["SCC-IVR01", "1.1.1.1", "금융운영팀", "이찬행", "010-1234-5678", "Y", "N"]


@app.route("/template/csv")
@login_required
def template_csv():
    buf = io.StringIO(); w = csv.writer(buf)
    w.writerow(IMPORT_HEADER); w.writerow(IMPORT_SAMPLE)
    return Response(("\ufeff" + buf.getvalue()).encode("utf-8"), mimetype="text/csv",
                    headers={"Content-Disposition": "attachment; filename=import_template.csv"})


@app.route("/template/xlsx")
@login_required
def template_xlsx():
    from openpyxl.utils import get_column_letter
    wb = Workbook(); ws = wb.active; ws.title = "hosts"
    ws.append(IMPORT_HEADER); ws.append(IMPORT_SAMPLE)
    col = get_column_letter(IMPORT_HEADER.index("phone") + 1)
    for r in (1, 2):
        ws[f"{col}{r}"].number_format = "@"
    bio = io.BytesIO(); wb.save(bio); bio.seek(0)
    return send_file(bio, as_attachment=True, download_name="import_template.xlsx",
                     mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")


def _read_csv_rows(raw):
    for enc in ("utf-8-sig", "cp949"):
        try:
            return [dict(r) for r in csv.DictReader(io.StringIO(raw.decode(enc)))], None
        except (UnicodeDecodeError, csv.Error):
            continue
    return None, "CSV 인코딩을 해석할 수 없습니다 (UTF-8 / CP949)."


def _read_xlsx_rows(raw):
    ws = load_workbook(io.BytesIO(raw), read_only=True, data_only=True).active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return [], None
    headers = [str(c).strip() if c is not None else "" for c in rows[0]]
    out = []
    for r in rows[1:]:
        if r is None or all(c is None or str(c).strip() == "" for c in r):
            continue
        out.append({headers[i]: ("" if (i >= len(r) or r[i] is None) else str(r[i]).strip())
                    for i in range(len(headers))})
    return out, None


def _resolve_headers(keys):
    lower = {k.lower(): k for k in keys}
    return {f: lower[f.lower()] for f in CORE_FIELDS + FLAG_FIELDS if f.lower() in lower}


@app.route("/import", methods=["GET", "POST"])
@admin_required
def import_file():
    if request.method == "GET":
        return render_template("import.html", report=None)
    f = request.files.get("file")
    if not f or not f.filename:
        flash("파일을 선택하세요.", "error"); return render_template("import.html", report=None)
    ext = os.path.splitext(f.filename)[1].lower()
    if ext not in ALLOWED_EXT:
        flash("CSV 또는 XLSX 파일만 가능.", "error"); return render_template("import.html", report=None)
    raw = f.read()
    rows, err = (_read_csv_rows(raw) if ext == ".csv" else _read_xlsx_rows(raw))
    if err:
        flash(err, "error"); return render_template("import.html", report=None)
    if not rows:
        flash("데이터 행이 없습니다.", "error"); return render_template("import.html", report=None)
    hmap = _resolve_headers(rows[0].keys())
    missing = [c for c in CORE_FIELDS if c not in hmap]
    if missing:
        flash("필수 열 누락: " + ", ".join(missing) + " (헤더: " + ", ".join(CORE_FIELDS) + " [+ DAY, NIGHT])", "error")
        return render_template("import.html", report=None)

    has_day, has_night = "DAY" in hmap, "NIGHT" in hmap
    report = {"added": 0, "updated": 0, "rejected": [], "warnings": [], "added_hosts": [], "updated_hosts": []}
    with _hosts_lock:
        hosts = load_hosts()
        seen_host, seen_ip = {}, {}
        for idx, raw_rec in enumerate(rows, start=2):
            rec = {c: (raw_rec.get(hmap[c], "") or "").strip() for c in CORE_FIELDS}
            if has_day:
                rec["DAY"] = raw_rec.get(hmap["DAY"], "")
            if has_night:
                rec["NIGHT"] = raw_rec.get(hmap["NIGHT"], "")
            errors, norm = validate_core(rec)
            hkey, ipkey = norm["hostname"].lower(), norm["ip"]
            if norm["hostname"] and hkey in seen_host:
                errors.append(f"파일 내 호스트네임 중복(행 {seen_host[hkey]})")
            if norm["ip"] and ipkey in seen_ip:
                errors.append(f"파일 내 IP 중복(행 {seen_ip[ipkey]})")
            if not errors:
                owner = find_by_ip(hosts, norm["ip"], exclude_hostname=norm["hostname"])
                if owner:
                    errors.append(f"IP '{norm['ip']}' 가 기존 '{owner['hostname']}' 와 중복")
            if errors:
                report["rejected"].append({"row": idx, "hostname": norm.get("hostname", ""), "reasons": errors})
                continue
            seen_host[hkey] = idx
            if ipkey:
                seen_ip[ipkey] = idx
            conflicts = contact_conflicts(hosts, norm["department"], norm["name"],
                                          norm["phone"], exclude_hostname=norm["hostname"])
            if conflicts:
                report["warnings"].append({"row": idx, "hostname": norm["hostname"], "name": norm["name"],
                                           "department": norm["department"], "phone": norm["phone"],
                                           "existing": [{"hostname": c["hostname"], "phone": c["phone"]} for c in conflicts]})
            existing = find_host(hosts, norm["hostname"])
            if existing:
                for fld in CORE_FIELDS:
                    existing[fld] = norm[fld]
                if has_day:
                    existing["DAY"] = norm["DAY"]
                if has_night:
                    existing["NIGHT"] = norm["NIGHT"]
                report["updated"] += 1
                report["updated_hosts"].append(norm["hostname"])
            else:
                new = {fld: norm[fld] for fld in CORE_FIELDS}
                new["DAY"] = norm["DAY"] if has_day else "N"
                new["NIGHT"] = norm["NIGHT"] if has_night else "N"
                new["keyword"] = []
                hosts.append(new)
                report["added"] += 1
                report["added_hosts"].append(norm["hostname"])
        save_hosts(hosts)
    audit("import", f"추가 {report['added']} / 갱신 {report['updated']} / 거부 {len(report['rejected'])}",
          {"추가": report["added_hosts"], "갱신": report["updated_hosts"], "거부 건수": len(report["rejected"])})
    return render_template("import.html", report=report)


# ===========================================================================
#  모니터링 등록
# ===========================================================================
def _monitor_filter(hosts, field, kw, pat):
    if field in CORE_FIELDS and kw:
        hosts = [h for h in hosts if kw.lower() in str(h.get(field, "")).lower()]
    if pat == "has":
        hosts = [h for h in hosts if h.get("keyword")]
    elif pat == "none":
        hosts = [h for h in hosts if not h.get("keyword")]
    return hosts


@app.route("/monitor")
@login_required
def monitor():
    field = request.args.get("field", "hostname").strip()
    if field not in SEARCH_FIELDS:
        field = "hostname"
    kw = request.args.get("kw", "").strip()
    pat = request.args.get("pat", "all").strip()
    sort = request.args.get("sort", "hostname")
    direction = request.args.get("dir", "asc")
    page = int(request.args.get("page", 1) or 1)
    hosts = sort_hosts(_monitor_filter(load_hosts(), field, kw, pat), sort, direction)
    rows, page, pages, total = paginate(hosts, page)
    return render_template("monitor.html", hosts=rows, field=field, kw=kw, pat=pat,
                           sort=sort, dir=direction, page=page, pages=pages, total=total)


@app.route("/monitor/patterns", methods=["POST"])
@admin_required
def monitor_patterns():
    p = request.get_json(silent=True) or {}
    add_patterns = [x.strip() for x in p.get("add", []) if str(x).strip()]
    removals = p.get("remove", {})
    scope = p.get("scope", "selected")
    if scope == "filtered":
        targets = [h["hostname"] for h in _monitor_filter(
            load_hosts(), p.get("field", "hostname"), p.get("kw", "").strip(), p.get("pat", "all"))]
    else:
        targets = p.get("hostnames", [])
    if not targets and not removals:
        return jsonify({"ok": False, "msg": "대상이 없습니다."}), 400
    with _hosts_lock:
        hosts = load_hosts()
        tset = {t.lower() for t in targets}
        rmlower = {k.lower(): v for k, v in removals.items()}
        for h in hosts:
            hl = h.get("hostname", "").lower()
            kw = list(h.get("keyword", []))
            if hl in rmlower:
                kw = [x for x in kw if x not in rmlower[hl]]
            if hl in tset:
                for x in add_patterns:
                    if x not in kw:
                        kw.append(x)
            h["keyword"] = kw
        save_hosts(hosts)
    scope_label = "검색결과 전체" if scope == "filtered" else "선택"
    audit("monitor_patterns", f"{scope_label} {len(targets)}대",
          {"범위": scope_label, "추가 패턴": add_patterns,
           "삭제": (removals or None), "대상 서버": targets})
    return jsonify({"ok": True})


# ===========================================================================
#  계정 관리
# ===========================================================================
@app.route("/admin/users")
@admin_required
def users_page():
    return render_template("users.html", users=load_users())


@app.route("/admin/users/add", methods=["POST"])
@admin_required
def users_add():
    username = request.form.get("username", "").strip()
    password = request.form.get("password", "")
    role = request.form.get("role", "viewer")
    if not username or not password:
        flash("아이디와 비밀번호를 입력하세요.", "error"); return redirect(url_for("users_page"))
    if role not in ("admin", "viewer"):
        role = "viewer"
    with _users_lock:
        users = load_users()
        if any(u["username"] == username for u in users):
            flash(f"'{username}' 계정이 이미 존재합니다.", "error"); return redirect(url_for("users_page"))
        users.append({"username": username, "password_hash": generate_password_hash(password),
                      "role": role, "created_at": _now()})
        save_users(users)
    audit("user_add", username, {"role": role})
    flash(f"계정 '{username}' 생성 완료.", "success")
    return redirect(url_for("users_page"))


@app.route("/admin/users/role", methods=["POST"])
@admin_required
def users_role():
    username = request.form.get("username", "")
    role = request.form.get("role", "viewer")
    if role not in ("admin", "viewer"):
        flash("권한 값 오류.", "error"); return redirect(url_for("users_page"))
    with _users_lock:
        users = load_users()
        u = next((x for x in users if x["username"] == username), None)
        if not u:
            flash("계정을 찾을 수 없습니다.", "error"); return redirect(url_for("users_page"))
        if u["role"] == "admin" and role == "viewer" and len([x for x in users if x["role"] == "admin"]) <= 1:
            flash("마지막 관리자 권한은 변경할 수 없습니다.", "error"); return redirect(url_for("users_page"))
        u["role"] = role
        save_users(users)
    audit("user_role", username, {"role": role})
    flash(f"'{username}' 권한을 {role} 로 변경했습니다.", "success")
    return redirect(url_for("users_page"))


@app.route("/admin/users/reset", methods=["POST"])
@admin_required
def users_reset():
    username = request.form.get("username", "")
    password = request.form.get("password", "")
    if not password:
        flash("새 비밀번호를 입력하세요.", "error"); return redirect(url_for("users_page"))
    with _users_lock:
        users = load_users()
        u = next((x for x in users if x["username"] == username), None)
        if not u:
            flash("계정을 찾을 수 없습니다.", "error"); return redirect(url_for("users_page"))
        u["password_hash"] = generate_password_hash(password)
        u.pop("is_default", None)
        save_users(users)
    audit("user_reset", username)
    flash(f"'{username}' 비밀번호를 변경했습니다.", "success")
    return redirect(url_for("users_page"))


@app.route("/admin/users/delete", methods=["POST"])
@admin_required
def users_delete():
    username = request.form.get("username", "")
    if username == session.get("username"):
        flash("본인 계정은 삭제할 수 없습니다.", "error"); return redirect(url_for("users_page"))
    with _users_lock:
        users = load_users()
        u = next((x for x in users if x["username"] == username), None)
        if not u:
            flash("계정을 찾을 수 없습니다.", "error"); return redirect(url_for("users_page"))
        if u["role"] == "admin" and len([x for x in users if x["role"] == "admin"]) <= 1:
            flash("마지막 관리자 계정은 삭제할 수 없습니다.", "error"); return redirect(url_for("users_page"))
        save_users([x for x in users if x["username"] != username])
    audit("user_delete", username)
    flash(f"계정 '{username}' 삭제 완료.", "success")
    return redirect(url_for("users_page"))


@app.route("/change-password", methods=["GET", "POST"])
@login_required
def change_password():
    if request.method == "POST":
        cur, new, new2 = (request.form.get("current", ""), request.form.get("new", ""), request.form.get("new2", ""))
        with _users_lock:
            users = load_users()
            u = next((x for x in users if x["username"] == session["username"]), None)
            if not u or not check_password_hash(u["password_hash"], cur):
                flash("현재 비밀번호가 올바르지 않습니다.", "error"); return render_template("change_password.html")
            if not new or new != new2:
                flash("새 비밀번호가 일치하지 않습니다.", "error"); return render_template("change_password.html")
            u["password_hash"] = generate_password_hash(new)
            u.pop("is_default", None)
            save_users(users)
        session["is_default_pw"] = False
        audit("change_password")
        flash("비밀번호를 변경했습니다.", "success")
        return redirect(url_for("index"))
    return render_template("change_password.html")


# ===========================================================================
#  변경 이력
# ===========================================================================
@app.route("/admin/audit")
@admin_required
def audit_page():
    page = int(request.args.get("page", 1) or 1)
    entries = []
    if os.path.exists(AUDIT_FILE):
        with open(AUDIT_FILE, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    entries.reverse()
    rows, page, pages, total = paginate(entries, page)
    return render_template("audit.html", entries=rows, page=page, pages=pages,
                           total=total, labels=ACTION_LABELS)


@app.errorhandler(403)
def forbidden(e):
    return render_template("error.html", code=403, msg="권한이 없습니다. (조회 전용 계정)"), 403


@app.errorhandler(404)
def not_found(e):
    return render_template("error.html", code=404, msg="대상을 찾을 수 없습니다."), 404


# ===========================================================================
migrate_existing()
ensure_default_admin()

if __name__ == "__main__":
    app.run(host=SERVER_HOST, port=SERVER_PORT, debug=True)
