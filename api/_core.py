"""보험 콘텐츠 여정 대시보드의 데이터·로그인 로직.

Vercel 함수(api/data.py, api/login.py)와 로컬 개발 서버(dev_server.py)가 같이 쓴다.
- 랜딩 인입·유저·상담 신청: Mixpanel Segmentation API (서비스 계정)
- 콘텐츠 보드(채널·주제·단계·Mixpanel 키·비용): 구글 시트 (서비스 계정, 읽기 전용)
화면 계산(채널 묶기, 콘텐츠별 합산, 흐름)은 assets/app.js가 한다. 여기서는 원본 행만 돌려준다.
"""
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import threading
import time

import requests

PROJECT_ID = int(os.environ.get("MIXPANEL_PROJECT_ID", "3970973"))
MP_HOST = os.environ.get("MIXPANEL_API_HOST", "https://mixpanel.com")
BOARD_SHEET_ID = os.environ.get("BOARD_SHEET_ID", "11VR6Ft82By0vtfosHL5Fb9ofrvz52vBMw6dna1WCP_w")
BOARD_RANGE = "'콘텐츠 보드'!A5:AZ300"
# 화면이 쓰는 열만 돌려준다. 시트에 열이 추가돼도 이름으로 찾는다.
BOARD_COLUMNS = ["채널", "콘텐츠 주제", "현재 단계", "담당자", "발행일", "Mixpanel 키 (utm_content 일부)", "조회수", "비용(원)"]
OWNED_MEDIUMS = ["youtube", "blog", "cafe", "Instagram_Reels", "Instagram_Feed", "Instagram_Stories",
                 "instagram", "community", "basictip"]

SESSION_COOKIE = "cj_session"
SESSION_HOURS = 12
CACHE_SECONDS = 30 * 60
MAX_RANGE_DAYS = 180

# utm_medium과 utm_content를 "|"로 이은 값으로 쪼갠다. Mixpanel에서 한 번에 받아 오려고 쓰는 식.
UTM_KEY = 'string(properties["utm_medium"]) + "|" + string(properties["utm_content"])'
OWNED_WHERE = " or ".join(f'properties["utm_medium"] == "{m}"' for m in OWNED_MEDIUMS)
EMPTY = {"", "undefined", "null", "none"}


# ---------- 로그인 ----------

def _secret():
    secret = os.environ.get("SESSION_SECRET", "")
    if len(secret) < 16:
        raise RuntimeError("SESSION_SECRET 환경변수(16자 이상)를 설정하세요.")
    return secret.encode()


def login_required():
    return bool(os.environ.get("DASHBOARD_PASSWORD"))


