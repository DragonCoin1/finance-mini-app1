(() => {
  const LS_KEY = "fp_state_v1";

  // ДЕФОЛТ для локального теста (когда мини-апп открываешь локально по http://127.0.0.1:8000)
  const DEFAULT_API_URL = "http://127.0.0.1:8001/api/webapp";

  const tg = window.Telegram?.WebApp || null;

  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

  const uid = () => (crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()) + "_" + Math.random().toString(16).slice(2));
  const nowTs = () => Date.now();

  const fmtRub = (n) => (Number(n || 0)).toLocaleString("ru-RU") + " ₽";
  const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
  const normalizeName = (s) => String(s || "").trim().toLowerCase();

  const escapeHtml = (s) => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");
  const escapeAttr = (s) => escapeHtml(s).replaceAll('"',"&quot;");

  const parseAmount = (raw) => {
    if (raw == null) return null;
    let s = String(raw).trim().toLowerCase();
    if (!s) return null;

    const kMatch = s.match(/^(\d+(?:[.,]\d+)?)\s*[кk]$/i);
    if (kMatch) {
      const num = Number(kMatch[1].replace(",", "."));
      if (!Number.isFinite(num)) return null;
      return Math.round(num * 1000);
    }

    s = s.replace(/\s+/g, "").replace(",", ".");
    const num = Number(s);
    if (!Number.isFinite(num)) return null;
    return Math.round(num);
  };

  const parseBulk = (text) => {
    const t = String(text || "").trim();
    if (!t) return [];
    const parts = t.split(/[,;\n]+/).map(x => x.trim()).filter(Boolean);
    const rows = [];
    for (const p of parts) {
      const m = p.match(/^(\d+(?:[.,]\d+)?\s*[кk]?)\s+(.+)$/i);
      if (!m) continue;
      const amount = parseAmount(m[1]);
      const name = (m[2] || "").trim();
      if (!amount || amount <= 0 || !name) continue;
      rows.push({ amount, name });
    }
    return rows;
  };

  // ===== State =====
  const defaultState = () => ({
    v: 1,
    tab: "home",
    safe: 0,
    settings: {
      apiUrl: DEFAULT_API_URL,
      syncEnabled: true,
      lastSyncAt: 0,
      lastSyncErr: ""
    },
    accounts: [
      { name: "Основной", balance: 0 },
      { name: "Карманные", balance: 0 }
    ],
    ui: {
      selectedAccount: "Основной",
      expenseCategory: null,
      incomeSource: null,
      analyticsPeriod: "30d"
    },
    plan: { income: {}, expense: {} },
    over: { income_extra: 0, expense_over: 0 },
    ops: [],      // newest first
    outbox: []    // очередь отправки (payloads)
  });

  const loadState = () => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return defaultState();
      const s = JSON.parse(raw);

      const base = defaultState();
      const merged = { ...base, ...s };
      merged.settings = { ...base.settings, ...(s.settings || {}) };
      merged.ui = { ...base.ui, ...(s.ui || {}) };
      merged.plan = { ...base.plan, ...(s.plan || {}) };
      merged.over = { ...base.over, ...(s.over || {}) };
      merged.accounts = Array.isArray(s.accounts) && s.accounts.length ? s.accounts : base.accounts;
      merged.ops = Array.isArray(s.ops) ? s.ops : [];
      merged.outbox = Array.isArray(s.outbox) ? s.outbox : [];
      merged.v = 1;
      merged.tab = merged.tab || "home";

      if (!merged.accounts.some(a => a.name === merged.ui.selectedAccount)) {
        merged.ui.selectedAccount = merged.accounts[0]?.name || "Основной";
      }
      if (!merged.settings.apiUrl) merged.settings.apiUrl = DEFAULT_API_URL;

      return merged;
    } catch {
      return defaultState();
    }
  };

  const state = loadState();
  const saveState = () => localStorage.setItem(LS_KEY, JSON.stringify(state));

  // Telegram cosmetics (без sendData — не закрываем мини-апп)
  try {
    if (tg) {
      tg.ready();
      tg.expand();
      tg.setBackgroundColor?.("#05020b");
    }
  } catch {}

  const view = $("#view");
  const brandSub = $("#brand_sub");

  // ===== Modal =====
  const backdrop = $("#backdrop");
  const modal = $("#modal");
  const openModal = (html) => {
    modal.innerHTML = html;
    backdrop.classList.remove("hidden");
    backdrop.setAttribute("aria-hidden", "false");
  };
  const closeModal = () => {
    backdrop.classList.add("hidden");
    backdrop.setAttribute("aria-hidden", "true");
    modal.innerHTML = "";
  };
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });

  // ===== Outbox Sync =====
  const syncNow = async () => {
    if (!state.settings.syncEnabled) return;
    const apiUrl = String(state.settings.apiUrl || "").trim();
    if (!apiUrl) return;
    if (!state.outbox.length) return;

    // если в фоне уже идёт синк — не дублируем
    if (syncNow._busy) return;
    syncNow._busy = true;

    try {
      // отправляем по одному (надёжнее + легче делать ретраи)
      for (let i = 0; i < state.outbox.length; ) {
        const item = state.outbox[i];
        const now = Date.now();
        if (item.nextTryAt && item.nextTryAt > now) { i++; continue; }

        const ok = await postJson(apiUrl, item.payload);
        if (ok) {
          state.outbox.splice(i, 1);
          state.settings.lastSyncAt = now;
          state.settings.lastSyncErr = "";
          saveState();
          continue;
        }

        // fail: backoff
        item.tries = (item.tries || 0) + 1;
        const backoff = Math.min(60_000, 2000 * Math.pow(2, Math.min(item.tries, 5))); // 2s..64s cap 60s
        item.nextTryAt = now + backoff;
        state.settings.lastSyncErr = "sync_failed";
        saveState();
        i++;
      }
    } finally {
      syncNow._busy = false;
    }
  };

  const postJson = async (url, payload) => {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      return r.ok;
    } catch {
      return false;
    }
  };

  const enqueue = (payload) => {
    // добавляем op_id в payload если нет (идемпотентность на сервере)
    if (!payload.op_id) payload.op_id = uid();

    state.outbox.push({
      id: uid(),
      ts: Date.now(),
      tries: 0,
      nextTryAt: 0,
      payload
    });

    // ограничим очередь чтобы не разрасталась бесконечно
    if (state.outbox.length > 800) state.outbox = state.outbox.slice(state.outbox.length - 800);

    saveState();
    // фоном пробуем синк
    void syncNow();
  };

  // периодический синк
  setInterval(() => { void syncNow(); }, 8000);
  window.addEventListener("online", () => { void syncNow(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncNow();
  });

  // ===== Domain logic =====
  const getAccount = (name) => state.accounts.find(a => a.name === name) || null;
  const totalBalance = () => state.accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);

  const ensurePlanItem = (bucket, name) => {
    const key = normalizeName(name);
    if (!state.plan[bucket][key]) state.plan[bucket][key] = { name: name.trim(), planned: 0, done: 0 };
    else {
      const cur = state.plan[bucket][key];
      if (name.trim().length > cur.name.length) cur.name = name.trim();
    }
    return state.plan[bucket][key];
  };

  const mergePlanBulk = (bucket, rows) => {
    for (const r of rows) {
      const it = ensurePlanItem(bucket, r.name);
      it.planned += r.amount;
    }
  };

  const applyOpToState = (op) => {
    const acc = getAccount(op.account);
    if (!acc) return;

    if (op.type === "expense") acc.balance -= op.amount;
    if (op.type === "income") acc.balance += op.amount;

    if (op.type === "expense") {
      const key = normalizeName(op.category);
      const item = state.plan.expense[key];
      if (item) {
        const remaining = Math.max(0, item.planned - item.done);
        const take = Math.min(remaining, op.amount);
        item.done += take;
        const over = op.amount - take;
        if (over > 0) state.over.expense_over += over;
      } else {
        state.over.expense_over += op.amount;
      }
    }

    if (op.type === "income") {
      const key = normalizeName(op.category);
      const item = state.plan.income[key];
      if (item) {
        const remaining = Math.max(0, item.planned - item.done);
        const take = Math.min(remaining, op.amount);
        item.done += take;
        const extra = op.amount - take;
        if (extra > 0) state.over.income_extra += extra;
      } else {
        state.over.income_extra += op.amount;
      }
    }
  };

  const recomputeDerived = () => {
    for (const a of state.accounts) a.balance = 0;

    for (const it of Object.values(state.plan.income)) it.done = 0;
    for (const it of Object.values(state.plan.expense)) it.done = 0;
    state.over.income_extra = 0;
    state.over.expense_over = 0;

    const opsAsc = [...state.ops].sort((a,b) => a.ts - b.ts);
    for (const op of opsAsc) applyOpToState(op);
  };

  const addOperation = (op) => {
    applyOpToState(op);
    state.ops.unshift(op);
    state.ops = state.ops.slice(0, 500);
  };

  const setTab = (tab) => {
    state.tab = tab;
    $$(".navbtn").forEach(b => b.classList.toggle("sel", b.dataset.tab === tab));
    saveState();
    render();
  };

  const opsForPeriod = () => {
    const p = state.ui.analyticsPeriod || "30d";
    if (p === "all") return state.ops;
    const days = p === "7d" ? 7 : p === "90d" ? 90 : 30;
    const cutoff = Date.now() - days * 86400000;
    return state.ops.filter(o => o.ts >= cutoff);
  };

  // ===== UI builders =====
  const chipButton = ({ cls, label, sub, icon, selected, dataKey, dataVal }) => {
    const safeLabel = escapeHtml(label);
    const safeSub = sub ? escapeHtml(sub) : "";
    const safeIcon = icon ? escapeHtml(icon) : "";
    const selCls = selected ? " sel" : "";
    return `
      <button class="${cls} chipbtn${selCls}" data-${dataKey}="${escapeAttr(dataVal)}">
        <span class="chip">
          ${safeIcon ? `<span class="ico">${safeIcon}</span>` : ``}
          <span class="label">${safeLabel}</span>
          ${sub ? `<span class="sub">${safeSub}</span>` : ``}
        </span>
      </button>
    `;
  };

  const progressBlock = (title, done, total) => {
    const pct = total > 0 ? clamp((done / total) * 100, 0, 100) : 0;
    return `
      <div class="stack" style="gap:6px">
        <div class="row">
          <div class="muted">${escapeHtml(title)}</div>
          <div><b>${fmtRub(done)}</b> <span class="muted">/ ${fmtRub(total)}</span></div>
        </div>
        <div class="progress"><div style="width:${pct.toFixed(1)}%"></div></div>
      </div>
    `;
  };

  // Charts helpers (как было)
  const pickColors = (i) => {
    const colors = ["#b56cff","#6d28ff","#00aaff","#ff2d55","#8b5cf6","#22c55e","#f59e0b","#ef4444"];
    return colors[i % colors.length];
  };

  const donutSvg = (items, title) => {
    const total = items.reduce((s,x)=>s+x.sum,0);
    const size = 240, cx = 120, cy = 120, r = 90, stroke = 18;
    const circ = 2 * Math.PI * r;

    if (total <= 0) {
      return `
        <div class="chartCard">
          <div class="chartTitle"><div>${escapeHtml(title)}</div><div class="muted">0 ₽</div></div>
          <div class="muted">Нет данных</div>
        </div>
      `;
    }

    let offset = 0;
    const rings = items.slice(0, 6).map((x, idx) => {
      const frac = x.sum / total;
      const len = frac * circ;
      const dash = `${len.toFixed(2)} ${(circ - len).toFixed(2)}`;
      const col = pickColors(idx);
      const seg = `
        <circle cx="${cx}" cy="${cy}" r="${r}"
          fill="none" stroke="${col}" stroke-width="${stroke}" stroke-linecap="round"
          stroke-dasharray="${dash}" stroke-dashoffset="${(-offset).toFixed(2)}"
          transform="rotate(-90 ${cx} ${cy})" opacity="0.95"
        />`;
      offset += len;
      return seg;
    }).join("");

    const legend = items.slice(0, 6).map((x) => {
      const pct = total>0 ? (x.sum/total)*100 : 0;
      return `
        <div class="lg">
          <div class="name">${escapeHtml(x.name)}</div>
          <div class="val"><b>${fmtRub(x.sum)}</b> · ${pct.toFixed(0)}%</div>
        </div>
      `;
    }).join("");

    return `
      <div class="chartCard">
        <div class="chartTitle">
          <div>${escapeHtml(title)}</div>
          <div class="muted"><b>${fmtRub(total)}</b></div>
        </div>
        <div class="svgWrap">
          <svg viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
            <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,.08)" stroke-width="${stroke}"/>
            ${rings}
            <circle cx="${cx}" cy="${cy}" r="${r-26}" fill="rgba(0,0,0,.18)" stroke="rgba(255,255,255,.08)" stroke-width="1"/>
            <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
              fill="rgba(246,245,255,.92)" font-weight="900" font-size="16">
              ${fmtRub(total)}
            </text>
          </svg>
        </div>
        <div class="legend">${legend}</div>
      </div>
    `;
  };

  const lineSvg = (points, title) => {
    const w = 520, h = 220, pad = 28;
    if (!points.length) {
      return `
        <div class="chartCard">
          <div class="chartTitle"><div>${escapeHtml(title)}</div><div class="muted">—</div></div>
          <div class="muted">Нет данных</div>
        </div>
      `;
    }

    const ys = points.map(p => p.y);
    const minY = Math.min(...ys, 0);
    const maxY = Math.max(...ys, 0);
    const span = (maxY - minY) || 1;

    const toX = (i) => pad + (i * ((w - pad*2) / Math.max(1, points.length-1)));
    const toY = (v) => pad + ((maxY - v) * ((h - pad*2) / span));

    const d = points.map((p,i) => `${i===0?'M':'L'} ${toX(i).toFixed(1)} ${toY(p.y).toFixed(1)}`).join(" ");
    const last = points[points.length-1].y;
    const y0 = toY(0);

    return `
      <div class="chartCard">
        <div class="chartTitle">
          <div>${escapeHtml(title)}</div>
          <div class="muted"><b>${fmtRub(last)}</b></div>
        </div>
        <div class="svgWrap">
          <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="0" width="${w}" height="${h}" fill="rgba(0,0,0,.08)" rx="16"/>
            <line x1="${pad}" y1="${y0.toFixed(1)}" x2="${w-pad}" y2="${y0.toFixed(1)}" stroke="rgba(255,255,255,.10)" stroke-width="1"/>
            <path d="${d}" fill="none" stroke="url(#g)" stroke-width="3" stroke-linecap="round"/>
            <circle cx="${toX(points.length-1).toFixed(1)}" cy="${toY(last).toFixed(1)}" r="5" fill="#00aaff" opacity="0.95"/>
            <defs>
              <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stop-color="#b56cff"/>
                <stop offset="100%" stop-color="#00aaff"/>
              </linearGradient>
            </defs>
          </svg>
        </div>
        <div class="muted" style="margin-top:8px">Кумулятивный баланс по операциям (в выбранном периоде).</div>
      </div>
    `;
  };

  const barsByDaySvg = (expensesAsc, title) => {
    const map = new Map();
    for (const o of expensesAsc) {
      const d = new Date(o.ts);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      map.set(key, (map.get(key) || 0) + o.amount);
    }
    const keys = Array.from(map.keys()).sort();
    const vals = keys.map(k => ({ k, v: map.get(k) }));
    const w = 520, h = 220, pad = 28;

    if (!vals.length) {
      return `
        <div class="chartCard">
          <div class="chartTitle"><div>${escapeHtml(title)}</div><div class="muted">0 ₽</div></div>
          <div class="muted">Нет расходов в периоде</div>
        </div>
      `;
    }

    const maxV = Math.max(...vals.map(x=>x.v), 1);
    const n = Math.min(vals.length, 31);
    const slice = vals.slice(Math.max(0, vals.length - n));
    const barW = (w - pad*2) / slice.length;

    const rects = slice.map((x,i) => {
      const bh = (x.v / maxV) * (h - pad*2);
      const x0 = pad + i*barW + 1;
      const y0 = h - pad - bh;
      return `<rect x="${x0.toFixed(1)}" y="${y0.toFixed(1)}" width="${Math.max(2, barW-2).toFixed(1)}" height="${bh.toFixed(1)}" rx="4" fill="url(#gb)" opacity="0.95">
        <title>${x.k}: ${fmtRub(x.v)}</title>
      </rect>`;
    }).join("");

    const total = slice.reduce((s,x)=>s+x.v,0);

    return `
      <div class="chartCard">
        <div class="chartTitle"><div>${escapeHtml(title)}</div><div class="muted"><b>${fmtRub(total)}</b></div></div>
        <div class="svgWrap">
          <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
            <rect x="0" y="0" width="${w}" height="${h}" fill="rgba(0,0,0,.08)" rx="16"/>
            ${rects}
            <defs>
              <linearGradient id="gb" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#00aaff"/>
                <stop offset="100%" stop-color="#6d28ff"/>
              </linearGradient>
            </defs>
          </svg>
        </div>
        <div class="muted" style="margin-top:8px">Последние ${n} дней (в выбранном периоде).</div>
      </div>
    `;
  };

  const heatmapSvg = (ops, title) => {
    const m = Array.from({length:7}, () => Array(24).fill(0));
    for (const o of ops) {
      if (o.type !== "expense") continue;
      const d = new Date(o.ts);
      const jsDay = d.getDay();
      const day = (jsDay + 6) % 7;
      const hour = d.getHours();
      m[day][hour] += o.amount;
    }
    let maxV = 0;
    for (let y=0;y<7;y++) for (let x=0;x<24;x++) maxV = Math.max(maxV, m[y][x]);
    const days = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];

    const cell = 14, gap = 3;
    const labelW = 26;
    const w = labelW + 24*(cell+gap) + 8;
    const h = 7*(cell+gap) + 12;

    if (maxV === 0) {
      return `
        <div class="chartCard">
          <div class="chartTitle"><div>${escapeHtml(title)}</div><div class="muted">—</div></div>
          <div class="muted">Нет расходов в периоде</div>
        </div>
      `;
    }

    const rects = [];
    for (let y=0;y<7;y++){
      for (let x=0;x<24;x++){
        const v = m[y][x];
        const a = v>0 ? (0.12 + 0.88*(v/maxV)) : 0.06;
        const xx = labelW + 6 + x*(cell+gap);
        const yy = 6 + y*(cell+gap);
        rects.push(
          `<rect x="${xx}" y="${yy}" width="${cell}" height="${cell}" rx="3"
             fill="rgba(0,170,255,${a.toFixed(3)})" stroke="rgba(255,255,255,.06)" stroke-width="1">
             <title>${days[y]} ${String(x).padStart(2,'0')}:00 — ${fmtRub(v)}</title>
           </rect>`
        );
      }
    }

    const yLabels = days.map((d,i)=>`<text x="6" y="${6 + i*(cell+gap) + cell - 3}" fill="rgba(246,245,255,.75)" font-size="11" font-weight="900">${d}</text>`).join("");

    return `
      <div class="chartCard">
        <div class="chartTitle"><div>${escapeHtml(title)}</div><div class="muted">max: ${fmtRub(maxV)}</div></div>
        <div class="hmWrap">
          <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" style="min-width:${w}px">
            <rect x="0" y="0" width="${w}" height="${h}" rx="16" fill="rgba(0,0,0,.08)"/>
            ${yLabels}
            ${rects.join("")}
          </svg>
        </div>
        <div class="muted hmNote">Теплокарта расходов: дни недели × часы. Тап по клетке покажет сумму.</div>
      </div>
    `;
  };

  // ===== Render =====
  const render = () => {
    const pending = state.outbox?.length || 0;
    const syncTxt = state.settings.syncEnabled
      ? (pending ? `sync: ${pending} ⏳` : `sync: ok`)
      : `sync: off`;

    brandSub.textContent = (tg?.initDataUnsafe?.user?.id)
      ? `tg_id: ${tg.initDataUnsafe.user.id} · ${syncTxt}`
      : `test v0.6 · ${syncTxt}`;

    if (state.tab === "home") view.innerHTML = renderHome();
    if (state.tab === "plan") view.innerHTML = renderPlan();
    if (state.tab === "ops") view.innerHTML = renderOps();
    if (state.tab === "analytics") view.innerHTML = renderAnalytics();

    bindHandlers();
  };

  const renderHome = () => {
    const total = totalBalance();

    const incomeTotal = Object.values(state.plan.income).reduce((s, x) => s + (x.planned || 0), 0);
    const incomeDone  = Object.values(state.plan.income).reduce((s, x) => s + (x.done || 0), 0);
    const expTotal = Object.values(state.plan.expense).reduce((s, x) => s + (x.planned || 0), 0);
    const expDone  = Object.values(state.plan.expense).reduce((s, x) => s + (x.done || 0), 0);

    const accountsHtml = state.accounts.map(a => chipButton({
      cls: "pill",
      icon: "💼",
      label: a.name,
      sub: fmtRub(a.balance),
      selected: state.ui.selectedAccount === a.name,
      dataKey: "acc",
      dataVal: a.name
    })).join("");

    const lastOps = state.ops.slice(0, 15);
    const historyHtml = lastOps.length ? lastOps.map(op => {
      const isExp = op.type === "expense";
      const amtCls = isExp ? "amt neg" : "amt pos";
      const sign = isExp ? "-" : "+";
      const dt = new Date(op.ts).toLocaleString("ru-RU", { day:"2-digit", month:"2-digit", hour:"2-digit", minute:"2-digit" });
      return `
        <div class="item">
          <div class="meta">
            <div class="t">${escapeHtml(op.category)}</div>
            <div class="s">${escapeHtml(op.account)} · ${dt}</div>
          </div>
          <div class="right">
            <div class="${amtCls}">${sign}${fmtRub(op.amount)}</div>
            <button class="btn-mini danger" data-undo="${escapeAttr(op.id)}">Отмена</button>
          </div>
        </div>
      `;
    }).join("") : `<div class="muted">Пока нет операций</div>`;

    return `
      <section class="card">
        <h2>Баланс</h2>
        <div class="row" style="align-items:flex-end">
          <div class="muted">Общий</div>
          <div style="font-weight:900;font-size:22px">${fmtRub(total)}</div>
        </div>
        <div class="hr"></div>
        <div class="chips" id="home_accounts">${accountsHtml}</div>
      </section>

      <section class="card">
        <h2>План месяца</h2>
        ${progressBlock("Доходы", incomeDone, incomeTotal)}
        <div style="height:10px"></div>
        ${progressBlock("Расходы", expDone, expTotal)}
        <div class="hr"></div>
        <div class="row">
          <div><b>Сверх плана</b> <span class="muted">+${fmtRub(state.over.income_extra)}</span></div>
          <div><b>Перерасход</b> <span class="muted">${fmtRub(state.over.expense_over)}</span></div>
        </div>
      </section>

      <section class="card">
        <h2>История</h2>
        <div class="list" id="home_history">${historyHtml}</div>
        ${state.outbox.length ? `<div class="muted" style="margin-top:10px">⏳ В очереди на отправку: <b>${state.outbox.length}</b></div>` : ``}
      </section>
    `;
  };

  const renderPlan = () => {
    const incomeItems = Object.values(state.plan.income).sort((a,b)=> normalizeName(a.name).localeCompare(normalizeName(b.name)));
    const expenseItems = Object.values(state.plan.expense).sort((a,b)=> normalizeName(a.name).localeCompare(normalizeName(b.name)));

    const planList = (items) => {
      if (!items.length) return `<div class="muted">Пока пусто</div>`;
      return items.map(it => {
        const remain = Math.max(0, (it.planned||0) - (it.done||0));
        return `
          <div class="item">
            <div class="meta">
              <div class="t">${escapeHtml(it.name)}</div>
              <div class="s">План: <b>${fmtRub(it.planned)}</b> · Закрыто: <b>${fmtRub(it.done)}</b> · Осталось: <b>${fmtRub(remain)}</b></div>
            </div>
          </div>
        `;
      }).join("");
    };

    return `
      <section class="card">
        <h2>Планирование</h2>
        <div class="muted">Добавляй план списком. Если категория уже есть — сумма увеличится.</div>
        <div style="height:10px"></div>
        <button id="btn_plan_bulk" class="btn">Добавить/изменить списком</button>
        <div style="height:10px"></div>
        <button id="btn_plan_clear" class="btn danger">Очистить план месяца</button>
      </section>

      <section class="card">
        <h2>Доходы</h2>
        <div class="list">${planList(incomeItems)}</div>
      </section>

      <section class="card">
        <h2>Расходы</h2>
        <div class="list">${planList(expenseItems)}</div>
      </section>
    `;
  };

  const renderOps = () => {
    const expenseCats = ["Продукты", "Квартира", "Карманные", "Транспорт", "Кафе", "Другое"];
    const incomeSrcs = ["Зарплата", "Пенсия", "Подработка", "Не по плану", "Другое"];

    const accHtml = state.accounts.map(a => chipButton({
      cls: "pill",
      icon: "💼",
      label: a.name,
      sub: fmtRub(a.balance),
      selected: state.ui.selectedAccount === a.name,
      dataKey: "acc",
      dataVal: a.name
    })).join("");

    const expTags = expenseCats.map(c => chipButton({
      cls: "tag",
      icon: c === "Продукты" ? "🛒" : c === "Квартира" ? "🏠" : c === "Карманные" ? "👜" : c === "Транспорт" ? "🚕" : c === "Кафе" ? "☕" : "🧩",
      label: c,
      selected: state.ui.expenseCategory === c,
      dataKey: "expcat",
      dataVal: c
    })).join("");

    const incTags = incomeSrcs.map(c => chipButton({
      cls: "tag",
      icon: c === "Зарплата" ? "💳" : c === "Пенсия" ? "🏦" : c === "Подработка" ? "🧰" : c === "Не по плану" ? "➕" : "🧩",
      label: c,
      selected: state.ui.incomeSource === c,
      dataKey: "incsrc",
      dataVal: c
    })).join("");

    const showExpOther = state.ui.expenseCategory === "Другое";
    const showIncOther = state.ui.incomeSource === "Другое";

    return `
      <section class="card">
        <h2>Расход</h2>
        <input id="exp_amount" class="input" inputmode="numeric" placeholder="Сумма (например 1000)" />
        <div style="height:10px"></div>

        <div class="muted" style="font-weight:800">Категория</div>
        <div class="chips" id="exp_tags">${expTags}</div>

        ${showExpOther ? `
          <div style="height:10px"></div>
          <input id="exp_other" class="input" placeholder="Название категории" />
        ` : ``}

        <div style="height:12px"></div>
        <div class="muted" style="font-weight:800">Списать со счёта</div>
        <div class="chips" id="ops_accounts_exp">${accHtml}</div>

        <div style="height:12px"></div>
        <button id="btn_add_exp" class="btn">Записать расход</button>
      </section>

      <section class="card">
        <h2>Доход</h2>
        <input id="inc_amount" class="input" inputmode="numeric" placeholder="Сумма (например 35000)" />
        <div style="height:10px"></div>

        <div class="muted" style="font-weight:800">Источник</div>
        <div class="chips" id="inc_tags">${incTags}</div>

        ${showIncOther ? `
          <div style="height:10px"></div>
          <input id="inc_other" class="input" placeholder="Название источника" />
        ` : ``}

        <div style="height:12px"></div>
        <div class="muted" style="font-weight:800">Зачислить на счёт</div>
        <div class="chips" id="ops_accounts_inc">${accHtml}</div>

        <div style="height:12px"></div>
        <button id="btn_add_inc" class="btn">Записать доход</button>
      </section>
    `;
  };

  const renderAnalytics = () => {
    const ops = opsForPeriod();
    const totalInc = ops.filter(o=>o.type==="income").reduce((s,o)=>s+o.amount,0);
    const totalExp = ops.filter(o=>o.type==="expense").reduce((s,o)=>s+o.amount,0);
    const delta = totalInc - totalExp;

    const incomeTotal = Object.values(state.plan.income).reduce((s, x) => s + (x.planned || 0), 0);
    const incomeDone  = Object.values(state.plan.income).reduce((s, x) => s + (x.done || 0), 0);
    const expTotal = Object.values(state.plan.expense).reduce((s, x) => s + (x.planned || 0), 0);
    const expDone  = Object.values(state.plan.expense).reduce((s, x) => s + (x.done || 0), 0);

    const incPct = incomeTotal>0 ? (incomeDone/incomeTotal)*100 : 0;
    const expPct = expTotal>0 ? (expDone/expTotal)*100 : 0;

    const groupBy = (type) => {
      const m = new Map();
      for (const o of ops) {
        if (o.type !== type) continue;
        const k = normalizeName(o.category);
        const cur = m.get(k) || { name: o.category, sum: 0 };
        cur.sum += o.amount;
        if (o.category.length > cur.name.length) cur.name = o.category;
        m.set(k, cur);
      }
      return Array.from(m.values()).sort((a,b)=>b.sum-a.sum);
    };

    const expGroups = groupBy("expense").slice(0, 6);
    const incGroups = groupBy("income").slice(0, 6);

    const opsAsc = [...ops].sort((a,b)=>a.ts-b.ts);
    let bal = 0;
    const pts = opsAsc.map((o) => {
      bal += (o.type === "income" ? o.amount : -o.amount);
      return { y: bal };
    });

    const expensesAsc = opsAsc.filter(o=>o.type==="expense");

    const topBlock = (type) => {
      const arr = groupBy(type).slice(0, 6);
      const total = arr.reduce((s,x)=>s+x.sum,0);
      if (!arr.length) return `<div class="muted">Пока нет ${type==="expense"?"расходов":"доходов"}</div>`;
      return arr.map(x => {
        const pct = total > 0 ? (x.sum/total)*100 : 0;
        return `
          <div class="stack" style="gap:6px;margin:10px 0">
            <div class="row">
              <div style="font-weight:900;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(x.name)}</div>
              <div class="muted"><b>${fmtRub(x.sum)}</b> · ${pct.toFixed(0)}%</div>
            </div>
            <div class="progress"><div style="width:${clamp(pct,0,100).toFixed(1)}%"></div></div>
          </div>
        `;
      }).join("");
    };

    const periodChips = [
      { key:"7d",  label:"7д"  },
      { key:"30d", label:"30д" },
      { key:"90d", label:"90д" },
      { key:"all", label:"Всё" }
    ].map(p => chipButton({
      cls:"tag",
      icon:"📅",
      label:p.label,
      selected: (state.ui.analyticsPeriod === p.key),
      dataKey:"period",
      dataVal:p.key
    })).join("");

    return `
      <section class="card">
        <h2>Аналитика</h2>
        <div class="muted">Период</div>
        <div class="chips" id="period_chips" style="margin-top:8px">${periodChips}</div>

        <div class="hr"></div>
        <div class="stack">
          <div class="row"><div class="muted">Доходы</div><div><b>${fmtRub(totalInc)}</b></div></div>
          <div class="row"><div class="muted">Расходы</div><div><b>${fmtRub(totalExp)}</b></div></div>
          <div class="row"><div class="muted">Дельта</div><div><b>${fmtRub(delta)}</b></div></div>
          <div class="row"><div class="muted">Баланс (всего)</div><div><b>${fmtRub(totalBalance())}</b></div></div>
          <div class="hr"></div>
          <div class="muted">План vs факт (за месяц, общий)</div>
          <div class="row"><div>Доходы</div><div class="muted">${incPct.toFixed(0)}%</div></div>
          <div class="progress"><div style="width:${clamp(incPct,0,100).toFixed(1)}%"></div></div>
          <div style="height:8px"></div>
          <div class="row"><div>Расходы</div><div class="muted">${expPct.toFixed(0)}%</div></div>
          <div class="progress"><div style="width:${clamp(expPct,0,100).toFixed(1)}%"></div></div>
        </div>
      </section>

      <section class="card">
        <h2>Диаграммы</h2>
        <div class="stack">
          ${donutSvg(expGroups, "Расходы по категориям")}
          ${donutSvg(incGroups, "Доходы по источникам")}
          ${lineSvg(pts, "Баланс по времени")}
          ${barsByDaySvg(expensesAsc, "Расходы по дням")}
          ${heatmapSvg(ops, "Тепловая карта расходов")}
        </div>
      </section>

      <section class="card">
        <h2>Топ расходов</h2>
        ${topBlock("expense")}
      </section>

      <section class="card">
        <h2>Топ доходов</h2>
        ${topBlock("income")}
      </section>

      <section class="card">
        <button id="btn_report" class="btn ghost">Отправить отчёт на сервер</button>
        <div class="muted" style="margin-top:10px">Важно: без sendData — мини-апп не закрывается.</div>
      </section>
    `;
  };

  // ===== Settings =====
  const openSettings = () => {
    const pending = state.outbox.length;
    const lastAt = state.settings.lastSyncAt ? new Date(state.settings.lastSyncAt).toLocaleString("ru-RU") : "—";
    const err = state.settings.lastSyncErr || "";

    const list = state.accounts.map(a =>
      `<div class="item"><div class="meta"><div class="t">${escapeHtml(a.name)}</div></div><div class="muted">${fmtRub(a.balance)}</div></div>`
    ).join("");

    openModal(`
      <h3>Настройки</h3>

      <div class="muted" style="font-weight:800">Синхронизация</div>
      <div style="height:8px"></div>
      <div class="item">
        <div class="meta">
          <div class="t">Отправка на сервер</div>
          <div class="s">${state.settings.syncEnabled ? "Включена" : "Выключена"} · В очереди: <b>${pending}</b></div>
        </div>
        <button class="btn-mini" id="tog_sync">${state.settings.syncEnabled ? "Выключить" : "Включить"}</button>
      </div>

      <div style="height:10px"></div>
      <div class="muted">API URL</div>
      <input id="api_url" class="input" placeholder="http://127.0.0.1:8001/api/webapp" value="${escapeAttr(state.settings.apiUrl)}" />
      <div class="muted" style="margin-top:8px">Последняя попытка: ${escapeHtml(lastAt)} ${err ? `· ошибка: ${escapeHtml(err)}` : ""}</div>

      <div style="height:12px"></div>
      <div class="actions">
        <button class="btn ghost" id="sync_try">Синк сейчас</button>
        <button class="btn" id="m_close">Закрыть</button>
      </div>

      <div class="hr"></div>

      <div class="muted">Счета (конверты)</div>
      <div style="height:10px"></div>
      <div class="list">${list || `<div class="muted">Нет счетов</div>`}</div>

      <div class="hr"></div>
      <div class="muted" style="font-weight:800">Добавить счёт</div>
      <input id="acc_name" class="input" placeholder="Например: Наличные" />
      <div style="height:10px"></div>
      <button class="btn ghost" id="acc_add">Добавить</button>

      <div style="height:12px"></div>
      <div class="muted" style="font-weight:800">Сброс</div>
      <button class="btn danger" id="wipe_all">Стереть всё (local)</button>
    `);

    $("#m_close").onclick = () => {
      const url = ($("#api_url").value || "").trim();
      if (url) state.settings.apiUrl = url;
      saveState();
      closeModal();
      render();
      void syncNow();
    };

    $("#tog_sync").onclick = () => {
      state.settings.syncEnabled = !state.settings.syncEnabled;
      saveState();
      toast(state.settings.syncEnabled ? "Синк включен" : "Синк выключен");
      closeModal();
      render();
      void syncNow();
    };

    $("#sync_try").onclick = () => {
      const url = ($("#api_url").value || "").trim();
      if (url) state.settings.apiUrl = url;
      saveState();
      toast("Пробую синхронизировать…");
      void syncNow();
    };

    $("#acc_add").onclick = () => {
      const name = ($("#acc_name").value || "").trim();
      if (!name) return toast("Введите название");
      if (state.accounts.some(a => normalizeName(a.name) === normalizeName(name))) return toast("Такой счёт уже есть");

      state.accounts.push({ name, balance: 0 });
      if (!state.ui.selectedAccount) state.ui.selectedAccount = state.accounts[0].name;

      recomputeDerived();
      saveState();
      closeModal();
      render();

      // отправка в outbox (не блокирует UI)
      enqueue({ v: 1, type: "setup_accounts", accounts: state.accounts.map(a=>a.name) });
    };

    $("#wipe_all").onclick = () => {
      openModal(`
        <h3>Стереть всё?</h3>
        <div class="muted">Удалит localStorage состояния. Нельзя отменить.</div>
        <div style="height:12px"></div>
        <div class="actions">
          <button class="btn ghost" id="w_no">Отмена</button>
          <button class="btn danger" id="w_yes">Стереть</button>
        </div>
      `);
      $("#w_no").onclick = closeModal;
      $("#w_yes").onclick = () => {
        localStorage.removeItem(LS_KEY);
        location.reload();
      };
    };
  };

  // ===== Handlers =====
  const bindHandlers = () => {
    // nav
    $$(".navbtn").forEach(b => (b.onclick = () => setTab(b.dataset.tab)));

    // settings
    $("#btn_settings").onclick = () => openSettings();

    // accounts toggle
    const handleAccClick = (e) => {
      const btn = e.target.closest("[data-acc]");
      if (!btn) return;
      const name = btn.getAttribute("data-acc");
      state.ui.selectedAccount = (state.ui.selectedAccount === name) ? (state.accounts[0]?.name || name) : name;
      saveState();
      render();
    };

    const homeAcc = $("#home_accounts");
    if (homeAcc) homeAcc.onclick = handleAccClick;

    const opsAccExp = $("#ops_accounts_exp");
    const opsAccInc = $("#ops_accounts_inc");
    if (opsAccExp) opsAccExp.onclick = handleAccClick;
    if (opsAccInc) opsAccInc.onclick = handleAccClick;

    // tags toggle
    const expTags = $("#exp_tags");
    if (expTags) {
      expTags.onclick = (e) => {
        const btn = e.target.closest("[data-expcat]");
        if (!btn) return;
        const val = btn.getAttribute("data-expcat");
        state.ui.expenseCategory = (state.ui.expenseCategory === val) ? null : val;
        saveState();
        render();
      };
    }

    const incTags = $("#inc_tags");
    if (incTags) {
      incTags.onclick = (e) => {
        const btn = e.target.closest("[data-incsrc]");
        if (!btn) return;
        const val = btn.getAttribute("data-incsrc");
        state.ui.incomeSource = (state.ui.incomeSource === val) ? null : val;
        saveState();
        render();
      };
    }

    // add expense
    const btnAddExp = $("#btn_add_exp");
    if (btnAddExp) {
      btnAddExp.onclick = () => {
        const amount = parseAmount($("#exp_amount")?.value);
        if (!amount || amount <= 0) return toast("Введите сумму расхода");

        let cat = state.ui.expenseCategory;
        if (!cat) return toast("Выберите категорию");
        if (cat === "Другое") {
          const other = ($("#exp_other")?.value || "").trim();
          if (!other) return toast("Введите название категории");
          cat = other;
        }

        const accName = state.ui.selectedAccount || state.accounts[0]?.name;
        if (!accName) return toast("Нет счетов");

        const op = { id: uid(), ts: nowTs(), type: "expense", amount, category: cat, account: accName };
        addOperation(op);
        saveState();
        render();

        // ВАЖНО: НЕ sendData. Только outbox POST (асинхронно)
        enqueue({ v: 1, type: "expense", amount: String(amount), category: cat, account: accName, op_id: op.id, ts: op.ts });
      };
    }

    // add income
    const btnAddInc = $("#btn_add_inc");
    if (btnAddInc) {
      btnAddInc.onclick = () => {
        const amount = parseAmount($("#inc_amount")?.value);
        if (!amount || amount <= 0) return toast("Введите сумму дохода");

        let src = state.ui.incomeSource;
        if (!src) return toast("Выберите источник");
        if (src === "Другое") {
          const other = ($("#inc_other")?.value || "").trim();
          if (!other) return toast("Введите название источника");
          src = other;
        }

        const accName = state.ui.selectedAccount || state.accounts[0]?.name;
        if (!accName) return toast("Нет счетов");

        const op = { id: uid(), ts: nowTs(), type: "income", amount, category: src, account: accName };
        addOperation(op);
        saveState();
        render();

        enqueue({ v: 1, type: "income", amount: String(amount), category: src, account: accName, op_id: op.id, ts: op.ts });
      };
    }

    // undo
    const hist = $("#home_history");
    if (hist) {
      hist.onclick = (e) => {
        const btn = e.target.closest("[data-undo]");
        if (!btn) return;
        const opId = btn.getAttribute("data-undo");
        const op = state.ops.find(x => x.id === opId);
        if (!op) return;

        openModal(`
          <h3>Отменить операцию?</h3>
          <div class="muted">${escapeHtml(op.type === "expense" ? "Расход" : "Доход")}: <b>${escapeHtml(op.category)}</b> · ${fmtRub(op.amount)} · ${escapeHtml(op.account)}</div>
          <div style="height:12px"></div>
          <div class="actions">
            <button class="btn ghost" id="u_no">Нет</button>
            <button class="btn danger" id="u_yes">Отменить</button>
          </div>
        `);

        $("#u_no").onclick = closeModal;
        $("#u_yes").onclick = () => {
          state.ops = state.ops.filter(x => x.id !== opId);
          recomputeDerived();
          saveState();
          closeModal();
          render();

          enqueue({ v: 1, type: "op_cancel", op_id: opId });
        };
      };
    }

    // plan bulk
    const btnPlanBulk = $("#btn_plan_bulk");
    if (btnPlanBulk) {
      btnPlanBulk.onclick = () => {
        openModal(`
          <h3>План списком</h3>
          <div class="muted">Формат: <b>35000 зп, 15000 пенсия</b> (запятая/перенос/;). Можно <b>50к</b>.</div>
          <div style="height:10px"></div>
          <div class="muted" style="font-weight:800">Доходы</div>
          <textarea id="bulk_income" placeholder="35000 зарплата, 15000 пенсия"></textarea>
          <div style="height:10px"></div>
          <div class="muted" style="font-weight:800">Расходы</div>
          <textarea id="bulk_expense" placeholder="14000 продукты; 19000 квартира"></textarea>
          <div style="height:12px"></div>
          <div class="actions">
            <button class="btn ghost" id="m_cancel">Отмена</button>
            <button class="btn" id="m_save">Сохранить</button>
          </div>
        `);

        $("#m_cancel").onclick = closeModal;
        $("#m_save").onclick = () => {
          const incText = $("#bulk_income").value || "";
          const expText = $("#bulk_expense").value || "";

          const inc = parseBulk(incText);
          const exp = parseBulk(expText);
          if (!inc.length && !exp.length) return toast("Нечего сохранять");

          mergePlanBulk("income", inc);
          mergePlanBulk("expense", exp);

          recomputeDerived();
          saveState();
          closeModal();
          render();

          enqueue({ v: 1, type: "plan_bulk", income_text: incText, expense_text: expText });
        };
      };
    }

    // plan clear
    const btnPlanClear = $("#btn_plan_clear");
    if (btnPlanClear) {
      btnPlanClear.onclick = () => {
        openModal(`
          <h3>Очистить план месяца?</h3>
          <div class="muted">Планы доходов/расходов будут удалены. История операций останется.</div>
          <div style="height:12px"></div>
          <div class="actions">
            <button class="btn ghost" id="c_no">Отмена</button>
            <button class="btn danger" id="c_yes">Очистить</button>
          </div>
        `);
        $("#c_no").onclick = closeModal;
        $("#c_yes").onclick = () => {
          state.plan.income = {};
          state.plan.expense = {};
          recomputeDerived();
          saveState();
          closeModal();
          render();
          enqueue({ v: 1, type: "plan_clear" });
        };
      };
    }

    // analytics period
    const periodChips = $("#period_chips");
    if (periodChips) {
      periodChips.onclick = (e) => {
        const btn = e.target.closest("[data-period]");
        if (!btn) return;
        state.ui.analyticsPeriod = btn.getAttribute("data-period");
        saveState();
        render();
      };
    }

    // report -> на сервер (без закрытия мини-апп)
    const btnReport = $("#btn_report");
    if (btnReport) {
      btnReport.onclick = () => {
        const ops = opsForPeriod();
        const payload = {
          v: 1,
          type: "report_request",
          period: state.ui.analyticsPeriod,
          totals: {
            balance: totalBalance(),
            income: ops.filter(o=>o.type==="income").reduce((s,o)=>s+o.amount,0),
            expense: ops.filter(o=>o.type==="expense").reduce((s,o)=>s+o.amount,0)
          }
        };
        enqueue(payload);
        toast("Отчёт поставлен в очередь");
      };
    }
  };

  // ===== Toast =====
  let toastTimer = null;
  const toast = (msg) => {
    clearTimeout(toastTimer);
    let el = $("#_toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "_toast";
      el.style.position = "fixed";
      el.style.left = "12px";
      el.style.right = "12px";
      el.style.bottom = "calc(86px + env(safe-area-inset-bottom))";
      el.style.padding = "12px 14px";
      el.style.borderRadius = "16px";
      el.style.border = "1px solid rgba(255,255,255,.12)";
      el.style.background = "linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.03))";
      el.style.boxShadow = "0 16px 40px rgba(0,0,0,.55)";
      el.style.color = "var(--text)";
      el.style.fontWeight = "800";
      el.style.zIndex = "2100";
      el.style.textAlign = "center";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.display = "block";
    toastTimer = setTimeout(() => { el.style.display = "none"; }, 1600);
  };

  // ===== init =====
  const init = () => {
    if (!state.ui.selectedAccount) state.ui.selectedAccount = state.accounts[0]?.name || null;

    // важный момент: пересчитываем derived из истории (на случай старых данных)
    recomputeDerived();
    saveState();
    render();

    // сразу пробуем догнать очередь
    void syncNow();
  };

  init();
})();
