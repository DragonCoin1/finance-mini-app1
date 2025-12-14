const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const $ = (id) => document.getElementById(id);

const state = {
  user: tg?.initDataUnsafe?.user || null,
  tab: "home",
  accounts: [],
  defaultAccount: "Основной",
  savings: { enabled: false, name: "Сбережения", start: 0 },
  plan: { income: [], expense: [] },
  recent: [],
};

function fmt(n){ return (Math.round(Number(n)||0)).toLocaleString('ru-RU'); }

function loadLocal(){
  try{
    const raw = localStorage.getItem("fp_v2");
    if(!raw) return;
    Object.assign(state, JSON.parse(raw));
  }catch(e){}
}
function saveLocal(){
  localStorage.setItem("fp_v2", JSON.stringify({
    tab: state.tab,
    accounts: state.accounts,
    defaultAccount: state.defaultAccount,
    savings: state.savings,
    plan: state.plan,
    recent: state.recent.slice(0,30),
  }));
}
function show(el){ el.classList.remove("hidden"); }
function hide(el){ el.classList.add("hidden"); }

function showModal(title, bodyHtml){
  $("modal_title").textContent = title;
  $("modal_body").innerHTML = bodyHtml;
  show($("modal"));
}
$("modal_close").onclick = () => hide($("modal"));
$("modal").addEventListener("click", (e)=>{ if(e.target.id==="modal") hide($("modal")); });

function parseBulk(text){
  const parts = (text||"").split(/[,;\n]+/).map(s=>s.trim()).filter(Boolean);
  const ok=[], bad=[];
  for(const p of parts){
    const m = p.match(/^([0-9\s]+|[0-9]+\s*к)\s+(.+)$/i);
    if(!m){ bad.push(p); continue; }
    let numRaw = m[1].toLowerCase().replace(/\s+/g,"").trim();
    let amount = numRaw.endsWith("к") ? Number(numRaw.replace("к",""))*1000 : Number(numRaw);
    if(!isFinite(amount) || amount<=0){ bad.push(p); continue; }
    ok.push({ amount: Math.round(amount), name: m[2].trim() });
  }
  return { ok, bad };
}

function ensureBasics(){
  if(!Array.isArray(state.accounts) || state.accounts.length===0){
    state.accounts=["Основной"];
    state.defaultAccount="Основной";
  }
  if(!state.defaultAccount || !state.accounts.includes(state.defaultAccount)){
    state.defaultAccount=state.accounts[0];
  }
  if(!state.savings) state.savings={enabled:false,name:"Сбережения",start:0};
  if(!state.plan) state.plan={income:[],expense:[]};
  if(!state.recent) state.recent=[];
}

function needOnboarding(){ return !localStorage.getItem("fp_v2_done"); }
function setDone(){ localStorage.setItem("fp_v2_done","1"); }

function confirmInline(text){
  tg?.HapticFeedback?.notificationOccurred?.("success");
  tg?.showPopup?.({ title: "Готово", message: text, buttons: [{id:"ok", type:"default", text:"OK"}] });
}

function sendToBot(payload){
  try{ tg?.sendData(JSON.stringify(payload)); }catch(e){}
}

function monthKey(){
  const d=new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
}

function renderSetupAccounts(){
  const wrap=$("acc_list"); wrap.innerHTML="";
  state.accounts.forEach(a=>{
    const div=document.createElement("div");
    div.className="pill"+(a===state.defaultAccount?" active":"");
    div.textContent=a;
    div.onclick=()=>{ state.defaultAccount=a; renderSetupAccounts(); renderDefaultSelect(); saveLocal(); };
    wrap.appendChild(div);
  });
}
function renderDefaultSelect(){
  const sel=$("acc_default"); sel.innerHTML="";
  state.accounts.forEach(a=>{
    const opt=document.createElement("option");
    opt.value=a; opt.textContent=a;
    if(a===state.defaultAccount) opt.selected=true;
    sel.appendChild(opt);
  });
  sel.onchange=()=>{ state.defaultAccount=sel.value; renderSetupAccounts(); saveLocal(); };
}

