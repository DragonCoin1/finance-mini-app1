const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const view = document.getElementById("view");
const subtitle = document.getElementById("subtitle");

const modalBackdrop = document.getElementById("modal_backdrop");
const modal = document.getElementById("modal");
const btnSettings = document.getElementById("btn_settings");

// ===== Modal stack: “назад” в модалках =====
const modalStack = [];
function openModal(html, push=true){
  if (push && modal.innerHTML.trim()) modalStack.push(modal.innerHTML);
  modal.innerHTML = html;
  modalBackdrop.classList.remove("hidden");
}
function modalBack(){
  if (!modalStack.length) return;
  modal.innerHTML = modalStack.pop();
  // важно: после возврата нужно перевесить события
  wireModalHandlers();
}
function closeModal(){
  modalStack.length = 0;
  modalBackdrop.classList.add("hidden");
  modal.innerHTML = "";
}
modalBackdrop.addEventListener("click", (e)=>{
  if (e.target === modalBackdrop) closeModal();
});

function toast(text){
  if (tg?.showToast) tg.showToast({ text });
  else if (tg?.showPopup) tg.showPopup({ message: text });
  else alert(text);
}

function fmt(n){
  const x = Math.round(Number(n)||0);
  return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

// ===== App state (UI-only MVP) =====
const state = {
  tab: "home",
  // пока это UI-заглушки, чтобы ты допилил интерфейс
  // позже подключим реальные данные
  totalBalance: 82000,
  accounts: [
    { name:"Основной", balance:57200 },
    { name:"Личные", balance:25000 },
    { name:"Карманные", balance:7300 },
    { name:"Наличные", balance:2100 },
  ],
  plan: {
    income_total: 35000,
    income_done: 20000,
    expense_total: 58000,
    expense_done: 19000,
    over_income: 1000,
    over_expense: 0,
    items_income: [
      { id:1, title:"зарплата", planned:35000, done:20000, left:15000, kind:"income" }
    ],
    items_expense: [
      { id:2, title:"квартира", planned:19000, done:19000, left:0, kind:"expense" },
      { id:3, title:"продукты", planned:14000, done:0, left:14000, kind:"expense" },
      { id:4, title:"карманные", planned:25000, done:0, left:25000, kind:"expense" }
    ]
  },
  lastTx: [
    { type:"expense", title:"квартира", amount:19000, account:"Основной", when:"сегодня" },
    { type:"income", title:"зарплата", amount:20000, account:"Основной", when:"сегодня" }
  ],
  selectedAccount: "Основной",
  selectedCat: null,
  selectedSrc: null,
};

function setSubtitle(){
  const u = tg?.initDataUnsafe?.user;
  if (u?.first_name) subtitle.textContent = `Пользователь: ${u.first_name}`;
  else subtitle.textContent = "";
}
setSubtitle();

function sendToBot(payload){
  // Это MVP-режим через sendData.
  // Да, Telegram может закрывать WebView — мы это уберём позже через API.
  try{
    tg?.sendData(JSON.stringify(payload));
  }catch(e){
    toast("Не удалось отправить");
  }
}

// ===== Navigation =====
function nav(tab){
  state.tab = tab;
  document.querySelectorAll(".navbtn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  render();
}
document.querySelectorAll(".navbtn").forEach(b => b.addEventListener("click", ()=> nav(b.dataset.tab)));

// ===== Settings =====
btnSettings.addEventListener("click", ()=>{
  openModal(`
    <div class="modalbar">
      <button class="backbtn" id="m_close">Закрыть</button>
      <div class="muted">Настройки</div>
      <div style="width:80px"></div>
    </div>
    <button class="btn ghost" id="m_help">Как это работает</button>
    <div style="height:10px"></div>
    <button class="btn ghost" id="m_setup">Первичная настройка</button>
  `, false);
  wireModalHandlers();
});

// ===== Onboarding =====
function openOnboarding(force=false){
  const key = "fp_onboarded_v2";
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
      <div class="muted">Запланируй доходы и расходы. Факт закрывает план автоматически.</div>
    </div>

    <div class="card" style="margin:0 0 10px; padding:12px">
      <h2 style="margin:0 0 6px">Сбережения</h2>
      <div class="muted">Сбережения — это сейф. Здесь ты хранишь и копишь деньги. Они не участвуют в повседневных расходах и не тратятся случайно.</div>
    </div>

    <div class="actions">
      <button class="btn" id="ob_start">Далее</button>
      <button class="btn ghost" id="ob_skip">Пропустить</button>
    </div>
  `, false);

  wireModalHandlers();

  document.getElementById("ob_skip").onclick = ()=>{
    localStorage.setItem(key, "1");
    closeModal();
  };
  document.getElementById("ob_start").onclick = ()=>{
    localStorage.setItem(key, "1");
    closeModal();
    openSetupStepAccounts();
  };
}

// ===== Setup step 1: accounts (toggle) =====
function openSetupStepAccounts(){
  const selected = new Set(["Основной","Личные","Карманные","Наличные"]);

  openModal(`
    <div class="modalbar">
      <button class="backbtn" id="m_back">Назад</button>
      <button class="backbtn" id="m_close">Закрыть</button>
    </div>

    <h3>Конверты</h3>
    <div class="muted">Тап по выбранному конверту снимает выбор. Нужен хотя бы один.</div>
    <div style="height:10px"></div>

    <div class="grid2">
      ${["Основной","Личные","Карманные","Наличные"].map(a=>`
        <button class="pill sel" data-acc="${a}">${a}</button>
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

      if (selected.size === 0) {
        selected.add(a);
        p.classList.add("sel");
        toast("Нужен хотя бы один конверт");
      }
    };
  });

  document.getElementById("acc_next").onclick = ()=>{
    closeModal();
    // отправим боту выбранные конверты
    sendToBot({ v:1, type:"setup_accounts", accounts: Array.from(selected) });
    openSetupStepPlan();
  };
}

// ===== Setup step 2: plan bulk with “назад” =====
function openSetupStepPlan(){
  openModal(`
    <div class="modalbar">
      <button class="backbtn" id="m_back">Назад</button>
      <button class="backbtn" id="m_close">Закрыть</button>
    </div>

    <h3>План месяца</h3>
    <div class="muted" style="margin-bottom:10px">Можно вставить списком. Потом всё редактируется.</div>

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
  document.getElementById("m_back").onclick = ()=>{ closeModal(); openSetupStepAccounts(); };

  document.getElementById("p_skip").onclick = ()=>{
    closeModal();
    toast("Ок");
  };

  document.getElementById("p_done").onclick = ()=>{
    const income = document.getElementById("p_income").value || "";
    const expense = document.getElementById("p_expense").value || "";
    closeModal();
    sendToBot({ v:1, type:"plan_bulk", income_text: income, expense_text: expense });
    toast("План отправлен");
  };
}

// ===== Render tabs =====
function render(){
  if (state.tab === "home") return renderHome();
  if (state.tab === "plan") return renderPlan();
  if (state.tab === "ops") return renderOps();
  if (state.tab === "analytics") return renderAnalytics();
}

function renderHome(){
  const incPct = state.plan.income_total ? Math.min(100, Math.round((state.plan.income_done/state.plan.income_total)*100)) : 0;
  const expPct = state.plan.expense_total ? Math.min(100, Math.round((state.plan.expense_done/state.plan.expense_total)*100)) : 0;

  view.innerHTML = `
    <section class="card">
      <h2>Баланс</h2>
      <div class="kpi">${fmt(state.totalBalance)} ₽</div>
      <div style="height:10px"></div>
      <div class="row" id="home_accs">
        ${state.accounts.slice(0,4).map(a=>`
          <button class="pill ${a.name===state.selectedAccount?'sel':''}" data-acc="${a.name}">${a.name} (${fmt(a.balance)})</button>
        `).join('')}
        ${state.accounts.length>4?`<button class="pill" id="acc_more">Ещё…</button>`:''}
      </div>
    </section>

    <section class="card">
      <h2>План месяца</h2>

      <div class="muted">Доходы</div>
      <div class="progress"><div style="width:${incPct}%"></div></div>
      <div class="muted" style="margin-top:6px">${fmt(state.plan.income_done)} / ${fmt(state.plan.income_total)} ₽</div>

      <div style="height:10px"></div>

      <div class="muted">Расходы</div>
      <div class="progress"><div style="width:${expPct}%"></div></div>
      <div class="muted" style="margin-top:6px">${fmt(state.plan.expense_done)} / ${fmt(state.plan.expense_total)} ₽</div>

      <div style="height:10px"></div>
      <div class="muted">Сверх плана: +${fmt(state.plan.over_income)} ₽ · Перерасход: ${fmt(state.plan.over_expense)} ₽</div>
    </section>

    <section class="card">
      <h2>История</h2>
      <div class="list">
        ${state.lastTx.map(txItem).join('')}
      </div>
      <div style="height:10px"></div>
      <button class="btn ghost" id="go_ops">Операции</button>
    </section>
  `;

  document.getElementById("go_ops").onclick = ()=> nav("ops");
  document.querySelectorAll("#home_accs .pill[data-acc]").forEach(b=>{
    b.onclick = ()=>{
      const a = b.dataset.acc;
      // toggle selection: если нажал на выбранный — снимаем
      if (state.selectedAccount === a) state.selectedAccount = null;
      else state.selectedAccount = a;
      render();
    };
  });
}

function txItem(t){
  const sign = t.type === "income" ? "+" : (t.type === "expense" ? "−" : "↔");
  return `
    <div class="item">
      <div class="left">
        <div>${escapeHtml(t.title)}</div>
        <div class="sub">${escapeHtml(t.account || '')} · ${escapeHtml(t.when || '')}</div>
      </div>
      <div class="right">${sign}${fmt(t.amount)}</div>
    </div>
  `;
}

function renderPlan(){
  view.innerHTML = `
    <section class="card">
      <h2>Планирование</h2>
      <div class="muted">Добавление списком НЕ должно сбрасывать остальное (это чинится в боте). В UI делаем правильные кнопки.</div>
      <div style="height:10px"></div>
      <button class="btn" id="plan_bulk">Добавить/изменить списком</button>
      <div style="height:10px"></div>
      <button class="btn danger" id="plan_clear">Очистить план месяца</button>
    </section>

    <section class="card">
      <h2>Доходы</h2>
      <div class="list">
        ${state.plan.items_income.map(planItem).join('')}
      </div>
    </section>

    <section class="card">
      <h2>Расходы</h2>
      <div class="list">
        ${state.plan.items_expense.map(planItem).join('')}
      </div>
    </section>
  `;

  document.getElementById("plan_bulk").onclick = ()=> openSetupStepPlan();
  document.getElementById("plan_clear").onclick = ()=>{
    openModal(`
      <div class="modalbar">
        <button class="backbtn" id="m_close">Закрыть</button>
        <div class="muted">Подтверждение</div>
        <div style="width:80px"></div>
      </div>
      <h3>Очистить план?</h3>
      <div class="muted">Удалится план текущего месяца.</div>
      <div class="actions">
        <button class="btn danger" id="c_ok">Очистить</button>
        <button class="btn ghost" id="c_no">Отмена</button>
      </div>
    `, false);
    wireModalHandlers();
    document.getElementById("c_no").onclick = closeModal;
    document.getElementById("c_ok").onclick = ()=>{
      closeModal();
      sendToBot({ v:1, type:"plan_clear" });
      toast("Отправлено");
    };
  };
}

function planItem(p){
  return `
    <div class="item">
      <div class="left">
        <div>${escapeHtml(p.title)}</div>
        <div class="sub">План: ${fmt(p.planned)} · Закрыто: ${fmt(p.done)} · Осталось: ${fmt(p.left)}</div>
      </div>
      <div class="right"></div>
    </div>
  `;
}

function renderOps(){
  const cats = [
    { key:"продукты", label:"🛒 Продукты", hint:"план" },
    { key:"квартира", label:"🏠 Квартира", hint:"план" },
    { key:"карманные", label:"🎒 Карманные", hint:"план" },
    { key:"транспорт", label:"🚕 Транспорт", hint:"часто" },
    { key:"кафе", label:"🍽 Кафе", hint:"часто" },
    { key:"другое", label:"✍️ Другое", hint:"ввод" },
  ];

  const srcs = [
    { key:"зарплата", label:"💳 Зарплата", hint:"план" },
    { key:"пенсия", label:"🏦 Пенсия", hint:"план" },
    { key:"подработка", label:"💳 Подработка", hint:"план" },
    { key:"незапланированный", label:"➕ Не по плану", hint:"факт" },
    { key:"другое", label:"✍️ Другое", hint:"ввод" },
  ];

  view.innerHTML = `
    <section class="card">
      <h2>Операции</h2>
      <div class="muted">Сумма вводом, остальное — выбором. Повторный тап снимает выбор.</div>
    </section>

    <section class="card">
      <h2>Расход</h2>
      <input id="ex_amt" class="input" placeholder="Сумма (например 1000)" inputmode="numeric" />
      <div style="height:10px"></div>
      <div class="muted">Категория</div>
      <div class="grid3" id="ex_cats">
        ${cats.map(c=>`
          <button class="tag ${state.selectedCat===c.key?'sel':''}" data-cat="${c.key}"><span>${c.label}</span><small>${c.hint}</small></button>
        `).join('')}
      </div>

      <div id="ex_other_wrap" class="${state.selectedCat==='другое'?'':'hidden'}" style="margin-top:10px">
        <input id="ex_other" class="input" placeholder="Название категории" />
      </div>

      <div style="height:10px"></div>
      <div class="muted">Списать со счёта</div>
      <div class="row" id="ex_accs">
        ${state.accounts.slice(0,4).map(a=>`
          <button class="pill ${state.selectedAccount===a.name?'sel':''}" data-acc="${a.name}">${a.name} (${fmt(a.balance)})</button>
        `).join('')}
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
        ${srcs.map(s=>`
          <button class="tag ${state.selectedSrc===s.key?'sel':''}" data-src="${s.key}"><span>${s.label}</span><small>${s.hint}</small></button>
        `).join('')}
      </div>

      <div id="in_other_wrap" class="${state.selectedSrc==='другое'?'':'hidden'}" style="margin-top:10px">
        <input id="in_other" class="input" placeholder="Название источника" />
      </div>

      <div style="height:10px"></div>
      <div class="muted">Зачислить на счёт</div>
      <div class="row" id="in_accs">
        ${state.accounts.slice(0,4).map(a=>`
          <button class="pill ${state.selectedAccount===a.name?'sel':''}" data-acc="${a.name}">${a.name} (${fmt(a.balance)})</button>
        `).join('')}
      </div>

      <div style="height:12px"></div>
      <button class="btn" id="in_save">Записать доход</button>
    </section>
  `;

  // toggle категории
  document.querySelectorAll("#ex_cats .tag").forEach(b=>{
    b.onclick = ()=>{
      const c = b.dataset.cat;
      if (state.selectedCat === c) state.selectedCat = null;
      else state.selectedCat = c;
      // умный дефолт счёта
      if (state.selectedCat === "карманные") state.selectedAccount = "Карманные";
      if (state.selectedCat === "квартира") state.selectedAccount = "Основной";
      render();
    };
  });

  document.querySelectorAll("#in_srcs .tag").forEach(b=>{
    b.onclick = ()=>{
      const s = b.dataset.src;
      if (state.selectedSrc === s) state.selectedSrc = null;
      else state.selectedSrc = s;
      render();
    };
  });

  // toggle счёта
  document.querySelectorAll("#ex_accs .pill, #in_accs .pill").forEach(b=>{
    b.onclick = ()=>{
      const a = b.dataset.acc;
      if (state.selectedAccount === a) state.selectedAccount = null;
      else state.selectedAccount = a;
      render();
    };
  });

  document.getElementById("ex_save").onclick = ()=>{
    const amt = (document.getElementById("ex_amt").value||"").trim();
    if (!amt) return toast("Введи сумму");
    if (!state.selectedCat) return toast("Выбери категорию");
    if (!state.selectedAccount) return toast("Выбери счёт");

    let cat = state.selectedCat;
    if (cat === "другое") {
      cat = (document.getElementById("ex_other").value||"").trim().toLowerCase();
      if (!cat) return toast("Введи категорию");
    }
    sendToBot({ v:1, type:"expense", amount: amt, category: cat, account: state.selectedAccount });
    toast("Отправлено");
  };

  document.getElementById("in_save").onclick = ()=>{
    const amt = (document.getElementById("in_amt").value||"").trim();
    if (!amt) return toast("Введи сумму");
    if (!state.selectedSrc) return toast("Выбери источник");
    if (!state.selectedAccount) return toast("Выбери счёт");

    let src = state.selectedSrc;
    if (src === "другое") {
      src = (document.getElementById("in_other").value||"").trim().toLowerCase();
      if (!src) return toast("Введи источник");
    }
    sendToBot({ v:1, type:"income", amount: amt, category: src, account: state.selectedAccount });
    toast("Отправлено");
  };
}

function renderAnalytics(){
  view.innerHTML = `
    <section class="card">
      <h2>Аналитика</h2>
      <div class="muted">Пока это UI. Позже подключим реальные диаграммы и данные.</div>
      <div style="height:10px"></div>
      <button class="btn ghost" id="an_req">Запросить отчёт в чате</button>
    </section>
  `;
  document.getElementById("an_req").onclick = ()=>{
    sendToBot({ v:1, type:"analytics_request" });
    toast("Отправлено");
  };
}

// ===== Modal wiring (после modalBack нужно снова навесить) =====
function wireModalHandlers(){
  const close = document.getElementById("m_close");
  if (close) close.onclick = closeModal;
  const back = document.getElementById("m_back");
  if (back) back.onclick = modalBack;

  const mHelp = document.getElementById("m_help");
  if (mHelp) mHelp.onclick = ()=>{ closeModal(); openOnboarding(true); };

  const mSetup = document.getElementById("m_setup");
  if (mSetup) mSetup.onclick = ()=>{ closeModal(); openSetupStepAccounts(); };
}

// старт
openOnboarding(false);
render();

function escapeHtml(s){ return String(s??"").replace(/[&<>\"]/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c])); }
