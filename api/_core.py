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

# 접수(상담 DB): 'AJI_비전속GA_계약리스트' 스프레드시트. 서비스 계정에 읽기(뷰어) 공유 필요.
INTAKE_SHEET_ID = os.environ.get("INTAKE_SHEET_ID", "14jsEGRKFuigYEoC61vk57KcrBBAxAzQ9V9VslKyMQY4")
INTAKE_SANG_RANGE = "'AJI_DB_DISCO_상담'!A2:L"   # A상담번호·D상태·H등록일·J최초유입처만 쓴다(B·C 등 PII 열은 읽되 쓰지 않음)
INTAKE_UTM_RANGE = "'AJI_DB_DISCO_UTM'!A2:I"     # A상담번호·I utm_content
INTAKE_CONTRACT = "계약"                          # 상태 == '계약'을 계약 체결로 본다(시트의 '체결' 열은 비어 있어 못 씀)

SESSION_COOKIE = "cj_session"
SESSION_HOURS = 12
CACHE_SECONDS = 60 * 60
MAX_RANGE_DAYS = 400
MEASURE_START = "2026-08-24"  # Mixpanel 보험 랜딩 측정 시작일

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


def _segmentation(params):
    """Mixpanel Segmentation API 한 번. 조회 한도(429: 프로젝트당 시간당 60회·동시 5회, eta-bay와 같이 씀)에 걸리면
    잠깐 쉬었다가 두 번까지 다시 시도한다."""
    user = os.environ.get("MIXPANEL_SA_USERNAME")
    secret = os.environ.get("MIXPANEL_SA_SECRET")
    if not user or not secret:
        raise RuntimeError("MIXPANEL_SA_USERNAME / MIXPANEL_SA_SECRET 환경변수를 설정하세요.")
    for attempt in range(3):
        res = requests.get(f"{MP_HOST}/api/query/segmentation", params={"project_id": PROJECT_ID, **params},
                           auth=(user, secret), timeout=40)
        if res.status_code != 429 or attempt == 2:
            break
        try:
            wait = min(8, max(2, int(res.headers.get("Retry-After", "4"))))
        except ValueError:
            wait = 4
        time.sleep(wait)
    if res.status_code == 429:
        raise RuntimeError("Mixpanel 조회 한도를 넘었습니다(프로젝트당 시간당 60회, eta-bay와 같이 씀). "
                           "몇 분 뒤 새로고침해 주세요.")
    if res.status_code != 200:
        raise RuntimeError(f"Mixpanel {res.status_code}: {res.text[:300]}")
    return res.json().get("data", {}).get("values", {})


def mixpanel_daily(event, kind, start, end):
    """{(medium, content): {day: count}}. kind="general"은 전체 횟수, "unique"는 일별 고유 사용자 수."""
    values = _segmentation({"event": event, "from_date": start, "to_date": end,
                            "on": UTM_KEY, "where": OWNED_WHERE, "type": kind, "unit": "day", "limit": 10000})
    out = {}
    for key, by_day in values.items():
        medium, _, content = key.partition("|")
        k = (_clean(medium), _clean(content))
        days = out.setdefault(k, {})
        for day, v in by_day.items():
            days[day] = days.get(day, 0) + (v or 0)
    return out


def mixpanel_medium_daily(event, kind, start, end):
    """{medium: {day: count}}. 채널 합계용. utm_content별 고유 사용자를 더하면 여러 콘텐츠를 본 사람이 겹쳐 세어지므로 따로 받는다."""
    values = _segmentation({"event": event, "from_date": start, "to_date": end,
                            "on": 'properties["utm_medium"]', "where": OWNED_WHERE, "type": kind, "unit": "day", "limit": 1000})
    return {_clean(m): {d: v or 0 for d, v in by_day.items()} for m, by_day in values.items()}


def mixpanel_tips(event, kind, start, end):
    """{꿀팁 경로: {day: count}}. 보험 랜딩 직전 페이지(previous_path)가 꿀팁 글인 이벤트."""
    values = _segmentation({"event": event, "from_date": start, "to_date": end,
                            "on": 'properties["previous_path"]', "where": '"basic-tip/detail" in properties["previous_path"]',
                            "type": kind, "unit": "day", "limit": 10000})
    return {str(path): {d: v or 0 for d, v in by_day.items()} for path, by_day in values.items()}