function startApp(){
  $("subtitle").textContent = state.user ? `Пользователь: ${state.user.first_name||"—"}` : "Открой из Telegram";
  hide($("onboarding")); hide($("setup")); show($("main"));
  setTab(state.tab||"home");
}
function startSetup(){
  hide($("onboarding")); show($("setup")); hide($("main"));
  renderSetupAccounts(); renderDefaultSelect();
  $("savings_enabled").checked=!!state.savings.enabled;
  $("savings_name").value=state.savings.name||"Сбережения";
  $("savings_start").value=state.savings.start?String(state.savings.start):"";
  $("plan_income").value=state.plan.income.map(x=>`${x.amount} ${x.name}`).join(", ");
  $("plan_expense").value=state.plan.expense.map(x=>`${x.amount} ${x.name}`).join(", ");
}

function setTab(tab){
  state.tab=tab;
  document.querySelectorAll(".nav").forEach(b=>b.classList.toggle("active", b.dataset.tab===tab));
  renderTab(tab);
  saveLocal();
}
document.querySelectorAll(".nav").forEach(b=>b.addEventListener("click", ()=>setTab(b.dataset.tab)));

function renderHome(){
  const total=0;
  const accShort=state.accounts.slice(0,4);
  const recent=state.recent.slice(0,5).map(op=>{
    const sign=op.type==="income"?"+":op.type==="expense"?"−":"";
    const cls=op.type==="income"?"good":op.type==="expense"?"bad":"";
    return `<div class="op"><div class="l"><div class="t">${op.title}</div><div class="s">${op.account||""}</div></div><div class="amt ${cls}">${sign}${fmt(op.amount)} ₽</div></div>`;
  }).join("");
  const incPlan=state.plan.income.reduce((s,x)=>s+x.amount,0);
  const expPlan=state.plan.expense.reduce((s,x)=>s+x.amount,0);
  return `
    <div class="card">
      <div class="h">Баланс</div>
      <div class="kv"><div class="k">Всего</div><div class="v">${fmt(total)} ₽</div></div>
      <div class="small mt8">Конверты</div>
      <div class="listbox">
        ${accShort.map(a=>`<div class="pill">${a}</div>`).join("")}
        ${state.accounts.length>4?`<div class="pill" id="acc_more">ещё…</div>`:""}
      </div>
    </div>
    <div class="card">
      <div class="h">План месяца</div>
      <div class="kv"><div class="k">Доходы (план)</div><div class="v">${fmt(incPlan)} ₽</div></div>
      <div class="kv"><div class="k">Расходы (план)</div><div class="v">${fmt(expPlan)} ₽</div></div>
      <div class="progress"><div class="bar" style="width:${incPlan?20:0}%"></div></div>
      <div class="small mt8">Факт и отклонения добавим после синхронизации.</div>
    </div>
    <div class="card">
      <div class="h">Последние операции</div>
      <div class="oplist">${recent||`<div class="small">Пока пусто</div>`}</div>
    </div>
  `;
}

function renderPlan(){
  const ym=monthKey();
  const inc = state.plan.income.map((x,i)=>`
    <div class="op"><div class="l"><div class="t">${x.name}</div><div class="s">План: ${fmt(x.amount)} ₽</div></div>
    <button class="chip" data-act="income_from_plan" data-i="${i}">Получить</button></div>`
  ).join("") || `<div class="small">Нет запланированных доходов</div>`;
  const exp = state.plan.expense.map((x,i)=>`
    <div class="op"><div class="l"><div class="t">${x.name}</div><div class="s">План: ${fmt(x.amount)} ₽</div></div>
    <button class="chip" data-act="expense_from_plan" data-i="${i}">Потратить</button></div>`
  ).join("") || `<div class="small">Нет запланированных расходов</div>`;
  return `
    <div class="card"><div class="h">Планирование</div><div class="small">Месяц: ${ym}</div></div>
    <div class="card"><div class="h">Доходы</div><div class="oplist">${inc}</div>
      <button class="btn ghost mt10" id="plan_bulk">Добавить/изменить списком</button>
    </div>
    <div class="card"><div class="h">Расходы</div><div class="oplist">${exp}</div></div>
  `;
}

function topCategories(){
  const fromPlan=state.plan.expense.map(x=>x.name);
  const recentCats=state.recent.filter(x=>x.type==="expense").map(x=>x.title);
  const all=[...fromPlan, ...recentCats];
  const uniq=[];
  for(const c of all){
    if(!uniq.some(u=>u.toLowerCase()===c.toLowerCase())) uniq.push(c);
  }
  return uniq.slice(0,10);
}

