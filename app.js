// app.js — улучшенная и более надёжная версия

const tg = window.Telegram?.WebApp;
try { tg?.ready?.(); } catch(e){ console.warn("tg.ready failed", e); }
try { tg?.expand?.(); } catch(e){ /* ignore */ }

// DOM
const view = document.getElementById("view");
const subtitle = document.getElementById("subtitle");
const modalBackdrop = document.getElementById("modal_backdrop");
const modal = document.getElementById("modal");
const btnSettings = document.getElementById("btn_settings");

if (!view || !subtitle || !modalBackdrop || !modal || !btnSettings) {
  console.warn("Some UI elements are missing:", { view, subtitle, modalBackdrop, modal, btnSettings });
}

// ===== helpers =====
function toast(text){
  if (tg?.showToast) tg.showToast({ text });
  else if (tg?.showPopup) tg.showPopup({ message: text });
  else alert(text);
}
function fmt(n){
  const x = Math.round(Number(n)||0);
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
function nowShort(){
  const d = new Date();
  const hh = String(d.getHours()).padStart(2,"0");
  const mm = String(d.getMinutes()).padStart(2,"0");
  return `${hh}:${mm}`;
}
function escapeHtml(s){ return String(s??"").replace(/[&<>\"]/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }

// safe structuredClone fallback
const structuredCloneSafe = (typeof structuredClone === "function")
  ? structuredClone
  : (obj => JSON.parse(JSON.stringify(obj)));

// ===== per-user local storage =====
const tgUserId = tg?.initDataUnsafe?.user?.id ? String(tg.initDataUnsafe.user.id) : "anon";
const STORAGE_KEY = `fp_state_v1_${tgUserId}`;

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  }catch(e){
    console.warn("loadState failed", e);
    return null;
  }
}
function saveState(){
  try{
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }catch(e){
    console.warn("saveState failed", e);
  }
}

// ===== modal stack (“назад”) =====
const modalStack = [];
function openModal(html, push=true){
  if (!modal) return;
  if (push && modal.innerHTML.trim()) modalStack.push(modal.innerHTML);
  modal.innerHTML = html;
  modalBackdrop?.classList.remove("hidden");
}
function modalBack(){
  if (!modalStack.length) return;
  modal.innerHTML = modalStack.pop();
  wireModalHandlers();
}
function closeModal(){
  modalStack.length = 0;
  modalBackdrop?.classList.add("hidden");
  if (modal) modal.innerHTML = "";
}
modalBackdrop?.addEventListener("click", (e)=>{
  if (e.target === modalBackdrop) closeModal();
});

// ===== sendData =====
function sendToBot(payload){
  try{
    if (!tg?.sendData) throw new Error("tg.sendData not available");
    tg.sendData(JSON.stringify(payload));
  }catch(e){
    console.warn("sendToBot failed", e);
    toast("Не удалось отправить");
  }
}

// ===== state (БЕЗ ФЕЙКОВЫХ ДАННЫХ) =====
const defaultState = {
  tab: "home",
  selectedAccount: null,
  selectedCat: null,
  selectedSrc: null,

  accounts: [],
  plan: {
    income: [],
    expense: [],
    over_income: 0,
    over_expense: 0,
  },
  ops: []
};

let state = loadState() || structuredCloneSafe(defaultState);

function setSubtitle(){
  const u = tg?.initDataUnsafe?.user;
  if (!subtitle) return;
  subtitle.textContent = u?.first_name ? `Пользователь: ${u.first_name}` : "";
}
setSubtitle();

// ===== calculations =====
function totalBalance(){
  return state.accounts.reduce((s,a)=>s + (Number(a.balance)||0), 0);
}
function planTotals(){
  const income_total = state.plan.income.reduce((s,p)=>s + Number(p.planned||0), 0);
  const income_done  = state.plan.income.reduce((s,p)=>s + Math.min(Number(p.done||0), Number(p.planned||0)), 0);
  const expense_total = state.plan.expense.reduce((s,p)=>s + Number(p.planned||0), 0);
  const expense_done  = state.plan.expense.reduce((s,p)=>s + Math.min(Number(p.done||0), Number(p.planned||0)), 0);
  return { income_total, income_done, expense_total, expense_done };
}
function mergePlan(kind, title, amount){
  title = String(title||"").trim().toLowerCase();
  if (!title) return;
  amount = Number(amount)||0;
  if (amount <= 0) return;

  const arr = kind === "income" ? state.plan.income : state.plan.expense;
  const idx = arr.findIndex(x=>x.title === title);
  if (idx >= 0) arr[idx].planned = Number(arr[idx].planned||0) + amount;
  else arr.push({ title, planned: amount, done: 0 });

  saveState();
}
function applyToPlan(kind, title, amount){
  title = String(title||"").trim().toLowerCase();
  amount = Number(amount)||0;
  if (amount <= 0) return;

  const arr = kind === "income" ? state.plan.income : state.plan.expense;
  const p = arr.find(x=>x.title === title);
  if (!p){
    if (kind === "income") state.plan.over_income = Number(state.plan.over_income||0) + amount;
    else state.plan.over_expense = Number(state.plan.over_expense||0) + amount;
    saveState();
    return;
  }

  const left = Math.max(0, Number(p.planned||0) - Number(p.done||0));
  const main = Math.min(left, amount);
  const over = Math.max(0, amount - main);

  p.done = Number(p.done||0) + main;
  if (over > 0){
    if (kind === "income") state.plan.over_income = Number(state.plan.over_income||0) + over;
    else state.plan.over_expense = Number(state.plan.over_expense||0) + over;
  }
  saveState();
}

function ensureAccount(name){
  name = String(name||"").trim();
  if (!name) return null;
  let a = state.accounts.find(x=>x.name === name);
  if (!a){
    a = { name, balance: 0 };
    state.accounts.push(a);
  }
  if (!state.selectedAccount) state.selectedAccount = name;
  saveState();
  return a;
}
function updateAccount(name, delta){
  const a = ensureAccount(name);
  if (!a) return;
  a.balance = (Number(a.balance)||0) + (Number(delta)||0);
  saveState();
}
function addOp(kind, title, amount, account){
  state.ops.unshift({
    kind,
    title,
    amount,
    account,
    when: nowShort()
  });
  if (state.ops.length > 200) state.ops.length = 200;
  saveState();
}

// ===== parsing bulk plan =====
function parseBulk(text){
  const out = [];
  if (!text) return out;
  const parts = text.replace(/;/g,",").replace(/\n/g,",").split(",").map(s=>s.trim()).filter(Boolean);
  for (const p of parts){
    // формат: 35000 зарплата  — поддерживаем 35k и 35к
    const m = p.match(/^([0-9 ]+|[0-9]+[kкKК])\s+(.+)$/i);
    if (!m) continue;
    let amtRaw = m[1].replace(/\s+/g,"").toLowerCase();
    let amt = 0;
    const last = amtRaw.slice(-1);
    if (last === "k" || last === "к") {
      amt = parseInt(amtRaw.slice(0,-1),10) * 1000;
    } else {
      amt = parseInt(amtRaw,10);
    }
    const name = m[2].trim().toLowerCase();
    if (!Number.isFinite(amt) || amt<=0 || !name) continue;
    out.push([amt,name]);
  }
  return out;
}

// ===== onboarding =====
function openOnboarding(force=false){
  const key = `fp_onboarded_v1_${tgUserId}`;
  if (!force && localStorage.getItem(key) === "1") return;

  openModal(`
    <div class="modalbar">
      <button class="backbtn" id="m_close">Закрыть</button>
      <div class="muted">Ввод</div>
      <div style="width:80px"></div>
    </div>

    <h3>Finance Planner</h3>
    <div class="muted" style="margin-bottom:12px">
      План — намерение на месяц. Деньги — факт. Конверты — где лежат деньги.
    </div>

    <div class="card" style="margin:0 0 10px; padding:12px">
      <h2 style="margin:0 0 6px">План</h2>
      <div class="muted">Запланируй доходы и расходы. Когда фиксируешь факт — пункт плана закрывается.</div>
    </div>

    <div class="card" style="margin:0 0 10px; padding:12px">
      <h2 style="margin:0 0 6px">Сбережения</h2>
      <div class="muted">Сбережения — это сейф. Здесь ты хранишь и копишь деньги. Они не тратятся случайно.</div>
    </div>

    <div class="actions">
      <button class="btn" id="ob_next">Далее</button>
      <button class="btn ghost" id="ob_skip">Пропустить</button>
    </div>
  `, false);

  wireModalHandlers();

  document.getElementById("ob_skip").onclick = ()=>{
    localStorage.setItem(key,"1");
    closeModal();
  };

  document.getElementById("ob_next").onclick = ()=>{
    localStorage.setItem(key,"1");
    closeModal();
    openSetupAccounts();
  };
}

function openSetupAccounts(){
  const all = ["Основной","Личные","Карманные","Наличные"];
  const selected = new Set(state.accounts.length ? state.accounts.map(a=>a.name) : all);

  openModal(`
    <div class="modalbar">
      <button class="backbtn" id="m_back">Назад</button>
      <button class="backbtn" id="m_close">Закрыть</button>
    </div>

    <h3>Конверты</h3>
    <div class="muted">Нажми ещё раз на выбранный конверт — выбор снимется. Нужен хотя бы один.</div>
    <div style="height:10px"></div>

    <div class="grid2" id="acc_grid">
      ${all.map(a=>`
        <button class="pill ${selected.has(a)?"sel":""}" data-acc="${a}">${a}</button>
      `).join("")}
    </div>

    <div class="actions">
      <button class="btn" id="acc_next">Далее</button>
    </div>
  `, false);

  wireModalHandlers();

  document.getElementById("m_back").onclick = ()=> openOnboarding(true);

  modal.querySelectorAll(".pill[data-acc]").forEach(p=>{
    p.onclick = ()=>{
      const a = p.dataset.acc;
      if (selected.has(a)) { selected.delete(a); p.classList.remove("sel"); }
      else { selected.add(a); p.classList.add("sel"); }

      if (selected.size === 0){
        selected.add(a);
        p.classList.add("sel");
        toast("Нужен хотя бы один конверт");
      }
    };
  });

  document.getElementById("acc_next").onclick = ()=>{
    const names = Array.from(selected);
    state.accounts = names.map(n=>{
      const old = state.accounts.find(x=>x.name===n);
      return { name:n, balance: old ? old.balance : 0 };
    });
    state.selectedAccount = state.selectedAccount && names.includes(state.selectedAccount)
      ? state.selectedAccount
      : names[0];

    saveState();
    sendToBot({ v:1, type:"setup_accounts", accounts: names });

    closeModal();
    openSetupPlan();
    render();
  };
}

function openSetupPlan(){
  openModal(`
    <div class="modalbar">
      <button class="backbtn" id="m_back">Назад</button>
      <button class="backbtn" id="m_close">Закрыть</button>
    </div>

    <h3>План месяца</h3>
    <div class="muted" style="margin-bottom:10px">Можно вставить списком. План будет суммироваться (ничего не слетит).</div>

    <div class="card" style="margin:0 0 10px; padding:12px">
      <h2 style="margin:0 0 6px">Доходы</h2>
      <textarea id="p_income" class="input" placeholder="Пример:
35000 зарплата,
15000 пенсия,
15000 подработка"></textarea>
      <div class="muted" style="margin-top:6px">Разделители: запятая, ; или новая строка.</div>
    </div>

    <div class="card" style="margin:0; padding:12px">
      <h2 style="margin:0 0 6px">Расходы</h2>
      <textarea id="p_expense" class="input" placeholder="Пример:
14000 продукты,
19000 квартира,
25000 карманные"></textarea>
      <div class="muted" style="margin-top:6px">Разделители: запятая, ; или новая строка.</div>
    </div>

    <div class="actions">
      <button class="btn" id="p_done">Готово</button>
      <button class="btn ghost" id="p_skip">Пропустить</button>
    </div>
  `, false);

  wireModalHandlers();
  document.getElementById("m_back").onclick = ()=>{ closeModal(); openSetupAccounts(); };

  document.getElementById("p_skip").onclick = ()=> closeModal();

  document.getElementById("p_done").onclick = ()=>{
    const income = document.getElementById("p_income").value || "";
    const expense = document.getElementById("p_expense").value || "";

    for (const [amt,name] of parseBulk(income)) mergePlan("income", name, amt);
    for (const [amt,name] of parseBulk(expense)) mergePlan("expense", name, amt);

    sendToBot({ v:1, type:"plan_bulk", income_text: income, expense_text: expense });

    closeModal();
    toast("План сохранён");
    render();
  };
}

// ===== UI: settings =====
btnSettings?.addEventListener("click", ()=>{
  openModal(`
    <div class="modalbar">
      <button class="backbtn" id="m_close">Закрыть</button>
      <div class="muted">Настройки</div>
      <div style="width:80px"></div>
    </div>

    <button class="btn ghost" id="m_help">Как это работает</button>
    <div style="height:10px"></div>
    <button class="btn ghost" id="m_setup">Первичная настройка</button>
    <div style="height:10px"></div>
    <button class="btn ghost" id="m_reset">Сбросить данные на этом устройстве</button>
  `, false);

  wireModalHandlers();

  document.getElementById("m_help").onclick = ()=>{ closeModal(); openOnboarding(true); };
  document.getElementById("m_setup").onclick = ()=>{ closeModal(); openSetupAccounts(); };
  document.getElementById("m_reset").onclick = ()=>{
    localStorage.removeItem(STORAGE_KEY);
    state = structuredCloneSafe(defaultState);
    saveState();
    toast("Сброшено");
    closeModal();
    render();
  };
});

// ===== navigation =====
function nav(tab){
  state.tab = tab;
  document.querySelectorAll(".navbtn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  saveState();
  render();
}
document.querySelectorAll(".navbtn").forEach(b => b.addEventListener("click", ()=> nav(b.dataset.tab)));

// ===== render =====
function render(){
  if (state.tab === "home") return renderHome();
  if (state.tab === "plan") return renderPlan();
  if (state.tab === "ops") return renderOps();
  if (state.tab === "analytics") return renderAnalytics();
}

function renderHome(){
  const tb = totalBalance();
  const t = planTotals();

  const incPct = t.income_total ? Math.min(100, Math.round((t.income_done/t.income_total)*100)) : 0;
  const expPct = t.expense_total ? Math.min(100, Math.round((t.expense_done/t.expense_total)*100)) : 0;

  if (!view) return;
  view.innerHTML = `
    <section class="card">
      <h2>Баланс</h2>
      <div class="kpi">${fmt(tb)} ₽</div>
      <div style="height:10px"></div>

      ${state.accounts.length ? `
        <div class="row" id="home_accs">
          ${state.accounts.map(a=>`
            <button class="pill ${state.selectedAccount===a.name?'sel':''}" data-acc="${a.name}">
              ${a.name} (${fmt(a.balance)})
            </button>
          `).join("")}
        </div>
      ` : `
        <div class="muted">Конвертов ещё нет. Нажми ⚙️ → Первичная настройка.</div>
      `}
    </section>

    <section class="card">
      <h2>План месяца</h2>

      <div class="muted">Доходы</div>
      <div class="progress"><div style="width:${incPct}%"></div></div>
      <div class="muted" style="margin-top:6px">${fmt(t.income_done)} / ${fmt(t.income_total)} ₽</div>

      <div style="height:10px"></div>

      <div class="muted">Расходы</div>
      <div class="progress"><div style="width:${expPct}%"></div></div>
      <div class="muted" style="margin-top:6px">${fmt(t.expense_done)} / ${fmt(t.expense_total)} ₽</div>

      <div style="height:10px"></div>
      <div class="muted">Сверх плана: +${fmt(state.plan.over_income)} ₽ · Перерасход: ${fmt(state.plan.over_expense)} ₽</div>
    </section>

    <section class="card">
      <h2>История</h2>
      <div class="list">
        ${state.ops.length ? state.ops.slice(0,15).map(opItem).join("") : `
          <div class="muted">Пока пусто. Добавь доход или расход во вкладке «Операции».</div>
        `}
      </div>
    </section>
  `;

  const accWrap = document.getElementById("home_accs");
  if (accWrap){
    accWrap.querySelectorAll(".pill[data-acc]").forEach(b=>{
      b.onclick = ()=>{
        const a = b.dataset.acc;
        state.selectedAccount = (state.selectedAccount === a) ? null : a;
        saveState();
        render();
      };
    });
  }
}

function opItem(o){
  const sign = o.kind === "income" ? "+" : "−";
  return `
    <div class="item">
      <div class="left">
        <div>${escapeHtml(o.title)}</div>
        <div class="sub">${escapeHtml(o.account)} · ${escapeHtml(o.when)}</div>
      </div>
      <div class="right">${sign}${fmt(o.amount)}</div>
    </div>
  `;
}

function renderPlan(){
  if (!view) return;
  view.innerHTML = `
    <section class="card">
      <h2>Планирование</h2>
      <div class="muted">Добавляй план списком. Если категория уже есть — сумма увеличится.</div>
      <div style="height:10px"></div>
      <button class="btn" id="plan_bulk">Добавить/изменить списком</button>
    </section>

    <section class="card">
      <h2>Доходы</h2>
      <div class="list">
        ${state.plan.income.length ? state.plan.income.map(planLine).join("") : `<div class="muted">Пока пусто</div>`}
      </div>
    </section>

    <section class="card">
      <h2>Расходы</h2>
      <div class="list">
        ${state.plan.expense.length ? state.plan.expense.map(planLine).join("") : `<div class="muted">Пока пусто</div>`}
      </div>
    </section>

    <section class="card">
      <button class="btn danger" id="plan_clear">Очистить план месяца</button>
    </section>
  `;

  document.getElementById("plan_bulk").onclick = ()=> openSetupPlan();

  document.getElementById("plan_clear").onclick = ()=>{
    openModal(`
      <div class="modalbar">
        <button class="backbtn" id="m_close">Закрыть</button>
        <div class="muted">Подтверждение</div>
        <div style="width:80px"></div>
      </div>
      <h3>Очистить план?</h3>
      <div class="muted">Удалится план на этом устройстве и отправится команда боту.</div>
      <div class="actions">
        <button class="btn danger" id="c_ok">Очистить</button>
        <button class="btn ghost" id="c_no">Отмена</button>
      </div>
    `, false);

    wireModalHandlers();

    document.getElementById("c_no").onclick = closeModal;
    document.getElementById("c_ok").onclick = ()=>{
      state.plan.income = [];
      state.plan.expense = [];
      state.plan.over_income = 0;
      state.plan.over_expense = 0;
      saveState();

      sendToBot({ v:1, type:"plan_clear" });

      closeModal();
      toast("План очищен");
      render();
    };
  };
}

function planLine(p){
  const left = Math.max(0, Number(p.planned||0) - Number(p.done||0));
  return `
    <div class="item">
      <div class="left">
        <div>${escapeHtml(p.title)}</div>
        <div class="sub">План: ${fmt(p.planned)} · Закрыто: ${fmt(p.done)} · Осталось: ${fmt(left)}</div>
      </div>
      <div class="right"></div>
    </div>
  `;
}

function renderOps(){
  const cats = [
    ["продукты","🛒 Продукты","план"],
    ["квартира","🏠 Квартира","план"],
    ["карманные","🎒 Карманные","план"],
    ["транспорт","🚕 Транспорт","часто"],
    ["кафе","🍽 Кафе","часто"],
    ["другое","✍️ Другое","ввод"],
  ];

  const srcs = [
    ["зарплата","💳 Зарплата","план"],
    ["пенсия","🏦 Пенсия","план"],
    ["подработка","💳 Подработка","план"],
    ["незапланированный","➕ Не по плану","факт"],
    ["другое","✍️ Другое","ввод"],
  ];

  if (!view) return;
  view.innerHTML = `
    <section class="card">
      <h2>Операции</h2>
      <div class="muted">Сумма — вводом. Категория/источник и счёт — кнопками. Повторный тап снимает выбор.</div>
    </section>

    <section class="card">
      <h2>Расход</h2>
      <input id="ex_amt" class="input" placeholder="Сумма (например 1000)" inputmode="numeric" />
      <div style="height:10px"></div>

      <div class="muted">Категория</div>
      <div class="grid3" id="ex_cats">
        ${cats.map(([k,label,h])=>`
          <button class="tag ${state.selectedCat===k?'sel':''}" data-cat="${k}">
            <span>${label}</span><small>${h}</small>
          </button>
        `).join("")}
      </div>

      <div id="ex_other_wrap" class="${state.selectedCat==='другое'?'':'hidden'}" style="margin-top:10px">
        <input id="ex_other" class="input" placeholder="Название категории" />
      </div>

      <div style="height:10px"></div>
      <div class="muted">Списать со счёта</div>
      <div class="row" id="ex_accs">
        ${state.accounts.length ? state.accounts.map(a=>`
          <button class="pill ${state.selectedAccount===a.name?'sel':''}" data-acc="${a.name}">
            ${a.name} (${fmt(a.balance)})
          </button>
        `).join("") : `<div class="muted">Сначала настрой конверты в ⚙️</div>`}
      </div>

      <div style="height:12px"></div>
      <button class="btn" id="ex_save">Записать расход</button>
    </section>

    <section class="card">
      <h2>Доход</h2>
      <input id="in_amt" class="input" placeholder="Сумма (например 35000)" inputmode="numeric" />
      <div style="height:10px"></div>

      <div class="muted">Источник</div>
      <div class="grid3" id="in_srcs">
        ${srcs.map(([k,label,h])=>`
          <button class="tag ${state.selectedSrc===k?'sel':''}" data-src="${k}">
            <span>${label}</span><small>${h}</small>
          </button>
        `).join("")}
      </div>

      <div id="in_other_wrap" class="${state.selectedSrc==='другое'?'':'hidden'}" style="margin-top:10px">
        <input id="in_other" class="input" placeholder="Название источника" />
      </div>

      <div style="height:10px"></div>
      <div class="muted">Зачислить на счёт</div>
      <div class="row" id="in_accs">
        ${state.accounts.length ? state.accounts.map(a=>`
          <button class="pill ${state.selectedAccount===a.name?'sel':''}" data-acc="${a.name}">
            ${a.name} (${fmt(a.balance)})
          </button>
        `).join("") : `<div class="muted">Сначала настрой конверты в ⚙️</div>`}
      </div>

      <div style="height:12px"></div>
      <button class="btn" id="in_save">Записать доход</button>
    </section>
  `;

  // категории — toggle
  document.querySelectorAll("#ex_cats .tag").forEach(b=>{
    b.onclick = ()=>{
      const c = b.dataset.cat;
      state.selectedCat = (state.selectedCat === c) ? null : c;

      if (state.selectedCat === "карманные") state.selectedAccount = "Карманные";
      if (state.selectedCat === "квартира") state.selectedAccount = "Основной";

      saveState();
      render();
    };
  });

  // источники — toggle
  document.querySelectorAll("#in_srcs .tag").forEach(b=>{
    b.onclick = ()=>{
      const s = b.dataset.src;
      state.selectedSrc = (state.selectedSrc === s) ? null : s;
      saveState();
      render();
    };
  });

  // счета — toggle
  document.querySelectorAll("#ex_accs .pill, #in_accs .pill").forEach(b=>{
    b.onclick = ()=>{
      const a = b.dataset.acc;
      state.selectedAccount = (state.selectedAccount === a) ? null : a;
      saveState();
      render();
    };
  });

  // save expense
  document.getElementById("ex_save").onclick = ()=>{
    const amtRaw = (document.getElementById("ex_amt").value||"").trim();
    const amt = parseInt(amtRaw,10);
    if (!Number.isFinite(amt) || amt<=0) return toast("Введи сумму");
    if (!state.selectedCat) return toast("Выбери категорию");
    if (!state.selectedAccount) return toast("Выбери счёт");

    let cat = state.selectedCat;
    if (cat === "другое"){
      cat = (document.getElementById("ex_other").value||"").trim().toLowerCase();
      if (!cat) return toast("Введи категорию");
    }

    updateAccount(state.selectedAccount, -amt);
    addOp("expense", cat, amt, state.selectedAccount);
    applyToPlan("expense", cat, amt);

    sendToBot({ v:1, type:"expense", amount: String(amt), category: cat, account: state.selectedAccount });

    toast("Сохранено");
    document.getElementById("ex_amt").value = "";
    render();
  };

  // save income
  document.getElementById("in_save").onclick = ()=>{
    const amtRaw = (document.getElementById("in_amt").value||"").trim();
    const amt = parseInt(amtRaw,10);
    if (!Number.isFinite(amt) || amt<=0) return toast("Введи сумму");
    if (!state.selectedSrc) return toast("Выбери источник");
    if (!state.selectedAccount) return toast("Выбери счёт");

    let src = state.selectedSrc;
    if (src === "другое"){
      src = (document.getElementById("in_other").value||"").trim().toLowerCase();
      if (!src) return toast("Введи источник");
    }

    updateAccount(state.selectedAccount, amt);
    addOp("income", src, amt, state.selectedAccount);
    applyToPlan("income", src, amt);

    sendToBot({ v:1, type:"income", amount: String(amt), category: src, account: state.selectedAccount });

    toast("Сохранено");
    document.getElementById("in_amt").value = "";
    render();
  };
}

function renderAnalytics(){
  const tb = totalBalance();
  const t = planTotals();

  const expMap = new Map();
  const incMap = new Map();
  for (const o of state.ops){
    if (o.kind === "expense"){
      expMap.set(o.title, (expMap.get(o.title)||0) + o.amount);
    } else if (o.kind === "income"){
      incMap.set(o.title, (incMap.get(o.title)||0) + o.amount);
    }
  }

  const expArr = Array.from(expMap.entries()).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const incArr = Array.from(incMap.entries()).sort((a,b)=>b[1]-a[1]).slice(0,6);

  const expSum = expArr.reduce((s,x)=>s+x[1],0) || 1;
  const incSum = incArr.reduce((s,x)=>s+x[1],0) || 1;

  if (!view) return;
  view.innerHTML = `
    <section class="card">
      <h2>Аналитика</h2>
      <div class="muted">Что анализируем: баланс, выполнение плана, топ категорий расходов и источников дохода.</div>
      <div style="height:10px"></div>
      <div class="muted">Баланс: <b>${fmt(tb)} ₽</b></div>
      <div class="muted">Доходы: <b>${fmt(t.income_done)} ₽</b> (план ${fmt(t.income_total)} ₽)</div>
      <div class="muted">Расходы: <b>${fmt(t.expense_done)} ₽</b> (план ${fmt(t.expense_total)} ₽)</div>
      <div class="muted">Сверх плана: +${fmt(state.plan.over_income)} ₽ · Перерасход: ${fmt(state.plan.over_expense)} ₽</div>
    </section>

    <section class="card">
      <h2>Топ расходов</h2>
      ${expArr.length ? `
        <div class="list">
          ${expArr.map(([k,v])=>analyticsLine(k,v,expSum)).join("")}
        </div>
      ` : `<div class="muted">Пока нет расходов</div>`}
    </section>

    <section class="card">
      <h2>Топ доходов</h2>
      ${incArr.length ? `
        <div class="list">
          ${incArr.map(([k,v])=>analyticsLine(k,v,incSum)).join("")}
        </div>
      ` : `<div class="muted">Пока нет доходов</div>`}
    </section>

    <section class="card">
      <button class="btn ghost" id="an_chat">Запросить отчёт в чате</button>
    </section>
  `;

  document.getElementById("an_chat").onclick = ()=>{
    sendToBot({ v:1, type:"analytics_request" });
    toast("Запрос отправлен");
  };
}

function analyticsLine(name, value, total){
  const pct = Math.min(100, Math.round((value/total)*100));
  return `
    <div class="item">
      <div class="left">
        <div>${escapeHtml(name)}</div>
        <div class="sub">${pct}% · ${fmt(value)} ₽</div>
      </div>
      <div class="right" style="Width:120px">
        <div class="progress"><div style="width:${pct}%"></div></div>
      </div>
    </div>
  `;
}

function wireModalHandlers(){
  const close = document.getElementById("m_close");
  if (close) close.onclick = closeModal;
  const back = document.getElementById("m_back");
  if (back) back.onclick = modalBack;
}

// старт
openOnboarding(false);
render();
