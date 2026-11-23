// 보험 콘텐츠 여정: /api/data의 원본 행(content, weekly, board)으로 화면을 계산해 그린다.
(() => {
  const FIRST = '2026-08-24'; // Mixpanel 보험 랜딩 측정 시작일
  const ORDER = ['유튜브', '블로그', '카페', '인스타', '꿀팁게시판', '커뮤니티'];
  const MEDIUM = { youtube: '유튜브', blog: '블로그', cafe: '카페', Instagram_Reels: '인스타', Instagram_Feed: '인스타', Instagram_Stories: '인스타', instagram: '인스타', basictip: '꿀팁게시판', community: '커뮤니티' };
  const KEY_COL = 'Mixpanel 키 (utm_content 일부)';

  const fmt = d3.format(',');
  const pct = d3.format('.1%');
  const won = (v) => fmt(Math.round(v)) + '원';
  const ymd = d3.timeFormat('%Y-%m-%d');
  const num = (s) => { const n = Number(String(s ?? '').replace(/[,원\s]/g, '')); return s !== '' && s != null && Number.isFinite(n) && n > 0 ? n : null; };
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const chColor = (c) => css('--s' + ((ORDER.indexOf(c) < 0 ? 5 : ORDER.indexOf(c)) + 1));
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const state = { range: 'all', channel: null, page: 'flow', model: null, snapshot: false };
  try { const saved = JSON.parse(localStorage.getItem('cj-view') || '{}'); if (saved.range) state.range = saved.range; if (saved.cStart) state.cStart = saved.cStart; if (saved.cEnd) state.cEnd = saved.cEnd; } catch (e) { /* 저장소 없음 */ }

  // ---------- 기간 ----------
  // 스냅샷에는 측정 마지막 날(dataEnd)이 있어 그 날을 기준으로 7일/4주/전체/직접설정을 계산한다.
  const period = () => {
    if (state.range === 'custom' && state.cStart && state.cEnd) return { start: state.cStart, end: state.cEnd };
    const first = state.dataStart || FIRST;
    const endD = state.dataEnd ? d3.timeParse('%Y-%m-%d')(state.dataEnd) : d3.timeDay.offset(d3.timeDay.floor(new Date()), -1);
    let start = state.range === 'all' ? first : ymd(d3.timeDay.offset(endD, -(Number(state.range) - 1)));
    if (start < first) start = first;
    return { start, end: ymd(endD) };
  };

  // ---------- 계산 (claude.ai 대시보드와 같은 규칙) ----------
  function compute(raw) {
    const p = period();
    const dates = raw.dates || [];
    const idxs = [];
    for (let i = 0; i < dates.length; i++) if (dates[i] >= p.start && dates[i] <= p.end) idxs.push(i);
    // 기간 내 합계. content 행에 일별 배열(di/du/dc)이 있으면 그 기간만 더하고, 없으면 전체 합계를 쓴다.
    const rs = (r, key) => {
      const a = key === 'inflow' ? r.di : key === 'users' ? r.du : r.dc;
      if (!dates.length || !a) return r[key];
      let s = 0; for (const i of idxs) s += a[i] || 0; return s;
    };
    const acc = Object.fromEntries(ORDER.map((c) => [c, { channel: c, inflow: 0, users: 0, consults: 0 }]));
    for (const r of raw.content) {
      const c = MEDIUM[r.medium];
      if (c) { acc[c].inflow += rs(r, 'inflow'); acc[c].users += rs(r, 'users'); acc[c].consults += rs(r, 'consults'); }
    }
    // 발행수: 콘텐츠 보드 발행일이 선택 기간 안인 콘텐츠 수. 발행 예정: 발행일이 오늘 이후(예약 발행)인 수.
    const today = ymd(new Date());
    const pubDate = (b) => { const s = String(b['발행일'] || '').trim().slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
    const pubWeeks = new Map(); // 주 시작일(월) → { 채널: 발행수 }
    for (const b of raw.board) {
      const c = acc[b['채널']], d = pubDate(b);
      if (!c || !d) continue;
      if (d > today) c.scheduled = (c.scheduled || 0) + 1;
      else if (d >= p.start && d <= p.end) {
        c.published = (c.published || 0) + 1;
        const w = ymd(d3.timeMonday.floor(d3.timeParse('%Y-%m-%d')(d)));
        if (!pubWeeks.has(w)) pubWeeks.set(w, {});
        const x = pubWeeks.get(w); x[b['채널']] = (x[b['채널']] || 0) + 1;
      }
    }
    const channels = ORDER.map((c) => ({ ...acc[c], published: acc[c].published || 0, scheduled: acc[c].scheduled || 0, rate: acc[c].users ? acc[c].consults / acc[c].users : null }))
      .filter((r) => r.users || r.inflow || r.consults || r.published || r.scheduled);
    const sum = (k) => d3.sum(channels, (r) => r[k]);
    const top = channels.reduce((b, r) => (!b || r.users > b.users ? r : b), null);
    const kpi = { inflow: sum('inflow'), users: sum('users'), consults: sum('consults'), published: sum('published'), top: top ? top.channel : '—' };
    kpi.rate = kpi.users ? kpi.consults / kpi.users : null;

    const mediumsOf = (ch) => Object.keys(MEDIUM).filter((m) => MEDIUM[m] === ch);
    const contents = [];
    for (const b of raw.board) {
      const key = String(b[KEY_COL] || '').trim();
      if (!key) continue;
      const ms = mediumsOf(b['채널']);
      // 꿀팁게시판은 utm_content가 모두 'landing'이라, 키에 적은 글 번호를 보험 랜딩 직전 페이지의 글 번호와 맞춘다.
      const hits = b['채널'] === '꿀팁게시판'
        ? (raw.tips || []).filter((r) => String(r.post_id) === key)
        : raw.content.filter((r) => ms.includes(r.medium) && String(r.content).includes(key));
      const s = (k) => d3.sum(hits, (r) => rs(r, k));
      const users = s('users'), consults = s('consults'), cost = num(b['비용(원)']);
      contents.push({ channel: b['채널'], topic: b['콘텐츠 주제'], stage: b['현재 단계'], views: num(b['조회수']), inflow: s('inflow'), users, consults, rate: users ? consults / users : null, cpa: cost && consults ? cost / consults : null });
    }
    contents.sort((a, b) => b.users - a.users || b.inflow - a.inflow);

    // 흐름도는 채널마다 유저가 많은 콘텐츠 상위 몇 개만 칸을 주고, 나머지는 '그 밖 (N개)'으로 묶는다.
    // 채널 하나만 골랐을 때는 칸을 더 준다. 묶인 콘텐츠는 '콘텐츠 성과' 표에서 모두 볼 수 있다.
    const TOP = state.channel ? 10 : 5;
    const flow = [];
    for (const ch of channels) {
      if (!ch.users) continue;
      const all = contents.filter((c) => c.channel === ch.channel && c.users > 0).sort((a, b) => b.users - a.users || b.consults - a.consults);
      const mine = all.slice(0, TOP), hidden = all.length - mine.length;
      let u = 0, c = 0;
      for (const x of mine) {
        const node = x.topic + ' · ' + ch.channel;
        flow.push({ step: 1, channel: ch.channel, from: ch.channel, to: node, users: x.users });
        flow.push({ step: 2, channel: ch.channel, from: node, to: '상담 신청', users: x.consults });
        flow.push({ step: 2, channel: ch.channel, from: node, to: '미신청', users: x.users - x.consults });
        u += x.users; c += x.consults;
      }
      const ru = Math.max(0, ch.users - u), rc = Math.min(ru, Math.max(0, ch.consults - c));
      if (ru > 0) {
        const other = (hidden ? `그 밖 (콘텐츠 ${hidden}개 외)` : '그 밖') + ' · ' + ch.channel;
        flow.push({ step: 1, channel: ch.channel, from: ch.channel, to: other, users: ru });
        flow.push({ step: 2, channel: ch.channel, from: other, to: '상담 신청', users: rc });
        flow.push({ step: 2, channel: ch.channel, from: other, to: '미신청', users: ru - rc });
      }
    }

    const sw = ymd(d3.timeMonday.floor(d3.timeParse('%Y-%m-%d')(p.start)));
    const wk = new Map();
    for (const r of raw.weekly) {
      const ch = MEDIUM[r.medium];
      if (!ch) continue;
      if (r.week < sw || r.week > p.end) continue;
      const id = r.week + '|' + ch;
      if (!wk.has(id)) wk.set(id, { week: r.week, channel: ch, users: 0, consults: 0 });
      const x = wk.get(id); x.users += r.users; x.consults += r.consults;
    }
    const weekly = [...wk.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
    const pipeline = raw.board.filter((b) => b['콘텐츠 주제']).map((b) => ({ stage: b['현재 단계'], channel: b['채널'], topic: b['콘텐츠 주제'], owner: b['담당자'] }));
    const pubWeekly = [...pubWeeks.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([week, by]) => ({ week, by }));
    return { channels, kpi, contents, flow: flow.filter((l) => l.users > 0), weekly, pipeline, pubWeekly, intake: raw.intake };
  }

  // ---------- 그리기 ----------
  function render() {
    const m = state.model;
    $$('[data-range]').forEach((b) => b.classList.toggle('on', b.dataset.range === state.range));
    $$('[data-ch]').forEach((b) => b.classList.toggle('on', (b.dataset.ch || null) === state.channel));
    const p = period();
    $('#period').textContent = p.start + ' ~ ' + p.end;
    if (!m) return;
    $('#updated').textContent = m.raw.generated_at ? '조회 ' + m.raw.generated_at.replace('T', ' ').slice(0, 16) : '';
    const k = m.kpi;
    const kv = { users: fmt(k.users), consults: fmt(k.consults), rate: k.rate == null ? '—' : pct(k.rate), inflow: fmt(k.inflow), published: fmt(k.published), top: k.top };
    $$('[data-k]').forEach((el) => { el.textContent = kv[el.dataset.k]; });
    const kp = $('[data-k="published"]');
    if (kp && state.channel) { const r = m.channels.find((x) => x.channel === state.channel); kp.textContent = fmt(r ? r.published : 0); }
    drawChannels(m); drawContents(m); drawPipeline(m); drawPubTable(m);
    if (state.page === 'channels') drawPubBars($('#pub-chart'), m);
    if (state.page === 'flow') drawChannelBars($('#flow-chart'), m);
    if (state.page === 'flow' && $('#journey-chart')) drawFlow($('#journey-chart'), m);
    if (state.page === 'channels') drawWeekly($('#weekly-chart'), m);
    if (state.page === 'intake') drawIntake(m);
    drawReport(m);
  }

  // ---------- 주간 보고 ----------
  // 자동 숫자는 지금 기간의 모델에서, 직접 입력 칸은 이 브라우저(localStorage)에 저장한다.
  const RP_KEY = 'cj-weekly-report-v1';
  const rpFields = () => $$('[data-rp]');
  const rpGet = (el) => (el.matches('input') ? el.value : el.innerText);
  const rpNum = (k) => { const el = $(`[data-rp="${k}"]`); const s = el ? String(el.value || '').replace(/[,\s]/g, '') : ''; return s === '' || !Number.isFinite(Number(s)) ? null : Number(s); };
  const rpPh = (el) => { if (el.matches('.cj-edit')) el.toggleAttribute('data-empty', el.innerText.trim() === ''); };
  let rpTimer;
  function rpSave() {
    const o = {}; for (const el of rpFields()) o[el.dataset.rp] = rpGet(el);
    try { localStorage.setItem(RP_KEY, JSON.stringify(o)); $('#rp-status').textContent = '저장됨 ' + new Date().toLocaleTimeString('ko-KR').slice(0, 8); }
    catch (e) { $('#rp-status').textContent = '저장 불가(브라우저 설정)'; }
    clearTimeout(rpTimer); rpTimer = setTimeout(() => { $('#rp-status').textContent = '자동 저장됨'; }, 1500);
  }
  function rpRestore() {
    let o = {}; try { o = JSON.parse(localStorage.getItem(RP_KEY) || '{}'); } catch (e) { /* 저장소 없음 */ }
    for (const el of rpFields()) { const v = o[el.dataset.rp]; if (v) { if (el.matches('input')) el.value = v; else el.innerText = v; } rpPh(el); }
  }
  function rpCalc() {
    const set = (k, v) => { const el = $(`[data-rpc="${k}"]`); if (el) el.textContent = v; };
    const p1 = (a, b) => (a / b * 100).toFixed(1) + '%';
    const total = rpNum('totalDb'), valid = rpNum('validDb'), consult = rpNum('consult');
    set('validRate', total > 0 && valid != null ? p1(valid, total) : '—');
    set('connRate', total > 0 && consult != null ? p1(consult, total) : '—');
    const pDb = rpNum('prevDb'), pCon = rpNum('prevConsult');
    set('prevRate', pDb > 0 && pCon != null ? `지난주 연결율 ${p1(pCon, pDb)}` : '');
    if (pCon != null && consult != null) {
      const d = consult - pCon;
      set('connDiff', (d > 0 ? '+' : '') + fmt(d) + '건');
      const pp = total > 0 && pDb > 0 ? consult / total * 100 - pCon / pDb * 100 : null;
      set('connDiffNote', [pCon > 0 ? `${d >= 0 ? '+' : ''}${(d / pCon * 100).toFixed(1)}%` : '', pp == null ? '' : `연결율 ${pp >= 0 ? '+' : ''}${pp.toFixed(1)}%p`].filter(Boolean).join(' · '));
    } else { set('connDiff', '—'); set('connDiffNote', ''); }
    if (total != null && consult != null) {
      const nc = total - consult;
      set('ncTotal', fmt(nc) + '건');
      const parts = [['부재', rpNum('ncAbsent')], ['대기중', rpNum('ncWaiting')], ['기타', rpNum('ncEtc')]].filter(([, v]) => v != null);
      const sum = parts.reduce((s, [, v]) => s + v, 0);
      set('ncNote', parts.length && nc > 0 ? parts.map(([n, v]) => `${n} ${p1(v, nc)}`).join(' · ') + (sum !== nc ? ` (입력 합 ${sum}, 차이 ${nc - sum})` : '') : '');
    } else { set('ncTotal', '—'); set('ncNote', ''); }
  }
  function drawReport(m) {
    if (!$('#report')) return;
    const p = period();
    $('#rp-period').textContent = p.start + ' ~ ' + p.end;
    const byCh = Object.fromEntries(m.channels.map((r) => [r.channel, r]));
    for (const el of $$('[data-rpa]')) {
      const k = el.dataset.rpa;
      if (k.startsWith('pub:')) el.textContent = fmt((byCh[k.slice(4)] || {}).published || 0);
      else if (k === 'pubTotal') el.textContent = fmt(m.kpi.published || 0);
      else if (k === 'rate') el.textContent = m.kpi.rate == null ? '—' : pct(m.kpi.rate);
      else el.textContent = fmt(m.kpi[k] || 0);
    }
    const tb = $('#rp-channels'); tb.replaceChildren();
    for (const r of m.channels) {
      const tr = document.createElement('tr');
      cell(tr, r.channel); cell(tr, fmt(r.published), 'cj-num'); cell(tr, fmt(r.users), 'cj-num');
      cell(tr, fmt(r.consults), 'cj-num'); cell(tr, r.rate == null ? '—' : pct(r.rate), 'cj-num');
      tb.append(tr);
    }
    rpCalc();
  }
  if ($('#report')) {
    rpRestore();
    $('#report').addEventListener('input', (e) => { const el = e.target.closest('[data-rp]'); if (!el) return; rpPh(el); rpCalc(); rpSave(); });
    $('#rp-print').addEventListener('click', () => { if (state.page !== 'report') go('report'); window.print(); });
    $('#rp-reset').addEventListener('click', () => {
      if (!confirm('새 주차로 초기화할까요? (입력 내용이 지워집니다)')) return;
      for (const el of rpFields()) { if (el.matches('input')) el.value = ''; else el.innerText = ''; rpPh(el); }
      rpCalc(); rpSave();
    });
  }

  const cell = (tr, text, cls) => { const td = document.createElement('td'); if (cls) td.className = cls; td.textContent = text; tr.append(td); return td; };
  const barCell = (tr, value, max, color, width) => {
    const td = cell(tr, '', 'cj-num'); const wrap = document.createElement('div'); wrap.className = 'cj-bar';
    const bar = document.createElement('i'); bar.style.width = (value / max * width) + 'rem'; bar.style.background = color;
    const t = document.createElement('span'); t.textContent = fmt(value); wrap.append(bar, t); td.append(wrap);
  };

  function drawChannels(m) {
    const tb = $('#channel-rows'); tb.replaceChildren();
    const max = d3.max(m.channels, (r) => r.users) || 1;
    for (const r of m.channels) {
      const tr = document.createElement('tr');
      if (state.channel && r.channel !== state.channel) tr.className = 'cj-dim';
      cell(tr, r.channel); barCell(tr, r.users, max, chColor(r.channel), 6);
      cell(tr, fmt(r.consults), 'cj-num'); cell(tr, r.rate == null ? '—' : pct(r.rate), 'cj-num'); cell(tr, fmt(r.inflow), 'cj-num');
      cell(tr, fmt(r.published), 'cj-num'); cell(tr, r.scheduled ? fmt(r.scheduled) : '—', 'cj-num');
      tb.append(tr);
    }
  }

  // 채널별 발행수 막대: 기간 내 발행(진하게) + 발행 예정(옅게).
  function drawPubBars(el, m) {
    if (!el) return;
    el.replaceChildren();
    const rows = m.channels.filter((r) => r.published || r.scheduled);
    if (!rows.length) { const d = document.createElement('div'); d.className = 'cj-loading'; d.textContent = '이 기간에는 발행한 콘텐츠가 없습니다.'; el.append(d); return; }
    const W = Math.max(320, el.clientWidth), rowH = 40, bh = 18, padT = 8;
    const H = padT * 2 + rows.length * rowH;
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', '채널별 발행수');
    const measure = (t) => { const x = svg.append('text').text(t); const w = x.node().getComputedTextLength(); x.remove(); return w; };
    const lab = (r) => `발행 ${fmt(r.published)}` + (r.scheduled ? ` · 예정 ${fmt(r.scheduled)}` : '');
    const left = (d3.max(rows, (r) => measure(r.channel)) || 0) + 14;
    const right = (d3.max(rows, (r) => measure(lab(r))) || 0) + 14;
    const x = d3.scaleLinear([0, d3.max(rows, (r) => r.published + r.scheduled) || 1], [left, Math.max(left + 10, W - right)]);
    const tip = tipper(el);
    rows.forEach((r, i) => {
      const y = padT + i * rowH + (rowH - bh) / 2;
      const dim = state.channel && state.channel !== r.channel ? 0.25 : 1;
      const g = svg.append('g').attr('opacity', dim);
      g.append('text').attr('x', left - 10).attr('y', y + bh / 2 + 4).attr('text-anchor', 'end').text(r.channel);
      g.append('rect').attr('x', left).attr('y', y).attr('width', Math.max(0, x(r.published) - left)).attr('height', bh).attr('rx', 3).attr('fill', chColor(r.channel));
      g.append('rect').attr('x', x(r.published)).attr('y', y).attr('width', Math.max(0, x(r.published + r.scheduled) - x(r.published))).attr('height', bh).attr('rx', 3).attr('fill', chColor(r.channel)).attr('opacity', 0.3);
      g.append('text').attr('class', 'cj-sub').attr('x', x(r.published + r.scheduled) + 8).attr('y', y + bh / 2 + 4).text(lab(r));
      g.append('rect').attr('x', left).attr('y', y).attr('width', Math.max(1, x(r.published + r.scheduled) - left)).attr('height', bh).attr('fill', 'transparent')
        .on('mousemove', (ev) => tip.show(ev, r.channel, [`기간 내 발행 ${fmt(r.published)}건`, `발행 예정 ${fmt(r.scheduled)}건`]))
        .on('mouseleave', () => tip.hide());
    });
  }

  // 주별 채널 발행수 표 (최근 주가 위).
  function drawPubTable(m) {
    const head = $('#pub-head'), tb = $('#pub-rows');
    if (!head || !tb) return;
    const chs = ORDER.filter((c) => m.channels.some((r) => r.channel === c && r.published) && (!state.channel || state.channel === c));
    head.replaceChildren();
    const hr = document.createElement('tr');
    for (const [t, cls] of [['주 (월요일 시작)', '']].concat(chs.map((c) => [c, 'cj-num']), [['합계', 'cj-num']])) { const th = document.createElement('th'); th.textContent = t; if (cls) th.className = cls; hr.append(th); }
    head.append(hr);
    tb.replaceChildren();
    for (const w of m.pubWeekly) {
      const total = d3.sum(chs, (c) => w.by[c] || 0);
      if (!total) continue;
      const tr = document.createElement('tr');
      cell(tr, d3.timeFormat('%-m월 %-d일 주')(d3.timeParse('%Y-%m-%d')(w.week)));
      for (const c of chs) cell(tr, w.by[c] ? fmt(w.by[c]) : '—', 'cj-num');
      cell(tr, fmt(total), 'cj-num');
      tb.append(tr);
    }
  }

  function drawContents(m) {
    const tb = $('#content-rows'); tb.replaceChildren();
    const max = d3.max(m.contents, (r) => r.users) || 1;
    for (const r of m.contents) {
      if (state.channel && r.channel !== state.channel) continue;
      const tr = document.createElement('tr');
      cell(tr, r.channel); cell(tr, r.topic);
      const st = cell(tr, ''); const pill = document.createElement('span'); pill.className = 'cj-pill'; pill.textContent = r.stage || '—'; st.append(pill);
      cell(tr, r.views == null ? '—' : fmt(r.views), 'cj-num');
      barCell(tr, r.users, max, chColor(r.channel), 5);
      cell(tr, fmt(r.consults), 'cj-num'); cell(tr, r.rate == null ? '—' : pct(r.rate), 'cj-num');
      cell(tr, fmt(r.inflow), 'cj-num'); cell(tr, r.cpa == null ? '—' : won(r.cpa), 'cj-num');
      tb.append(tr);
    }
  }

  function drawPipeline(m) {
    for (const el of $$('[data-n]')) el.textContent = fmt(m.pipeline.filter((r) => r.stage === el.dataset.n).length);
    for (const el of $$('[data-stage]')) {
      el.replaceChildren();
      for (const r of m.pipeline.filter((x) => x.stage === el.dataset.stage && (!state.channel || x.channel === state.channel))) {
        const card = document.createElement('div'); card.className = 'cj-item'; card.style.borderLeft = '3px solid ' + chColor(r.channel);
        const s = document.createElement('strong'); s.textContent = r.topic;
        const meta = document.createElement('span'); meta.textContent = [r.channel, r.owner].filter(Boolean).join(' · ');
        card.append(s, meta); el.append(card);
      }
    }
  }

  function tipper(el) {
    const tip = d3.select(el).append('div').attr('class', 'cj-tip').style('display', 'none');
    return {
      show(ev, head, lines) {
        tip.style('display', null).selectAll('*').remove();
        tip.append('div').attr('class', 'cj-tip-h').text(head);
        for (const l of [].concat(lines)) tip.append('div').text(l);
        const [mx, my] = d3.pointer(ev, el);
        const tw = tip.node().offsetWidth;
        tip.style('left', Math.min(Math.max(0, mx + 12), el.clientWidth - tw) + 'px').style('top', (my + 12) + 'px');
      },
      hide() { tip.style('display', 'none'); },
    };
  }

  // 흐름(Sankey) 대신 채널별 막대: 랜딩 유저(막대) + 상담 신청(초록) + 전환율(라벨). 선택 기간 반영.
  function drawChannelBars(el, m) {
    el.replaceChildren();
    const rows = (m.channels || []).filter((r) => r.users || r.inflow || r.consults);
    if (!rows.length) { const d = document.createElement('div'); d.className = 'cj-loading'; d.textContent = '이 기간에는 유입이 없습니다.'; el.append(d); return; }
    const W = Math.max(320, el.clientWidth);
    const rowH = 46, padT = 10, padB = 16, bh = 20;
    const H = padT + rows.length * rowH + padB;
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', '채널별 랜딩 유저와 상담 신청');
    const measure = (t) => { const x = svg.append('text').text(t); const w = x.node().getComputedTextLength(); x.remove(); return w; };
    const lab = (r) => `유저 ${fmt(r.users)} · 상담 ${fmt(r.consults)} · ${r.rate == null ? '—' : pct(r.rate)}`;
    const left = (d3.max(rows, (r) => measure(r.channel)) || 0) + 14;
    const right = (d3.max(rows, (r) => measure(lab(r))) || 0) + 14;
    const x = d3.scaleLinear([0, d3.max(rows, (r) => r.users) || 1], [left, Math.max(left + 10, W - right)]);
    const tip = tipper(el);
    const ok = css('--ok');
    rows.forEach((r, i) => {
      const y = padT + i * rowH + (rowH - bh) / 2;
      const g = svg.append('g');
      g.append('text').attr('x', left - 10).attr('y', y + bh / 2 + 4).attr('text-anchor', 'end').text(r.channel);
      g.append('rect').attr('x', left).attr('y', y).attr('width', Math.max(0, x(r.users) - left)).attr('height', bh).attr('rx', 3).attr('fill', chColor(r.channel)).attr('opacity', 0.35);
      g.append('rect').attr('x', left).attr('y', y).attr('width', Math.max(0, x(r.consults) - left)).attr('height', bh).attr('rx', 3).attr('fill', ok);
      g.append('text').attr('class', 'cj-sub').attr('x', x(r.users) + 8).attr('y', y + bh / 2 + 4).text(lab(r));
      g.append('rect').attr('x', left).attr('y', y).attr('width', Math.max(1, x(r.users) - left)).attr('height', bh).attr('fill', 'transparent')
        .on('mousemove', (ev) => tip.show(ev, r.channel, [`랜딩 유저 ${fmt(r.users)}명`, `상담 신청 ${fmt(r.consults)}명`, `전환율 ${r.rate == null ? '—' : pct(r.rate)}`]))
        .on('mouseleave', () => tip.hide());
    });
  }

  function drawFlow(el, m) {
    el.replaceChildren();
    const links = m.flow.filter((l) => !state.channel || l.channel === state.channel).map((l) => ({ ...l }));
    if (!links.length) { const d = document.createElement('div'); d.className = 'cj-loading'; d.textContent = '이 기간에는 유입이 없습니다.'; el.append(d); return; }
    const W = Math.max(320, el.clientWidth);
    const cols = [[], [], []];
    const nodes = new Map();
    const node = (name, col) => { if (!nodes.has(name)) { const n = { name, col, inV: 0, outV: 0, inOff: 0, outOff: 0 }; nodes.set(name, n); cols[col].push(n); } return nodes.get(name); };
    for (const l of links) { l.a = node(l.from, l.step - 1); l.b = node(l.to, l.step); l.a.outV += l.users; l.b.inV += l.users; }
    for (const n of nodes.values()) n.v = Math.max(n.inV, n.outV);
    for (const l of links) if (l.step === 2 && l.to === '상담 신청') l.a.cons = (l.a.cons || 0) + l.users;
    cols[0].sort((a, b) => b.v - a.v);
    const chIdx = new Map(cols[0].map((n, i) => [n.name, i]));
    const chOf = (n) => links.find((l) => l.b === n || l.a === n).channel;
    cols[1].sort((a, b) => (chIdx.get(chOf(a)) - chIdx.get(chOf(b))) || (a.name.startsWith('그 밖') - b.name.startsWith('그 밖')) || (b.v - a.v));
    cols[2].sort((a, b) => (a.name === '상담 신청' ? -1 : b.name === '상담 신청' ? 1 : 0));
    const pad = 12, nw = 12, MINH = 22, MARGIN = 16;
    // 값에 비례한 높이를 쓰되, 라벨(이름+숫자 2줄)이 보이도록 노드마다 최소 높이를 보장한다.
    const baseH = Math.max(320, cols[1].length * 30 + 40);
    const k = Math.min(...cols.filter((c) => c.length).map((c) => (baseH - pad * (c.length - 1)) / d3.sum(c, (n) => n.v)));
    for (const c of cols) for (const n of c) n.h = Math.max(MINH, n.v * k);
    const colH = (c) => d3.sum(c, (n) => n.h) + pad * (c.length - 1);
    const H = Math.max(baseH, d3.max(cols, colH) || 0) + MARGIN * 2;
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', '채널에서 콘텐츠를 거쳐 상담 신청까지의 흐름');
    const measure = (t) => { const x = svg.append('text').text(t); const w = x.node().getComputedTextLength(); x.remove(); return w; };
    const lab = (n) => n.name.split(' · ')[0];
    const left = d3.max(cols[0], (n) => measure(lab(n))) + 14;
    const right = d3.max(cols[2], (n) => Math.max(measure(lab(n)), measure(fmt(n.v) + '명'))) + 14;
    const xs = [left, left + (W - left - right - nw) * 0.5, W - right - nw];
    for (const c of cols) {
      let y = (H - colH(c)) / 2;
      for (const n of c) { n.x = xs[n.col]; n.y = y; y += n.h + pad; }
    }
    const tip = tipper(el);
    const ok = css('--ok'), muted = css('--chart-muted');
    const g = svg.append('g').attr('fill', 'none');
    const ordered = links.filter((x) => x.step === 1).sort((p, q) => cols[1].indexOf(p.b) - cols[1].indexOf(q.b))
      .concat(links.filter((x) => x.step === 2).sort((p, q) => (cols[1].indexOf(p.a) - cols[1].indexOf(q.a)) || (p.to === '상담 신청' ? -1 : 1)));
    for (const l of ordered) {
      const w = l.users * k;
      const y0 = l.a.y + l.a.outOff + w / 2, y1 = l.b.y + l.b.inOff + w / 2;
      l.a.outOff += w; l.b.inOff += w;
      const x0 = l.a.x + nw, x1 = l.b.x, mx = (x0 + x1) / 2;
      const color = l.step === 1 ? chColor(l.channel) : (l.to === '상담 신청' ? ok : muted);
      g.append('path').attr('d', `M${x0},${y0}C${mx},${y0} ${mx},${y1} ${x1},${y1}`)
        .attr('stroke', color).attr('stroke-opacity', 0.35).attr('stroke-width', Math.max(1, w))
        .on('mousemove', function (ev) { d3.select(this).attr('stroke-opacity', 0.6); tip.show(ev, lab(l.a) + ' → ' + lab(l.b), fmt(l.users) + '명'); })
        .on('mouseleave', function () { d3.select(this).attr('stroke-opacity', 0.35); tip.hide(); });
    }
    const ng = svg.append('g');
    for (const n of nodes.values()) {
      const color = n.col === 0 ? chColor(n.name) : n.col === 1 ? chColor(chOf(n)) : (n.name === '상담 신청' ? ok : muted);
      ng.append('rect').attr('x', n.x).attr('y', n.y).attr('width', nw).attr('height', n.h).attr('rx', 2).attr('fill', color)
        .on('mousemove', (ev) => tip.show(ev, lab(n), fmt(n.v) + '명')).on('mouseleave', () => tip.hide());
      const cy = n.y + n.h / 2;
      if (n.col === 0) {
        ng.append('text').attr('x', n.x - 8).attr('y', cy - 2).attr('text-anchor', 'end').text(lab(n));
        ng.append('text').attr('class', 'cj-sub').attr('x', n.x - 8).attr('y', cy + 12).attr('text-anchor', 'end').text(fmt(n.v) + '명');
      } else if (n.col === 2) {
        ng.append('text').attr('x', n.x + nw + 8).attr('y', cy - 2).text(lab(n));
        ng.append('text').attr('class', 'cj-sub').attr('x', n.x + nw + 8).attr('y', cy + 12).text(fmt(n.v) + '명');
      } else {
        // 이름 · 유저 수 · 상담 수. 상담이 난 콘텐츠는 굵게 표시한다.
        const t = ng.append('text').attr('x', n.x + nw + 6).attr('y', cy + 4).attr('paint-order', 'stroke').attr('stroke', css('--panel')).attr('stroke-width', 4)
          .attr('font-weight', n.cons ? 600 : null);
        t.append('tspan').text(lab(n) + '  ');
        t.append('tspan').attr('fill', css('--muted')).text(fmt(n.v) + '명');
        if (n.cons) t.append('tspan').attr('fill', ok).text(' · 상담 ' + fmt(n.cons));
      }
    }
  }

  function drawWeekly(el, m) {
    el.replaceChildren();
    const rows = m.weekly.map((r) => ({ ...r, date: d3.timeParse('%Y-%m-%d')(r.week.slice(0, 10)) })).filter((r) => r.date);
    if (!rows.length) return;
    const series = d3.groups(rows, (r) => r.channel).filter(([, v]) => d3.sum(v, (r) => r.users) > 0);
    const W = Math.max(320, el.clientWidth), H = 288;
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', '주별 채널 랜딩 유저');
    const measure = (t) => { const x = svg.append('text').text(t); const w = x.node().getComputedTextLength(); x.remove(); return w; };
    const y = d3.scaleLinear([0, d3.max(rows, (r) => r.users) || 1], [H - 28, 12]).nice();
    const ml = d3.max(y.ticks(4), (t) => measure(fmt(t))) + 10;
    const mr = d3.max(series, ([c]) => measure(c)) + 14;
    const dates = [...new Set(rows.map((r) => +r.date))].sort((a, b) => a - b).map((t) => new Date(t));
    const x = d3.scaleTime(d3.extent(dates), [ml, W - mr]);
    svg.append('g').selectAll('line').data(y.ticks(4)).join('line').attr('x1', ml).attr('x2', W - mr).attr('y1', y).attr('y2', y).attr('stroke', css('--grid'));
    svg.append('g').selectAll('text').data(y.ticks(4)).join('text').attr('x', ml - 6).attr('y', (t) => y(t) + 4).attr('text-anchor', 'end').text(fmt);
    svg.append('g').selectAll('text').data(x.ticks(Math.max(2, Math.floor((W - ml - mr) / 90)))).join('text').attr('x', x).attr('y', H - 8).attr('text-anchor', 'middle').text(d3.timeFormat('%-m/%-d'));
    const line = d3.line().x((r) => x(r.date)).y((r) => y(r.users));
    const ends = [];
    for (const [c, v] of series) {
      const dim = state.channel && state.channel !== c;
      svg.append('path').datum(v).attr('d', line).attr('fill', 'none').attr('stroke', chColor(c)).attr('stroke-width', 2).attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round').attr('opacity', dim ? 0.2 : 1);
      ends.push({ c, y: y(v[v.length - 1].users), dim });
    }
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 13) ends[i].y = ends[i - 1].y + 13;
    for (const e of ends) svg.append('text').attr('x', W - mr + 6).attr('y', e.y + 4).style('fill', chColor(e.c)).attr('opacity', e.dim ? 0.3 : 1).text(e.c);
    const tip = tipper(el);
    const rule = svg.append('line').attr('y1', 12).attr('y2', H - 28).attr('stroke', css('--muted')).style('display', 'none');
    svg.append('rect').attr('x', ml).attr('y', 0).attr('width', W - ml - mr).attr('height', H).attr('fill', 'transparent')
      .on('mousemove', (ev) => {
        const [px] = d3.pointer(ev);
        const dt = dates[d3.minIndex(dates, (t) => Math.abs(x(t) - px))];
        rule.style('display', null).attr('x1', x(dt)).attr('x2', x(dt));
        tip.show(ev, d3.timeFormat('%-m월 %-d일 주')(dt), series.map(([c, v]) => { const r = v.find((z) => +z.date === +dt); return c + ' ' + fmt(r ? r.users : 0) + '명 · 상담 ' + fmt(r ? r.consults : 0); }));
      })
      .on('mouseleave', () => { rule.style('display', 'none'); tip.hide(); });
  }

  // ---------- 접수 현황 ----------
  // 접수 현황은 aji-db(채널별 유입 대시보드)로 연결한다. 구글시트 접근 복구 전까지 자체 집계는 중단.
  function drawIntake(m) {
    const note = $('#intake-note');
    if (!note) return;
    const it = m.intake;
    if (it && !it.error && it.total) {
      note.textContent = `참고: content-journey가 마지막으로 집계한 접수는 ${it.start}~${it.end} 기준 ${fmt(it.total)}건(계약 ${fmt(it.contracted)}·전환율 ${it.convRate == null ? '—' : pct(it.convRate)})입니다. 최신 현황은 위 버튼(aji-db)에서 보세요.`;
    } else {
      note.textContent = '';
    }
  }

  function drawIntakeChart(el, it) {
    el.replaceChildren();
    const rows = it.daily.map((d) => ({ ...d, date: d3.timeParse('%Y-%m-%d')(d.date) })).filter((d) => d.date);
    if (!rows.length) return;
    const W = Math.max(320, el.clientWidth), H = 288;
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', '일별 접수와 계약');
    const measure = (t) => { const x = svg.append('text').text(t); const w = x.node().getComputedTextLength(); x.remove(); return w; };
    const y = d3.scaleLinear([0, d3.max(rows, (d) => d.count) || 1], [H - 28, 12]).nice();
    const ml = d3.max(y.ticks(4), (t) => measure(fmt(t))) + 10, mr = 14;
    const x = d3.scaleTime(d3.extent(rows, (d) => d.date), [ml, W - mr]);
    const bw = Math.max(1, (W - ml - mr) / rows.length * 0.7);
    svg.append('g').selectAll('line').data(y.ticks(4)).join('line').attr('x1', ml).attr('x2', W - mr).attr('y1', y).attr('y2', y).attr('stroke', css('--grid'));
    svg.append('g').selectAll('text').data(y.ticks(4)).join('text').attr('x', ml - 6).attr('y', (t) => y(t) + 4).attr('text-anchor', 'end').text(fmt);
    svg.append('g').selectAll('text').data(x.ticks(Math.max(2, Math.floor((W - ml - mr) / 90)))).join('text').attr('x', x).attr('y', H - 8).attr('text-anchor', 'middle').text(d3.timeFormat('%-m/%-d'));
    const tip = tipper(el);
    svg.append('g').selectAll('rect').data(rows).join('rect')
      .attr('x', (d) => x(d.date) - bw / 2).attr('y', (d) => y(d.count)).attr('width', bw).attr('height', (d) => y(0) - y(d.count))
      .attr('fill', css('--accent')).attr('opacity', 0.55).attr('rx', 1)
      .on('mousemove', (ev, d) => tip.show(ev, d3.timeFormat('%-m월 %-d일')(d.date), [fmt(d.count) + '건 접수', '계약 ' + fmt(d.contracted) + '건']))
      .on('mouseleave', () => tip.hide());
    const line = d3.line().x((d) => x(d.date)).y((d) => y(d.contracted));
    svg.append('path').datum(rows).attr('d', line).attr('fill', 'none').attr('stroke', css('--ok')).attr('stroke-width', 1.8).attr('stroke-linejoin', 'round');
  }

  // ---------- 데이터·로그인 ----------
  async function load() {
    $('#error').hidden = true;
    $('.cj-main').classList.add('cj-refreshing');
    const p = period();
    try {
      let body = window.CJ_DATA; // HTML 한 파일 버전은 데이터를 페이지 안에 담고 있다
      if (!body) {
        const res = await fetch(`/api/data?start=${p.start}&end=${p.end}`, { credentials: 'same-origin' });
        body = await res.json().catch(() => ({}));
        if (res.status === 401) { showLogin(); return; }
        if (!res.ok) throw new Error(body.error || `서버 응답 ${res.status}`);
      }
      if (body.dates && body.dates.length) { state.dataStart = body.dates[0]; state.dataEnd = body.dates[body.dates.length - 1]; }
      else if (body.start) { state.dataStart = body.start; state.dataEnd = body.end; }
      const _si = $('#cj-start'), _ei = $('#cj-end');
      if (_si && _ei) { _si.min = _ei.min = state.dataStart || ''; _si.max = _ei.max = state.dataEnd || ''; if (!_si.value) _si.value = state.cStart || state.dataStart || ''; if (!_ei.value) _ei.value = state.cEnd || state.dataEnd || ''; }
      state.snapshot = Boolean(body.snapshot || window.CJ_DATA);
      $('#snapshot').hidden = !state.snapshot;
      if (body.note) $('#snapshot').textContent = body.note;
      state.model = { ...compute(body), raw: body };
    } catch (e) {
      $('#error').textContent = e.message;
      $('#error').hidden = false;
    } finally {
      $('.cj-main').classList.remove('cj-refreshing');
      render();
    }
  }

  window.CJ_RELOAD = load; // 실시간 갱신(live.js)이 새 데이터를 넣은 뒤 다시 그릴 때 쓴다

  function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#password').focus(); }

  async function login() {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('#password').value }) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { $('#login-error').textContent = body.error || '로그인하지 못했습니다.'; $('#login-error').hidden = false; return; }
    $('#login').hidden = true; $('#app').hidden = false; $('#logout').hidden = false; load();
  }

  function go(id) {
    if (!document.getElementById(id)) return;
    state.page = id;
    $$('.cj-page').forEach((s) => { s.hidden = s.id !== id; });
    $$('.cj-nav').forEach((n) => n.classList.toggle('on', n.dataset.go === id));
    try { history.replaceState(null, '', '#' + id); } catch (e) { /* 주소를 바꿀 수 없는 화면 */ }
    render();
  }

  $$('.cj-nav').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  $$('[data-range]').forEach((b) => b.addEventListener('click', () => {
    state.range = b.dataset.range;
    try { localStorage.setItem('cj-view', JSON.stringify({ range: state.range })); } catch (e) { /* 저장소 없음 */ }
    load();
  }));
  $$('[data-ch]').forEach((b) => b.addEventListener('click', () => { state.channel = b.dataset.ch || null; render(); }));
  const applyCustom = () => {
    const s = $('#cj-start'), e = $('#cj-end');
    if (!s || !e || !s.value || !e.value) return;
    state.range = 'custom';
    state.cStart = s.value <= e.value ? s.value : e.value;
    state.cEnd = s.value <= e.value ? e.value : s.value;
    try { localStorage.setItem('cj-view', JSON.stringify({ range: 'custom', cStart: state.cStart, cEnd: state.cEnd })); } catch (e2) { /* 저장소 없음 */ }
    load();
  };
  if ($('#cj-apply')) $('#cj-apply').addEventListener('click', applyCustom);
  $('#login-btn').addEventListener('click', login);
  $('#password').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  $('#logout').addEventListener('click', async () => { await fetch('/api/login', { method: 'DELETE' }); showLogin(); });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });

  (async () => {
    let auth = { authed: true, required: false };
    if (window.CJ_DATA) {
      // 스냅샷에도 일별 데이터가 있어 기간 필터를 쓸 수 있다 (숨기지 않음)
    } else {
      try { auth = await (await fetch('/api/login')).json(); } catch (e) { /* 로그인 API 없음: 열어 둔다 */ }
    }
    if (auth.required && !auth.authed) { showLogin(); return; }
    $('#app').hidden = false;
    $('#logout').hidden = !auth.required;
    const named = location.hash.slice(1);
    if (named) go(named);
    load();
  })();
})();