function renderOps(){
  const cats=topCategories();
  const accs=state.accounts;
  const acc4=accs.slice(0,4);
  const ym=monthKey();
  return `
    <div class="card"><div class="h">Операции</div><div class="small">Месяц: ${ym}</div></div>

    <div class="card">
      <div class="h">Расход</div>
      <input id="exp_amount" class="input" placeholder="Сумма (например 1000)" inputmode="decimal" />
      <div class="small mt8">Категория</div>
      <div class="chips" id="exp_cats">
        ${cats.map(c=>`<button class="chip" data-cat="${c}">${c}</button>`).join("")}
        <button class="chip" data-cat="_other">Другое</button>
      </div>
      <input id="exp_other" class="input mt8 hidden" placeholder="Название категории" />
      <div class="small mt8">Списать с</div>
      <div class="chips" id="exp_accs">
        ${acc4.map(a=>`<button class="chip ${a===state.defaultAccount?'active':''}" data-acc="${a}">${a}</button>`).join("")}
        ${accs.length>4?`<button class="chip" id="acc_more_btn">ещё…</button>`:""}
      </div>
      <button class="btn mt10" id="exp_save">Сохранить расход</button>
      <div class="small mt8">Подтверждение — в приложении, без чата.</div>
    </div>

    <div class="card">
      <div class="h">Доход</div>
      <input id="inc_amount" class="input" placeholder="Сумма (например 35000)" inputmode="decimal" />
      <div class="small mt8">Источник</div>
      <div class="chips" id="inc_srcs">
        ${state.plan.income.slice(0,8).map(s=>`<button class="chip" data-src="${s.name}">${s.name}</button>`).join("")}
        <button class="chip" data-src="_unplanned">Незапланированный</button>
      </div>
      <div class="small mt8">Зачислить на</div>
      <div class="chips" id="inc_accs">
        ${acc4.map(a=>`<button class="chip ${a===state.defaultAccount?'active':''}" data-acc="${a}">${a}</button>`).join("")}
        ${accs.length>4?`<button class="chip" id="inc_more_btn">ещё…</button>`:""}
      </div>
      <button class="btn mt10" id="inc_save">Сохранить доход</button>
    </div>

    <div class="card">
      <div class="h">Перевод</div>
      <div class="grid">
        <select id="tr_from" class="input">${accs.map(a=>`<option value="${a}">${a}</option>`).join("")}</select>
        <select id="tr_to" class="input">${accs.map(a=>`<option value="${a}">${a}</option>`).join("")}</select>
      </div>
      <input id="tr_amount" class="input mt8" placeholder="Сумма (например 20000)" inputmode="decimal" />
      <button class="btn mt10" id="tr_save">Сохранить перевод</button>
    </div>

    <div class="card">
      <div class="h">Сейф</div>
      ${state.savings.enabled ? `
        <div class="small">Сейф: ${state.savings.name||"Сбережения"}</div>
        <div class="grid mt8">
          <button class="btn ghost" id="sv_add">Пополнить</button>
          <button class="btn ghost" id="sv_take">Снять</button>
        </div>
      ` : `<div class="small">Сейф выключен (включается в первичной настройке).</div>`}
    </div>
  `;
}

function renderAnalytics(){
  return `
    <div class="card">
      <div class="h">Аналитика</div>
      <div class="p">Здесь будут графики и диаграммы: план vs факт, категории, динамика по месяцам. Добавим после синхронизации.</div>
    </div>
  `;
}