def tip_title(path):
    """'/contents/basic-tip/detail/<제목>-<번호>' 를 풀어 (제목, 번호|None). 잘린 주소는 번호가 없다."""
    s = re.sub(r"%[0-9A-Fa-f]?$", "", str(path).split("?")[0].split("basic-tip/detail/", 1)[-1])
    s = requests.utils.unquote(s).encode("utf-8", "ignore").decode("utf-8", "ignore").replace("�", "").strip()
    m = re.search(r"-(\d+)$", s)
    return (s[:m.start()] if m else s), (m.group(1) if m else None)


def tip_id_resolver(board):
    """꿀팁 경로 → 글 번호. Mixpanel이 긴 주소를 잘라 번호가 빠지면 콘텐츠 보드 '콘텐츠 URL'의 제목 앞부분으로 맞춘다."""
    titles = []
    for b in board:
        k = str(b.get("Mixpanel 키 (utm_content 일부)", "")).strip()
        url = str(b.get("콘텐츠 URL", "")).strip()
        if b.get("채널") == "꿀팁게시판" and k.isdigit() and "basic-tip/detail/" in url:
            titles.append((tip_title(url)[0], k))

    def resolve(path):
        title, pid = tip_title(path)
        if not pid and len(title) >= 8:
            pid = next((k for t, k in titles if t.startswith(title)), None)
        return pid
    return resolve


def _sheets_token():
    from google.oauth2 import service_account
    import google.auth.transport.requests

    raw = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    if not raw:
        raise RuntimeError("GOOGLE_SERVICE_ACCOUNT_JSON 환경변수를 설정하세요.")
    creds = service_account.Credentials.from_service_account_info(
        json.loads(raw), scopes=["https://www.googleapis.com/auth/spreadsheets.readonly"])
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def _sheet_values(sheet_id, a1):
    res = requests.get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}/values/{requests.utils.quote(a1)}",
        headers={"Authorization": f"Bearer {_sheets_token()}"}, timeout=60,
    )
    if res.status_code != 200:
        raise RuntimeError(f"Google Sheets {res.status_code}: {res.text[:300]}")
    return res.json().get("values", [])


def _sheet_batch(sheet_id, ranges):
    res = requests.get(
        f"https://sheets.googleapis.com/v4/spreadsheets/{sheet_id}/values:batchGet",
        params=[("ranges", r) for r in ranges],
        headers={"Authorization": f"Bearer {_sheets_token()}"}, timeout=60,
    )
    if res.status_code != 200:
        raise RuntimeError(f"Google Sheets {res.status_code}: {res.text[:300]}")
    return [vr.get("values", []) for vr in res.json().get("valueRanges", [])]


def board_rows():
    values = _sheet_values(BOARD_SHEET_ID, BOARD_RANGE)
    head = [str(h).strip() for h in (values[0] if values else [])]
    missing = [c for c in BOARD_COLUMNS if c not in head]
    if missing:
        raise RuntimeError(f"콘텐츠 보드에서 머리글을 찾지 못했습니다: {', '.join(missing)}")
    idx = {c: head.index(c) for c in BOARD_COLUMNS}
    if "콘텐츠 URL" in head:  # 꿀팁 글 제목 매칭용
        idx["콘텐츠 URL"] = head.index("콘텐츠 URL")
    rows = []
    for r in values[1:]:
        if not any(str(c).strip() for c in r):
            continue
        rows.append({c: (str(r[i]) if i < len(r) else "") for c, i in idx.items()})
    return rows


# ---------- 접수 집계 ----------

def _g(row, i):
    return str(row[i]).strip() if i < len(row) else ""


