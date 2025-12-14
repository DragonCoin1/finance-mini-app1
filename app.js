const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const screen = document.getElementById("screen");
const subtitle = document.getElementById("subtitle");

if (tg?.initDataUnsafe?.user) {
  subtitle.textContent = `Привет, ${tg.initDataUnsafe.user.first_name || "!"}`;
} else {
  subtitle.textContent = `Открой из Telegram`;
}

function q(id){ return document.getElementById(id); }

function send(payload) {
  // В бот улетит строка JSON
  tg.sendData(JSON.stringify(payload));
  // Для MVP удобно закрывать после отправки
  tg.close();
}

function setTab(name) {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  render(name);
}

document.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));

function quickButtons(onPick){
  return `
    <div class="quick">
      <button class="pill" data-q="100">+100</button>
      <button class="pill" data-q="500">+500</button>
      <button class="pill" data-q="1000">+1000</button>
      <button class="pill" data-q="5000">+5000</button>
      <button class="pill" data-q="10000">+10000</button>
    </div>
  `;
}

function wireQuick(inputId){
  screen.querySelectorAll(".pill").forEach(btn => {
    btn.addEventListener("click", () => {
      const add = Number(btn.dataset.q);
      const el = q(inputId);
      const cur = Number((el.value || "0").replace(",", "."));
      el.value = String((isNaN(cur) ? 0 : cur) + add);
    });
  });
}

function render(tab) {
  if (tab === "ops") {
    screen.innerHTML = `
      <div class="card">
        <div class="h">➖ Расход</div>
        <div class="small">Сумма, категория и счёт (по умолчанию: карта)</div>
        <div class="hr"></div>

        <input id="e_amt" class="input" placeholder="Сумма (например 1000)" inputmode="decimal" />
        ${quickButtons()}
        <div class="hr"></div>

        <div class="row">
          <input id="e_cat" class="input" placeholder="Категория (продукты)" />
          <input id="e_acc" class="input" placeholder="Счёт (карта)" />
        </div>
        <div class="hr"></div>

        <button class="btn" id="btn_exp">Записать расход</button>
      </div>

      <div class="card">
        <div class="h">➕ Доход</div>
        <div class="small">Сумма, источник и счёт (по умолчанию: карта)</div>
        <div class="hr"></div>

        <input id="i_amt" class="input" placeholder="Сумма (например 82000)" inputmode="decimal" />
        ${quickButtons()}
        <div class="hr"></div>

        <div class="row">
          <input id="i_src" class="input" placeholder="Источник (зп)" />
          <input id="i_acc" class="input" placeholder="Счёт (карта)" />
        </div>
        <div class="hr"></div>

        <button class="btn" id="btn_inc">Записать доход</button>
      </div>
    `;

    q("btn_exp").onclick = () => send({
      v: 1,
      type: "expense",
      amount: q("e_amt").value,
      category: q("e_cat").value || "прочее",
      account: q("e_acc").value || "карта"
    });

    q("btn_inc").onclick = () => send({
      v: 1,
      type: "income",
      amount: q("i_amt").value,
      category: q("i_src").value || "доход",
      account: q("i_acc").value || "карта"
    });

    wireQuick("e_amt");
    wireQuick("i_amt");
    return;
  }

  if (tab === "save") {
    screen.innerHTML = `
      <div class="card">
        <div class="h">🏦 Сбережения</div>
        <div class="small">Откладывание — это перевод, а не расход</div>
        <div class="hr"></div>

        <input id="t_amt" class="input" placeholder="Сумма (например 20000)" inputmode="decimal" />
        ${quickButtons()}
        <div class="hr"></div>

        <div class="row">
          <input id="t_from" class="input" placeholder="Откуда (карта)" />
          <input id="t_to" class="input" placeholder="Куда (сбережения)" />
        </div>
        <div class="hr"></div>

        <button class="btn" id="btn_tr">Сделать перевод</button>
        <div class="hr"></div>
        <button class="btn ghost" id="btn_savemenu">Показать экран «Сбережения» в чате</button>
      </div>
    `;

    q("btn_tr").onclick = () => send({
      v: 1,
      type: "transfer",
      amount: q("t_amt").value,
      from: q("t_from").value || "карта",
      to: q("t_to").value || "сбережения"
    });

    q("btn_savemenu").onclick = () => send({ v: 1, type: "savings_request" });

    wireQuick("t_amt");
    return;
  }

  if (tab === "budget") {
    screen.innerHTML = `
      <div class="card">
        <div class="h">📅 Бюджет месяца</div>
        <div class="small">Добавь строку плана: категория + сумма + тип</div>
        <div class="hr"></div>

        <div class="row">
          <select id="p_type" class="input">
            <option value="expense">Расход</option>
            <option value="income">Доход</option>
          </select>
          <input id="p_cat" class="input" placeholder="Категория (продукты)" />
        </div>
        <div class="hr"></div>

        <input id="p_amt" class="input" placeholder="Сумма (например 14000)" inputmode="decimal" />
        ${quickButtons()}
        <div class="hr"></div>

        <button class="btn" id="btn_plan">Добавить в план</button>
        <div class="hr"></div>
        <button class="btn secondary" id="btn_plan_show">Показать бюджет в чате</button>
      </div>
    `;

    q("btn_plan").onclick = () => send({
      v: 1,
      type: "plan_add",
      plan_type: q("p_type").value,
      category: q("p_cat").value || "прочее",
      amount: q("p_amt").value
    });

    q("btn_plan_show").onclick = () => send({ v: 1, type: "plan_show" });

    wireQuick("p_amt");
    return;
  }

  if (tab === "hist") {
    screen.innerHTML = `
      <div class="card">
        <div class="h">🧾 История</div>
        <div class="small">MVP: история показывается в чате (быстрее и проще)</div>
        <div class="hr"></div>
        <button class="btn" id="btn_hist">Показать историю в чате</button>
      </div>
    `;
    q("btn_hist").onclick = () => send({ v: 1, type: "history_request" });
    return;
  }
}

setTab("ops");
