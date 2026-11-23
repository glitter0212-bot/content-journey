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
  try { const saved = JSON.parse(localStorage.getItem('cj-view') || '{}'); if (saved.range) state.range = saved.range; } catch (e) { /* 저장소 없음 */ }

  // ---------- 기간 ----------
  const period = () => {
    const end = d3.timeDay.offset(d3.timeDay.floor(new Date()), -1);
    let start = state.range === 'all' ? FIRST : ymd(d3.timeDay.offset(end, -(Number(state.range) - 1)));
    if (start < FIRST) start = FIRST;
    return { start, end: ymd(end) };
  };

  // ---------- 계산 (claude.ai 대시보드와 같은 규칙) ----------
  function compute(raw) {
    const acc = Object.fromEntries(ORDER.map((c) => [c, { channel: c, inflow: 0, users: 0, consults: 0 }]));
    for (const r of raw.content) {
      const c = MEDIUM[r.medium];
      if (c) { acc[c].inflow += r.inflow; acc[c].users += r.users; acc[c].consults += r.consults; }
    }
    const channels = ORDER.map((c) => ({ ...acc[c], rate: acc[c].users ? acc[c].consults / acc[c].users : null })).filter((r) => r.users || r.inflow || r.consults);
    const sum = (k) => d3.sum(channels, (r) => r[k]);
    const top = channels.reduce((b, r) => (!b || r.users > b.users ? r : b), null);
    const kpi = { inflow: sum('inflow'), users: sum('users'), consults: sum('consults'), top: top ? top.channel : '—' };
    kpi.rate = kpi.users ? kpi.consults / kpi.users : null;

    const mediumsOf = (ch) => Object.keys(MEDIUM).filter((m) => MEDIUM[m] === ch);
    const contents = [];
    for (const b of raw.board) {
      const key = String(b[KEY_COL] || '').trim();
      if (!key) continue;
      const ms = mediumsOf(b['채널']);
      const hits = raw.content.filter((r) => ms.includes(r.medium) && String(r.content).includes(key));
      const s = (k) => d3.sum(hits, (r) => r[k]);
      const users = s('users'), consults = s('consults'), cost = num(b['비용(원)']);
      contents.push({ channel: b['채널'], topic: b['콘텐츠 주제'], stage: b['현재 단계'], views: num(b['조회수']), inflow: s('inflow'), users, consults, rate: users ? consults / users : null, cpa: cost && consults ? cost / consults : null });
    }
    contents.sort((a, b) => b.users - a.users || b.inflow - a.inflow);

    const flow = [];
    for (const ch of channels) {
      if (!ch.users) continue;
      const mine = contents.filter((c) => c.channel === ch.channel && c.users > 0);
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
        const other = '그 밖 · ' + ch.channel;
        flow.push({ step: 1, channel: ch.channel, from: ch.channel, to: other, users: ru });
        flow.push({ step: 2, channel: ch.channel, from: other, to: '상담 신청', users: rc });
        flow.push({ step: 2, channel: ch.channel, from: other, to: '미신청', users: ru - rc });
      }
    }

    const wk = new Map();
    for (const r of raw.weekly) {
      const ch = MEDIUM[r.medium];
      if (!ch) continue;
      const id = r.week + '|' + ch;
      if (!wk.has(id)) wk.set(id, { week: r.week, channel: ch, users: 0, consults: 0 });
      const x = wk.get(id); x.users += r.users; x.consults += r.consults;
    }
    const weekly = [...wk.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
    const pipeline = raw.board.filter((b) => b['콘텐츠 주제']).map((b) => ({ stage: b['현재 단계'], channel: b['채널'], topic: b['콘텐츠 주제'], owner: b['담당자'] }));
    return { channels, kpi, contents, flow: flow.filter((l) => l.users > 0), weekly, pipeline };
  }

  // ---------- 그리기 ----------
  function render() {
    const m = state.model;
    $$('[data-range]').forEach((b) => b.classList.toggle('on', b.dataset.range === state.range));
    $$('[data-ch]').forEach((b) => b.classList.toggle('on', (b.dataset.ch || null) === state.channel));
    const p = period();
    $('#period').textContent = state.snapshot && m ? m.raw.start + ' ~ ' + m.raw.end : p.start + ' ~ ' + p.end;
    if (!m) return;
    $('#updated').textContent = m.raw.generated_at ? '조회 ' + m.raw.generated_at.replace('T', ' ').slice(0, 16) : '';
    const k = m.kpi;
    const kv = { users: fmt(k.users), consults: fmt(k.consults), rate: k.rate == null ? '—' : pct(k.rate), inflow: fmt(k.inflow), top: k.top };
    $$('[data-k]').forEach((el) => { el.textContent = kv[el.dataset.k]; });
    drawChannels(m); drawContents(m); drawPipeline(m);
    if (state.page === 'flow') drawFlow($('#flow-chart'), m);
    if (state.page === 'channels') drawWeekly($('#weekly-chart'), m);
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
    cols[0].sort((a, b) => b.v - a.v);
    const chIdx = new Map(cols[0].map((n, i) => [n.name, i]));
    const chOf = (n) => links.find((l) => l.b === n || l.a === n).channel;
    cols[1].sort((a, b) => (chIdx.get(chOf(a)) - chIdx.get(chOf(b))) || (a.name.startsWith('그 밖') - b.name.startsWith('그 밖')) || (b.v - a.v));
    cols[2].sort((a, b) => (a.name === '상담 신청' ? -1 : b.name === '상담 신청' ? 1 : 0));
    const pad = 10, nw = 12;
    const H = Math.max(320, cols[1].length * 30 + 40);
    const k = Math.min(...cols.filter((c) => c.length).map((c) => (H - pad * (c.length - 1)) / d3.sum(c, (n) => n.v)));
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', '채널에서 콘텐츠를 거쳐 상담 신청까지의 흐름');
    const measure = (t) => { const x = svg.append('text').text(t); const w = x.node().getComputedTextLength(); x.remove(); return w; };
    const lab = (n) => n.name.split(' · ')[0];
    const left = d3.max(cols[0], (n) => measure(lab(n))) + 14;
    const right = d3.max(cols[2], (n) => Math.max(measure(lab(n)), measure(fmt(n.v) + '명'))) + 14;
    const xs = [left, left + (W - left - right - nw) * 0.5, W - right - nw];
    for (const c of cols) {
      let y = (H - (d3.sum(c, (n) => n.v * k) + pad * (c.length - 1))) / 2;
      for (const n of c) { n.x = xs[n.col]; n.y = y; n.h = Math.max(1, n.v * k); y += n.h + pad; }
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
        ng.append('text').attr('x', n.x + nw + 6).attr('y', cy + 4).attr('paint-order', 'stroke').attr('stroke', css('--panel')).attr('stroke-width', 4)
          .text(lab(n) + '  ' + fmt(n.v));
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

  // ---------- 데이터·로그인 ----------
  async function load() {
    $('#error').hidden = true;
    $('.cj-main').classList.add('cj-refreshing');
    const p = period();
    try {
      const res = await fetch(`/api/data?start=${p.start}&end=${p.end}`, { credentials: 'same-origin' });
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) { showLogin(); return; }
      if (!res.ok) throw new Error(body.error || `서버 응답 ${res.status}`);
      state.snapshot = Boolean(body.snapshot);
      $('#snapshot').hidden = !state.snapshot;
      state.model = { ...compute(body), raw: body };
    } catch (e) {
      $('#error').textContent = e.message;
      $('#error').hidden = false;
    } finally {
      $('.cj-main').classList.remove('cj-refreshing');
      render();
    }
  }

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
    history.replaceState(null, '', '#' + id);
    render();
  }

  $$('.cj-nav').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
  $$('[data-range]').forEach((b) => b.addEventListener('click', () => {
    state.range = b.dataset.range;
    try { localStorage.setItem('cj-view', JSON.stringify({ range: state.range })); } catch (e) { /* 저장소 없음 */ }
    load();
  }));
  $$('[data-ch]').forEach((b) => b.addEventListener('click', () => { state.channel = b.dataset.ch || null; render(); }));
  $('#login-btn').addEventListener('click', login);
  $('#password').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  $('#logout').addEventListener('click', async () => { await fetch('/api/login', { method: 'DELETE' }); showLogin(); });
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); });

  (async () => {
    let auth = { authed: true, required: false };
    try { auth = await (await fetch('/api/login')).json(); } catch (e) { /* 로그인 API 없음: 열어 둔다 */ }
    if (auth.required && !auth.authed) { showLogin(); return; }
    $('#app').hidden = false;
    $('#logout').hidden = !auth.required;
    const named = location.hash.slice(1);
    if (named) go(named);
    load();
  })();
})();