def _intake_aggregate(sang, utm, board, start, end):
    """상담 DB 행을 일별·유입처별·상태별·콘텐츠별로 집계한다. 계약=상태'계약', 전환율=계약÷접수."""
    keys = []
    for b in board:
        k = str(b.get("Mixpanel 키 (utm_content 일부)", "")).strip()
        if k:
            keys.append({"channel": b.get("채널", ""), "topic": b.get("콘텐츠 주제", ""), "key": k})
    utc = {}
    for r in utm:
        sid = _g(r, 0)
        if sid:
            utc[sid] = _g(r, 8)

    def norm_ch(c):
        return "기타" if c in ("-", "—", "") else c

    daily, chan, status = {}, {}, {}
    content = {k["key"]: {**k, "count": 0, "contracted": 0} for k in keys}
    total = contracted = utm_tagged = matched = 0
    for r in sang:
        d = _g(r, 7)
        if not d or d < start or d > end:
            continue
        st = _g(r, 3)
        is_c = 1 if st == INTAKE_CONTRACT else 0
        ch = norm_ch(_g(r, 9))
        total += 1
        contracted += is_c
        dv = daily.setdefault(d, {"count": 0, "contracted": 0})
        dv["count"] += 1
        dv["contracted"] += is_c
        cv = chan.setdefault(ch, {"count": 0, "contracted": 0})
        cv["count"] += 1
        cv["contracted"] += is_c
        status[st] = status.get(st, 0) + 1
        uc = utc.get(_g(r, 0), "")
        if uc:
            utm_tagged += 1
            hit = False
            for k in keys:
                if k["key"] in uc:
                    content[k["key"]]["count"] += 1
                    content[k["key"]]["contracted"] += is_c
                    hit = True
            if hit:
                matched += 1

    def rate(c, n):
        return round(c / n, 4) if n else None

    daily_list = [{"date": d, **v} for d, v in sorted(daily.items())]
    return {
        "start": daily_list[0]["date"] if daily_list else start,
        "end": daily_list[-1]["date"] if daily_list else end,
        "total": total,
        "contracted": contracted,
        "convRate": rate(contracted, total),
        "days": len(daily_list),
        "avgPerDay": round(total / len(daily_list), 1) if daily_list else 0,
        "utmTagged": utm_tagged,
        "contentMatched": matched,
        "daily": daily_list,
        "byChannel": sorted(
            [{"channel": c, **v, "rate": rate(v["contracted"], v["count"])} for c, v in chan.items()],
            key=lambda x: -x["count"]),
        "byStatus": sorted([{"status": s, "count": n} for s, n in status.items()], key=lambda x: -x["count"]),
        "byContent": sorted(
            [{**v, "rate": rate(v["contracted"], v["count"])} for v in content.values() if v["count"] > 0],
            key=lambda x: -x["count"]),
    }


def intake_data(start, end, board):
    sang, utm = _sheet_batch(INTAKE_SHEET_ID, [INTAKE_SANG_RANGE, INTAKE_UTM_RANGE])
    return _intake_aggregate(sang, utm, board, start, end)


# ---------- 모양 맞추기 ----------

def _week(day):
    d = dt.date.fromisoformat(day)
    return (d - dt.timedelta(days=d.weekday())).isoformat()


def _days(start, end):
    d, last, out = dt.date.fromisoformat(start), dt.date.fromisoformat(end), []
    while d <= last:
        out.append(d.isoformat())
        d += dt.timedelta(days=1)
    return out