function renderTab(tab){
  const content=$("content");
  if(tab==="home") content.innerHTML=renderHome();
  if(tab==="plan") content.innerHTML=renderPlan();
  if(tab==="ops") content.innerHTML=renderOps();
  if(tab==="analytics") content.innerHTML=renderAnalytics();

  if(tab==="home"){
    const more=$("acc_more");
    if(more){
      more.onclick=()=>showModal("Конверты", state.accounts.map(a=>`<div class="op"><div class="t">${a}</div></div>`).join(""));
    }
  }

  if(tab==="plan"){
    $("plan_bulk").onclick=()=>{ hide($("main")); show($("setup")); window.scrollTo({top:0,behavior:"smooth"}); };

    document.querySelectorAll("[data-act='income_from_plan']").forEach(btn=>{
      btn.onclick=()=>{
        const i=Number(btn.dataset.i);
        const item=state.plan.income[i];
        showModal("Получить доход", `
          <div class="small">План: ${fmt(item.amount)} ₽ • ${item.name}</div>
          <input id="m_amt" class="input mt8" value="${item.amount}" />
          <div class="small mt8">Конверт</div>
          <div class="chips" id="m_accs">
            ${state.accounts.slice(0,6).map(a=>`<button class="chip ${a===state.defaultAccount?'active':''}" data-acc="${a}">${a}</button>`).join("")}
          </div>
          <button class="btn mt10" id="m_ok">Сохранить</button>
        `);
        let selAcc=state.defaultAccount;
        $("modal_body").querySelectorAll("#m_accs .chip").forEach(c=>{
          c.onclick=()=>{
            $("modal_body").querySelectorAll("#m_accs .chip").forEach(x=>x.classList.remove("active"));
            c.classList.add("active"); selAcc=c.dataset.acc;
          };
        });
        $("m_ok").onclick=()=>{
          const amt=Number(($("m_amt").value||"").replace(/\s+/g,"").replace(",","."));
          if(!amt||amt<=0) return;
          state.recent.unshift({type:"income",amount:amt,title:item.name,account:selAcc});
          state.recent=state.recent.slice(0,30); saveLocal();
          sendToBot({v:2,type:"income",amount:amt,category:item.name,account:selAcc,plan_hint:{kind:"income",name:item.name}});
          hide($("modal")); confirmInline("Доход сохранён"); setTab("ops");
        };
      };
    });

    document.querySelectorAll("[data-act='expense_from_plan']").forEach(btn=>{
      btn.onclick=()=>{
        const i=Number(btn.dataset.i);
        const item=state.plan.expense[i];
        showModal("Расход по плану", `
          <div class="small">План: ${fmt(item.amount)} ₽ • ${item.name}</div>
          <input id="m_amt" class="input mt8" placeholder="Сумма (например 1000)" />
          <div class="small mt8">Конверт</div>
          <div class="chips" id="m_accs">
            ${state.accounts.slice(0,6).map(a=>`<button class="chip ${a===state.defaultAccount?'active':''}" data-acc="${a}">${a}</button>`).join("")}
          </div>
          <button class="btn mt10" id="m_ok">Сохранить</button>
        `);
        let selAcc=state.defaultAccount;
        $("modal_body").querySelectorAll("#m_accs .chip").forEach(c=>{
          c.onclick=()=>{
            $("modal_body").querySelectorAll("#m_accs .chip").forEach(x=>x.classList.remove("active"));
            c.classList.add("active"); selAcc=c.dataset.acc;
          };
        });
        $("m_ok").onclick=()=>{
          const amt=Number(($("m_amt").value||"").replace(/\s+/g,"").replace(",","."));
          if(!amt||amt<=0) return;
          state.recent.unshift({type:"expense",amount:amt,title:item.name,account:selAcc});
          state.recent=state.recent.slice(0,30); saveLocal();
          sendToBot({v:2,type:"expense",amount:amt,category:item.name,account:selAcc,plan_hint:{kind:"expense",name:item.name}});
          hide($("modal")); confirmInline("Расход сохранён"); setTab("ops");
        };
      };
    });
  }

  if(tab==="ops"){
    let expCat=null; let expAcc=state.defaultAccount;

    document.querySelectorAll("#exp_cats .chip").forEach(btn=>{
      btn.onclick=()=>{
        document.querySelectorAll("#exp_cats .chip").forEach(x=>x.classList.remove("active"));
        btn.classList.add("active");
        const c=btn.dataset.cat;
        if(c==="_other"){ $("exp_other").classList.remove("hidden"); expCat=null; }
        else{
          $("exp_other").classList.add("hidden"); expCat=c;
          const maybe=state.accounts.find(a=>a.toLowerCase()===c.toLowerCase());
          if(maybe){ expAcc=maybe; setTab("ops"); }
        }
      };
    });

    document.querySelectorAll("#exp_accs .chip").forEach(btn=>{
      if(btn.id==="acc_more_btn"){
        btn.onclick=()=>{
          showModal("Выбери конверт", state.accounts.map(a=>`<button class="chip" data-pick="${a}">${a}</button>`).join(""));
          $("modal_body").querySelectorAll("[data-pick]").forEach(p=>{
            p.onclick=()=>{ expAcc=p.dataset.pick; hide($("modal")); setTab("ops"); };
          });
        };
      }else{
        btn.onclick=()=>{
          document.querySelectorAll("#exp_accs .chip").forEach(x=>x.classList.remove("active"));
          btn.classList.add("active"); expAcc=btn.dataset.acc;
        };
      }
    });

    $("exp_save").onclick=()=>{
      const amt=Number(($("exp_amount").value||"").replace(/\s+/g,"").replace(",","."));
      const cat=expCat || ($("exp_other").value||"").trim();
      if(!amt||amt<=0) return confirmInline("Укажи сумму");
      if(!cat) return confirmInline("Выбери категорию");
      state.recent.unshift({type:"expense",amount:amt,title:cat,account:expAcc});
      state.recent=state.recent.slice(0,30); saveLocal();
      sendToBot({v:2,type:"expense",amount:amt,category:cat,account:expAcc});
      $("exp_amount").value=""; $("exp_other").value="";
      confirmInline("Расход сохранён");
    };

    let incSrc=null; let incAcc=state.defaultAccount;

    document.querySelectorAll("#inc_srcs .chip").forEach(btn=>{
      btn.onclick=()=>{
        document.querySelectorAll("#inc_srcs .chip").forEach(x=>x.classList.remove("active"));
        btn.classList.add("active");
        const s=btn.dataset.src;
        incSrc = s==="_unplanned" ? "Незапланированный доход" : s;
      };
    });

    document.querySelectorAll("#inc_accs .chip").forEach(btn=>{
      if(btn.id==="inc_more_btn"){
        btn.onclick=()=>{
          showModal("Выбери конверт", state.accounts.map(a=>`<button class="chip" data-pick="${a}">${a}</button>`).join(""));
          $("modal_body").querySelectorAll("[data-pick]").forEach(p=>{
            p.onclick=()=>{ incAcc=p.dataset.pick; hide($("modal")); setTab("ops"); };
          });
        };
      }else{
        btn.onclick=()=>{
          document.querySelectorAll("#inc_accs .chip").forEach(x=>x.classList.remove("active"));
          btn.classList.add("active"); incAcc=btn.dataset.acc;
        };
      }
    });

    $("inc_save").onclick=()=>{
      const amt=Number(($("inc_amount").value||"").replace(/\s+/g,"").replace(",","."));
      if(!amt||amt<=0) return confirmInline("Укажи сумму");
      const src=incSrc || "Незапланированный доход";
      state.recent.unshift({type:"income",amount:amt,title:src,account:incAcc});
      state.recent=state.recent.slice(0,30); saveLocal();
      sendToBot({v:2,type:"income",amount:amt,category:src,account:incAcc});
      $("inc_amount").value="";
      confirmInline("Доход сохранён");
    };

    $("tr_save").onclick=()=>{
      const amt=Number(($("tr_amount").value||"").replace(/\s+/g,"").replace(",","."));
      const f=$("tr_from").value, t=$("tr_to").value;
      if(!amt||amt<=0) return confirmInline("Укажи сумму");
      if(f===t) return confirmInline("Выбери разные конверты");
      state.recent.unshift({type:"transfer",amount:amt,title:`${f} → ${t}`,account:""});
      state.recent=state.recent.slice(0,30); saveLocal();
      sendToBot({v:2,type:"transfer",amount:amt,from:f,to:t});
      $("tr_amount").value="";
      confirmInline("Перевод сохранён");
    };

    if(state.savings.enabled){
      $("sv_add").onclick=()=>{
        showModal("Пополнить сейф", `
          <div class="small">Сейф: ${state.savings.name}</div>
          <input id="m_amt" class="input mt8" placeholder="Сумма" />
          <div class="small mt8">Откуда</div>
          <div class="chips" id="m_accs">
            ${state.accounts.slice(0,6).map(a=>`<button class="chip ${a===state.defaultAccount?'active':''}" data-acc="${a}">${a}</button>`).join("")}
          </div>
          <button class="btn mt10" id="m_ok">Сохранить</button>
        `);
        let from=state.defaultAccount;
        $("modal_body").querySelectorAll("#m_accs .chip").forEach(c=>{
          c.onclick=()=>{
            $("modal_body").querySelectorAll("#m_accs .chip").forEach(x=>x.classList.remove("active"));
            c.classList.add("active"); from=c.dataset.acc;
          };
        });
        $("m_ok").onclick=()=>{
          const amt=Number(($("m_amt").value||"").replace(/\s+/g,"").replace(",","."));
          if(!amt||amt<=0) return;
          state.recent.unshift({type:"transfer",amount:amt,title:`${from} → ${state.savings.name}`,account:""});
          state.recent=state.recent.slice(0,30); saveLocal();
          sendToBot({v:2,type:"transfer",amount:amt,from:from,to:state.savings.name});
          hide($("modal")); confirmInline("Сейф пополнен");
        };
      };
      $("sv_take").onclick=()=>{
        showModal("Снять из сейфа", `
          <div class="small">Сейф: ${state.savings.name}</div>
          <input id="m_amt" class="input mt8" placeholder="Сумма" />
          <div class="small mt8">Куда</div>
          <div class="chips" id="m_accs">
            ${state.accounts.slice(0,6).map(a=>`<button class="chip ${a===state.defaultAccount?'active':''}" data-acc="${a}">${a}</button>`).join("")}
          </div>
          <button class="btn mt10" id="m_ok">Сохранить</button>
        `);
        let to=state.defaultAccount;
        $("modal_body").querySelectorAll("#m_accs .chip").forEach(c=>{
          c.onclick=()=>{
            $("modal_body").querySelectorAll("#m_accs .chip").forEach(x=>x.classList.remove("active"));
            c.classList.add("active"); to=c.dataset.acc;
          };
        });
        $("m_ok").onclick=()=>{
          const amt=Number(($("m_amt").value||"").replace(/\s+/g,"").replace(",","."));
          if(!amt||amt<=0) return;
          state.recent.unshift({type:"transfer",amount:amt,title:`${state.savings.name} → ${to}`,account:""});
          state.recent=state.recent.slice(0,30); saveLocal();
          sendToBot({v:2,type:"transfer",amount:amt,from:state.savings.name,to:to});
          hide($("modal")); confirmInline("Снятие сохранено");
        };
      };
    }
  }
}

