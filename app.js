(() => {
  const LS_KEY = "fp_state_v1";

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
    ops: [] // newest first
  });

  const loadState = () => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return defaultState();
      const s = JSON.parse(raw);

      const base = defaultState();
      const merged = { ...base, ...s };
      merged.ui = { ...base.ui, ...(s.ui || {}) };
      merged.plan = { ...base.plan, ...(s.plan || {}) };
      merged.over = { ...base.over, ...(s.over || {}) };
      merged.accounts = Array.isArray(s.accounts) && s.accounts.length ? s.accounts : base.accounts;
      merged.ops = Array.isArray(s.ops) ? s.ops : [];
      merged.v = 1;
      merged.tab = merged.tab || "home";

      if (!merged.accounts.some(a => a.name === merged.ui.selectedAccount)) {
        merged.ui.selectedAccount = merged.accounts[0]?.name || "Основной";
      }
      return merged;
    } catch {
      return defaultState();
    }
  };

  const state = loadState();
  const saveState = () => localStorage.setItem(LS_KEY, JSON.stringify(state));

  // Telegram cosmetics
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

  // ===== Sending (TG sendData) =====
  const sendToBot = (payload) => {
    const data = JSON.stringify(payload);
    // В TG это закроет мини-апп и вернёт в чат — как ты сейчас хочешь.
    if (tg?.sendData) {
      tg.sendData(data);
      return true;
    }
    // если открыто в браузере — просто покажем тост
    console.log("sendData payload:", payload);
    toast("Открыто не в Telegram — данные в консоли");
    return false;
  };

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

  const mergePlanBulkLocal = (bucket, rows) => {
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

  // ===== Render =====
  const render = () => {
    brandSub.textContent = (tg?.initDataUnsafe?.user?.id)
      ? `tg_id: ${tg.initDataUnsafe.user.id} · sendData`
      : `browser · sendData off`;

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
        <div class="muted">Добавляй план списком. В Telegram после сохранения вернёт в чат (sendData).</div>
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
        <h2>Аналитика (MVP)</h2>
        <div class="muted">Период</div>
        <div class="chips" id="period_chips" style="margin-top:8px">${periodChips}</div>

        <div class="hr"></div>
        <div class="stack">
          <div class="row"><div class="muted">Доходы</div><div><b>${fmtRub(totalInc)}</b></div></div>
          <div class="row"><div class="muted">Расходы</div><div><b>${fmtRub(totalExp)}</b></div></div>
          <div class="row"><div class="muted">Дельта</div><div><b>${fmtRub(delta)}</b></div></div>
          <div class="row"><div class="muted">Баланс (всего)</div><div><b>${fmtRub(totalBalance())}</b></div></div>
        </div>
      </section>

      <section class="card">
        <button id="btn_analytics_send" class="btn ghost">Запросить аналитику в чат</button>
        <div class="muted" style="margin-top:10px">Эта кнопка отправит событие в бота (sendData) и закроет мини-апп.</div>
      </section>
    `;
  };

  // ===== Settings modal =====
  const openSettings = () => {
    const list = state.accounts.map(a =>
      `<div class="item"><div class="meta"><div class="t">${escapeHtml(a.name)}</div></div><div class="muted">${fmtRub(a.balance)}</div></div>`
    ).join("");

    openModal(`
      <h3>Настройки</h3>
      <div class="muted">Счета (конверты)</div>
      <div style="height:10px"></div>
      <div class="list">${list || `<div class="muted">Нет счетов</div>`}</div>

      <div class="hr"></div>

      <div class="muted" style="font-weight:800">Добавить счёт</div>
      <input id="acc_name" class="input" placeholder="Например: Наличные" />
      <div style="height:10px"></div>
      <button class="btn ghost" id="acc_add">Добавить</button>

      <div class="hr"></div>

      <div class="muted">Отправить список счетов в бота (setup_accounts)</div>
      <button class="btn" id="acc_send">Отправить</button>

      <div style="height:12px"></div>
      <div class="muted" style="font-weight:800">Сброс</div>
      <button class="btn danger" id="wipe_all">Стереть всё (local)</button>

      <div style="height:12px"></div>
      <div class="actions">
        <button class="btn" id="m_close">Закрыть</button>
      </div>
    `);

    $("#m_close").onclick = () => { closeModal(); };

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
    };

    $("#acc_send").onclick = () => {
      sendToBot({ v: 1, type: "setup_accounts", accounts: state.accounts.map(a => a.name) });
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

    // add expense -> local + sendData
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

        sendToBot({ v: 1, type: "expense", amount: String(amount), category: cat.toLowerCase(), account: accName, op_id: op.id, ts: op.ts });
      };
    }

    // add income -> local + sendData
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

        sendToBot({ v: 1, type: "income", amount: String(amount), category: src.toLowerCase(), account: accName, op_id: op.id, ts: op.ts });
      };
    }

    // undo -> local + sendData (op_cancel)
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

          sendToBot({ v: 1, type: "op_cancel", op_id: opId });
        };
      };
    }

    // plan bulk -> local + sendData
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

          mergePlanBulkLocal("income", inc);
          mergePlanBulkLocal("expense", exp);

          recomputeDerived();
          saveState();
          closeModal();
          render();

          sendToBot({ v: 1, type: "plan_bulk", income_text: incText, expense_text: expText });
        };
      };
    }

    // plan clear -> local + sendData
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
          sendToBot({ v: 1, type: "plan_clear" });
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

    // analytics request -> sendData
    const btnAnalyticsSend = $("#btn_analytics_send");
    if (btnAnalyticsSend) {
      btnAnalyticsSend.onclick = () => {
        sendToBot({ v: 1, type: "analytics_request", period: state.ui.analyticsPeriod });
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
    recomputeDerived();
    saveState();
    render();
  };

  init();
})();