def make_token():
    exp = str(int(time.time()) + SESSION_HOURS * 3600)
    sig = hmac.new(_secret(), exp.encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{sig}"


def token_ok(token):
    if not login_required():
        return True
    try:
        exp, sig = token.split(".", 1)
        good = hmac.new(_secret(), exp.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(sig, good) and int(exp) > time.time()
    except (ValueError, AttributeError):
        return False


def password_ok(password):
    expected = os.environ.get("DASHBOARD_PASSWORD", "")
    return bool(expected) and hmac.compare_digest(str(password).encode(), expected.encode())


def session_from(headers):
    for part in (headers.get("Cookie") or headers.get("cookie") or "").split(";"):
        name, _, value = part.strip().partition("=")
        if name == SESSION_COOKIE:
            return value
    return ""


def session_cookie(token, max_age):
    return f"{SESSION_COOKIE}={token}; Max-Age={max_age}; Path=/; HttpOnly; Secure; SameSite=Lax"


# ---------- 데이터 가져오기 ----------

def _clean(value):
    value = str(value or "").strip()
    return "" if value.lower() in EMPTY else value


def mixpanel_daily(event, kind, start, end):
    """{(medium, content): {day: count}}. kind="general"은 전체 횟수, "unique"는 일별 고유 사용자 수."""
    user = os.environ.get("MIXPANEL_SA_USERNAME")
    secret = os.environ.get("MIXPANEL_SA_SECRET")
    if not user or not secret:
        raise RuntimeError("MIXPANEL_SA_USERNAME / MIXPANEL_SA_SECRET 환경변수를 설정하세요.")
    res = requests.get(
        f"{MP_HOST}/api/query/segmentation",
        params={"project_id": PROJECT_ID, "event": event, "from_date": start, "to_date": end,
                "on": UTM_KEY, "where": OWNED_WHERE, "type": kind, "unit": "day", "limit": 10000},
        auth=(user, secret), timeout=60,
    )
    if res.status_code != 200:
        raise RuntimeError(f"Mixpanel {res.status_code}: {res.text[:300]}")
    out = {}
    for key, by_day in res.json().get("data", {}).get("values", {}).items():
        medium, _, content = key.partition("|")
        k = (_clean(medium), _clean(content))
        days = out.setdefault(k, {})
        for day, v in by_day.items():
            days[day] = days.get(day, 0) + (v or 0)
    return out


def board_rows():
    from google.oauth2 import service_account
    import google.auth.transport.requests

    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not raw:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON 환경변수를 설정하세요.")
    creds = service_account.Credentials.from_service_account_info(
        json.loads(raw), scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
    creds.refresh(google.auth.transport.requests.Request())
    res = requests.get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{BOARD_SHEET_ID}/values/{requests.utils.quote(BOARD_RANGE)}",
        headers={"Authorization": f"Bearer {creds.token}"}, timeout=60,
    )
    if res.status_code != 200:
        raise RuntimeError(f"Google Sheets {res.status_code}: {res.text[:300]}")
    values = res.json().get("values", [])
    head = [str(h).strip() for h in (values[0] if values else [])]
    missing = [c for c in BOARD_COLUMNS if c not in head]
    if missing:
        raise RuntimeError(f"콘텐츠 보드에서 머리글을 찾지 못했습니다: {', '.join(missing)}")
    idx = {c: head.index(c) for c in BOARD_COLUMNS}
    rows = []
    for r in values[1:]:
        if not any(str(c).strip() for c in r):
            continue
        rows.append({c: (str(r[i]) if i < len(r) else "") for c, i in idx.items()})
    return rows


# ---------- 모양 맞추기 ----------

def _week(day):
    d = dt.date.fromisoformat(day)
    return (d - dt.timedelta(days=d.weekday())).isoformat()


def shape(start, end, inflow, users, consults, board):
    """화면이 쓰는 원본 행 세 가지: content(utm별 합), weekly(주·medium별 합), board."""
    keys = set(inflow) | set(users) | set(consults)
    content = []
    for k in keys:
        medium, cont = k
        content.append({
            "medium": medium, "content": cont,
            "inflow": sum(inflow.get(k, {}).values()),
            "users": sum(users.get(k, {}).values()),
            "consults": sum(consults.get(k, {}).values()),
        })
    weekly = {}
    for metric, src in (("users", users), ("consults", consults)):
        for (medium, _), by_day in src.items():
            for day, v in by_day.items():
                w = weekly.setdefault((_week(day), medium), {"week": _week(day), "medium": medium, "users": 0, "consults": 0})
                w[metric] += v
    return {
        "start": start, "end": end,
        "generated_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).isoformat(timespec="minutes"),
        "content": sorted(content, key=lambda r: (-r["users"], -r["inflow"])),
        "weekly": sorted(weekly.values(), key=lambda r: (r["week"], r["medium"])),
        "board": board,
    }


_cache = {}
_lock = threading.Lock()


def load(start, end):
    key = (start, end)
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    data = shape(
        start, end,
        mixpanel_daily("view_insurance_main", "general", start, end),
        mixpanel_daily("view_insurance_main", "unique", start, end),
        mixpanel_daily("click_insurance_apply_submit", "unique", start, end),
        board_rows(),
    )
    with _lock:
        _cache[key] = (time.time(), data)
    return data


# ---------- HTTP (Vercel 함수와 로컬 서버가 같이 씀) ----------

def _json(status, body, extra=None):
    headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store"}
    headers.update(extra or {})
    return status, headers, json.dumps(body, ensure_ascii=False).encode()


def handle_login(method, headers, body):
    if method == "GET":
        return _json(200, {"authed": token_ok(session_from(headers)), "required": login_required()})
    if method == "DELETE":
        return _json(200, {"authed": False}, {"Set-Cookie": session_cookie("", 0)})
    if method != "POST":
        return _json(405, {"error": "허용되지 않은 요청입니다."})
    try:
        password = json.loads(body or b"{}").get("password", "")
    except ValueError:
        password = ""
    if not password_ok(password):
        time.sleep(1)
        return _json(401, {"error": "비밀번호가 맞지 않습니다."})
    return _json(200, {"authed": True}, {"Set-Cookie": session_cookie(make_token(), SESSION_HOURS * 3600)})


def _day(value):
    return dt.date.fromisoformat(value) if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value or "") else None


def handle_data(query, headers, loader=None):
    if not token_ok(session_from(headers)):
        return _json(401, {"error": "로그인이 필요합니다."})
    start, end = _day(query.get("start", "")), _day(query.get("end", ""))
    if not start or not end or start > end:
        return _json(400, {"error": "기간(start, end)을 YYYY-MM-DD로 보내 주세요."})
    if (end - start).days >= MAX_RANGE_DAYS:
        return _json(400, {"error": f"기간은 {MAX_RANGE_DAYS}일 이내로 골라 주세요."})
    try:
        return _json(200, (loader or load)(start.isoformat(), end.isoformat()))
    except Exception as exc:  # 외부 API 실패는 화면에 그대로 보여 준다
        return _json(502, {"error": f"데이터를 불러오지 못했습니다: {exc}"})