function boot(){
  loadLocal(); ensureBasics();

  if(needOnboarding()){
    show($("onboarding")); hide($("setup")); hide($("main"));
    $("ob_start").onclick=()=>startSetup();
    $("ob_skip").onclick=()=>{ setDone(); startApp(); };
    return;
  }

  const needs = state.accounts.length===0 || (state.plan.income.length===0 && state.plan.expense.length===0);
  if(needs) startSetup(); else startApp();
}

$("setup_next").onclick=()=>{ setDone(); saveLocal(); startApp(); };

$("acc_presets").addEventListener("click",(e)=>{
  const btn=e.target.closest("[data-acc]"); if(!btn) return;
  const name=btn.dataset.acc;
  if(!state.accounts.includes(name)) state.accounts.push(name);
  renderSetupAccounts(); renderDefaultSelect(); saveLocal();
});

$("acc_add").onclick=()=>{
  const v=($("acc_custom").value||"").trim(); if(!v) return;
  if(!state.accounts.includes(v)) state.accounts.push(v);
  $("acc_custom").value="";
  renderSetupAccounts(); renderDefaultSelect(); saveLocal();
};

$("savings_enabled").onchange=()=>{ state.savings.enabled=$("savings_enabled").checked; saveLocal(); };
$("savings_name").oninput=()=>{ state.savings.name=($("savings_name").value||"").trim()||"Сбережения"; saveLocal(); };
$("savings_start").oninput=()=>{
  const v=Number(($("savings_start").value||"").replace(/\s+/g,"").replace(",","."));
  state.savings.start=isFinite(v)?Math.round(v):0; saveLocal();
};

$("plan_save").onclick=()=>{
  const inc=parseBulk($("plan_income").value);
  const exp=parseBulk($("plan_expense").value);
  state.plan.income=inc.ok; state.plan.expense=exp.ok; saveLocal();
  $("plan_result").textContent =
    `Доходы: добавлено ${inc.ok.length}${inc.bad.length?`, ошибки: ${inc.bad.length}`:""} • ` +
    `Расходы: добавлено ${exp.ok.length}${exp.bad.length?`, ошибки: ${exp.bad.length}`:""}`;
  sendToBot({v:2,type:"plan_bulk",month:monthKey(),income:inc.ok,expense:exp.ok});
  confirmInline("План сохранён");
};

boot();