def shape(start, end, inflow, users, consults, board, tips=None, overall=None):
    """화면이 쓰는 원본 행. 측정 시작일부터 오늘까지 한 번에 받아 일별 배열(di/du/dc)로 담는다.
    화면이 기간 버튼에 맞춰 그 배열을 잘라 더하므로, 기간을 바꿔도 Mixpanel을 다시 부르지 않는다.
    content에는 콘텐츠 보드 키에 걸리는 utm_content만 담고, 채널마다 '(그 밖 utm_content)' 행
    (= 채널 합계 - 담은 콘텐츠 합)을 더한다. dev/refresh_snapshot.py·assets/live.js와 같은 규칙."""
    dates = _days(start, end)
    arr = lambda by_day: [by_day.get(d, 0) for d in dates]
    keys = [str(b.get("Mixpanel 키 (utm_content 일부)", "")).strip() for b in board]
    keys = [k for k in keys if k]
    content = []
    for k in sorted(set(inflow) | set(users) | set(consults)):
        medium, cont = k
        if not any(key in cont for key in keys):
            continue
        di, du, dc = arr(inflow.get(k, {})), arr(users.get(k, {})), arr(consults.get(k, {}))
        content.append({"medium": medium, "content": cont, "inflow": sum(di), "users": sum(du), "consults": sum(dc),
                        "di": di, "du": du, "dc": dc})
    overall = overall or {}
    for m in sorted(set().union(*(overall.get(x, {}).keys() for x in ("inflow", "users", "consults")))):
        mine = [r for r in content if r["medium"] == m]
        rest = {}
        for x, a in (("inflow", "di"), ("users", "du"), ("consults", "dc")):
            tot = arr(overall.get(x, {}).get(m, {}))
            rest[a] = [tot[i] - sum(r[a][i] for r in mine) for i in range(len(dates))]
        content.append({"medium": m, "content": "(그 밖 utm_content)", "inflow": sum(rest["di"]),
                        "users": sum(rest["du"]), "consults": sum(rest["dc"]), **rest})
    weekly = {}
    for metric in ("users", "consults"):
        for m, by_day in overall.get(metric, {}).items():
            for day, v in by_day.items():
                w = weekly.setdefault((_week(day), m), {"week": _week(day), "medium": m, "users": 0, "consults": 0})
                w[metric] += v or 0
    return {
        "start": start, "end": end, "dates": dates,
        "generated_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).isoformat(timespec="minutes"),
        "content": sorted(content, key=lambda r: (-r["users"], -r["inflow"])),
        "weekly": sorted(weekly.values(), key=lambda r: (r["week"], r["medium"])),
        "board": board,
        "tips": tips or [],
    }


def tips_rows(start, end, board=()):
    """꿀팁 글 번호별 일별 유입·유저·상담(di/du/dc)."""
    resolve = tip_id_resolver(board)
    dates = _days(start, end)
    pos = {d: i for i, d in enumerate(dates)}
    acc = {}
    for a, (event, kind) in (("di", ("view_insurance_main", "general")), ("du", ("view_insurance_main", "unique")),
                             ("dc", ("click_insurance_apply_submit", "unique"))):
        for path, by_day in mixpanel_tips(event, kind, start, end).items():
            pid = resolve(path)
            if not pid:
                continue
            rec = acc.setdefault(pid, {"di": [0] * len(dates), "du": [0] * len(dates), "dc": [0] * len(dates)})
            for day, v in by_day.items():
                if day in pos:
                    rec[a][pos[day]] += v or 0
    return sorted(({"post_id": pid, "inflow": sum(r["di"]), "users": sum(r["du"]), "consults": sum(r["dc"]), **r}
                   for pid, r in acc.items()), key=lambda r: (-r["users"], -r["inflow"]))


_cache = {}
_lock = threading.Lock()


def load(start, end):
    # 화면이 고른 기간과 상관없이 측정 시작일부터 오늘까지 한 번에 받는다(위 shape 설명). 한 시간 동안 다시 부르지 않는다.
    start, end = MEASURE_START, dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).date().isoformat()
    key = (start, end)
    with _lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]
    board = board_rows()
    data = shape(
        start, end,
        mixpanel_daily("view_insurance_main", "general", start, end),
        mixpanel_daily("view_insurance_main", "unique", start, end),
        mixpanel_daily("click_insurance_apply_submit", "unique", start, end),
        board,
        tips_rows(start, end, board),
        {"inflow": mixpanel_medium_daily("view_insurance_main", "general", start, end),
         "users": mixpanel_medium_daily("view_insurance_main", "unique", start, end),
         "consults": mixpanel_medium_daily("click_insurance_apply_submit", "unique", start, end)},
    )
    try:
        data["intake"] = intake_data(start, end, board)
    except Exception as exc:  # 접수 시트 공유 전이어도 나머지 화면은 살린다
        data["intake"] = {"error": f"접수 데이터를 불러오지 못했습니다: {exc}"}
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
