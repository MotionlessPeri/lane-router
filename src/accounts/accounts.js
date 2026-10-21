/* The page receives metadata only. Credentials and authorization URLs stay in the backend. */
(() => {
  const $ = id => document.getElementById(id);
  const names = { router: "Codex lane", company: "Company" };
  let selected = null, state = null, busy = false;
  const errors = {
    CONSUMER_OFFLINE: "有运行端离线。请启动对应运行端后重试。",
    AUTH_REQUIRED: "授权已失效。请选择该账号，点击重新授权。",
    QUEUED_WORK_PENDING: "Codex 中还有排队回合。已恢复运行，请待队列完成后重试。",
    ACTIVE_GOAL_PENDING: "Codex 中还有持续运行的目标。已恢复运行，请待目标结束后重试。",
    RUNTIME_UNAVAILABLE: "暂时无法确认运行端状态。请检查运行端后重试。",
    IDENTITY_MISMATCH: "账号或工作区与预期不一致，请重新授权正确的账号。",
    INVALID_IDENTITY: "无法核实授权身份，请重新授权。",
    SWITCH_BUSY: "已有切换正在进行。",
    SWITCH_ALREADY_APPLYING: "已开始应用账号，请等待结果。",
    LOGIN_BUSY: "授权正在进行，请先完成或取消。",
    LOGIN_FAILED: "授权未完成，请重新打开官方授权页面。",
    OPERATION_FAILED: "操作未完成，请检查状态后重试。",
    INVALID_CLAUDE_TOKEN: "这不是 claude setup-token 生成的 token（应以 sk-ant-oat 开头），请重新粘贴。",
    INVALID_CLAUDE_EMAIL: "请填写邮箱，用来在这里区分这个 Claude 账号。",
    USAGE_FAILED: "Claude 报了错，token 可能已失效：重跑 claude setup-token，删掉这个账号再添加。",
    USAGE_UNAVAILABLE: "Claude 这次的输出里没有余量信息（CLI 升级可能改了格式）。",
    USAGE_TIMEOUT: "读余量超时，请稍后再试。",
    CLAUDE_UNAVAILABLE: "后台找不到 claude 程序，可用环境变量 CLAUDE_EXE 指定。",
    INVALID_PROFILE: "这个账号已经不在了，请看刷新后的列表。",
    STORAGE_UNAVAILABLE: "后台无法写入它的受限数据目录。",
    ROUTER_UNAVAILABLE: "找不到正在运行的 Lane Router，请确认 Router 已经启动。",
    ROUTER_REFUSED: "Lane Router 没有接受这次请求，它可能还是旧版本，需要重启后再试。",
  };
  const describe = code => errors[code] || "操作未完成，请重试。";
  async function action(path, body = {}) {
    busy = true; render(); $("action-error").hidden = true;
    try {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Account-Action": "1" }, body: JSON.stringify(body) });
      const result = await response.json(); if (!response.ok) throw new Error(describe(result.error));
    } catch (error) { $("action-error").textContent = error instanceof Error ? error.message : "后台连接失败。"; $("action-error").hidden = false; }
    finally { busy = false; await poll(false); }
  }
  function render() {
    if (!state) return;
    const switching = ["validating", "waiting", "applying"].includes(state.operation?.phase);
    const logging = ["starting", "waiting"].includes(state.login.state);
    const profiles = state.profiles;
    if (!profiles.some(p => p.id === selected)) selected = state.desiredProfileId || profiles[0]?.id || null;
    $("profiles").replaceChildren();
    for (const profile of profiles) {
      const button = document.createElement("button"); button.className = "profile"; button.type = "button";
      button.setAttribute("role", "radio"); button.setAttribute("aria-checked", String(selected === profile.id));
      const title = document.createElement("strong"); title.textContent = profile.email;
      const detail = document.createElement("small"); detail.textContent = `${profile.plan} · 工作区 ${profile.workspace}`;
      button.append(title, detail);
      const using = state.consumers.filter(c => c.identity && c.profileId === profile.id && c.state !== "offline");
      if (using.length) {
        const current = document.createElement("small"); current.className = "current";
        current.textContent = using.map(c => names[c.id] || c.id).join("、") + " 正在使用";
        button.append(current);
      }
      button.disabled = switching || busy;
      button.onclick = () => { selected = profile.id; render(); }; $("profiles").append(button);
    }
    $("empty").hidden = profiles.length > 0;
    $("switch").disabled = busy || switching || logging || !selected;
    $("reauthorize").disabled = busy || switching || logging || !selected;
    $("add").disabled = busy || switching || logging;
    $("cancel").hidden = !state.operation?.cancellable || !["validating", "waiting"].includes(state.operation?.phase);
    $("cancel-login").hidden = !logging;
    $("consumers").replaceChildren();
    const labels = { offline: "未连接", connected: "已连接", waiting: "正在等待回合结束", applying: "正在切换", synced: "账号已核实", failed: "未完成" };
    for (const consumer of state.consumers) {
      const row = document.createElement("div"); row.className = "consumer"; row.dataset.state = consumer.state;
      const title = document.createElement("strong"); title.textContent = names[consumer.id] || consumer.id;
      const detail = document.createElement("p"); detail.textContent = labels[consumer.state] || consumer.state;
      const account = document.createElement("p");
      const profile = profiles.find(p => p.id === consumer.profileId);
      account.textContent = consumer.identity
        ? `当前账号：${profile?.email || consumer.identity.email} · 工作区 ${consumer.identity.workspace}`
        : consumer.state === "offline" ? "运行端未连接，无法读取当前账号。"
        : consumer.identityError ? "暂时无法读取当前账号。" : "正在读取当前账号…";
      row.append(title, detail, account);
      if (consumer.identityError) {
        const error = document.createElement("p"); error.className = "error";
        error.textContent = consumer.identityError === "AUTH_REQUIRED" ? "运行端未提供账号身份，请检查其登录状态。" : describe(consumer.identityError);
        row.append(error);
      }
      if (consumer.error) { const error = document.createElement("p"); error.className = "error"; error.textContent = describe(consumer.error); row.append(error); }
      $("consumers").append(row);
    }
    let title = "准备就绪", detail = "选择一个账号，点击同步切换。";
    if (logging) { title = "等待官方授权"; detail = "请在已打开的官方页面完成登录。授权完成后，回到这里选择账号切换。"; }
    else if (state.login.state === "failed") { title = "授权未完成"; detail = describe(state.login.error); }
    else if (state.operation) {
      const operation = state.operation;
      const texts = {
        validating: ["正在核实授权", "后台正在检查目标账号。"],
        waiting: ["等待现有回合结束", "新回合暂缓接纳，当前回合继续运行。" + (operation.cancellable ? "可以取消等待。" : "正在恢复账号一致性，请等待核实。")],
        applying: ["正在同步账号", "后台正在切换并核实两个运行端。"],
        complete: ["全部已同步", "Company 与 Codex lane 已核实为所选账号，原会话继续保留。"],
        cancelled: ["已取消等待", "本次没有应用目标账号。"],
        failed: ["切换尚未完成", describe(operation.error) + " 查看各运行端状态后，可再次点击同步切换。"],
      };
      [title, detail] = texts[operation.phase] || [title, detail];
      if (operation.phase === "complete" && state.consumers.some(c => c.state !== "synced")) { title = "同步状态已变化"; detail = "有运行端断开或重新连接，等待重新核实。"; }
    }
    $("status-title").textContent = title; $("status-detail").textContent = detail;
    renderClaude();
  }
  /* Claude accounts are shown for what they have left; switching is /login in a lane's window.
     Tokens go to the backend once, from the add form, and are never part of any state this page
     reads. A reading takes seconds and spends a little of that account, so each one is asked for
     by a click, refreshes run per account, and one running does not hold up the others. */
  async function claudeAction(path, body) {
    busy = true; render(); $("claude-error").hidden = true;
    try {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Account-Action": "1" }, body: JSON.stringify(body) });
      const result = await response.json(); if (!response.ok) throw new Error(describe(result.error));
      return true;
    } catch (error) { $("claude-error").textContent = error instanceof Error ? error.message : "后台连接失败。"; $("claude-error").hidden = false; return false; }
    finally { busy = false; await poll(false); }
  }
  const refreshing = new Set();
  async function refreshUsage(profileId) {
    if (refreshing.has(profileId)) return;
    refreshing.add(profileId); render(); $("claude-error").hidden = true;
    try {
      const response = await fetch("/api/claude/usage/refresh", { method: "POST", headers: { "Content-Type": "application/json", "X-Account-Action": "1" }, body: JSON.stringify({ profileId }) });
      const result = await response.json(); if (!response.ok) throw new Error(describe(result.error));
    } catch (error) { $("claude-error").textContent = error instanceof Error ? error.message : "后台连接失败。"; $("claude-error").hidden = false; }
    finally { refreshing.delete(profileId); await poll(false); }
  }
  const pad = value => String(value).padStart(2, "0");
  const day = value => { const date = new Date(value); return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`; };
  const moment = value => { const date = new Date(value); return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`; };
  const windowText = (label, reading) => reading ? `${label}：已用 ${Math.round(reading.utilization * 100)}% · ${moment(reading.resetsAt * 1000)} 重置` : `${label}：未读到`;
  const text = (tag, className, content) => { const node = document.createElement(tag); if (className) node.className = className; node.textContent = content; return node; };
  function renderClaude() {
    const claude = state.claude;
    $("claude").hidden = !claude;
    if (!claude) return;
    const rows = claude.profiles.map(profile => {
      const row = document.createElement("div"); row.className = "claude-profile"; row.dataset.claudeProfile = profile.id;
      const account = document.createElement("div"); account.className = "claude-account";
      account.append(text("strong", null, profile.email), text("small", null, `添加于 ${day(profile.createdAt)}`));
      const usage = document.createElement("div"); usage.className = "claude-usage";
      if (profile.usage) usage.append(text("span", null, windowText("5 小时", profile.usage.fiveHour)), text("span", null, windowText("7 天", profile.usage.sevenDay)), text("small", null, `检查于 ${moment(profile.usage.checkedAt)}`));
      else usage.append(text("span", "unread", "未查询"));
      if (profile.usageError) usage.append(text("p", "error", `最近一次刷新失败（${moment(profile.usageError.at)}）：${describe(profile.usageError.code)}`));
      const pending = refreshing.has(profile.id) || profile.refreshing;
      const refresh = text("button", null, pending ? "刷新中…" : "刷新"); refresh.type = "button"; refresh.disabled = pending || busy;
      refresh.dataset.claudeRefresh = profile.id;
      refresh.onclick = () => void refreshUsage(profile.id);
      const remove = text("button", null, "删除"); remove.type = "button"; remove.disabled = pending || busy;
      remove.dataset.claudeDelete = profile.id;
      remove.onclick = () => void claudeAction("/api/claude/profiles/delete", { profileId: profile.id });
      const actions = document.createElement("div"); actions.className = "claude-actions"; actions.append(refresh, remove);
      row.append(account, usage, actions);
      return row;
    });
    $("claude-profiles").replaceChildren(...rows);
    $("claude-empty").hidden = claude.profiles.length > 0;
    $("claude-add").disabled = busy; $("claude-submit").disabled = busy;
    $("claude-refresh-all").disabled = busy || claude.profiles.length === 0;
  }
  /* After switching an account by hand, a lane whose last turn stopped on quota sits idle until
     something wakes it. The Router mails every lane of the backend, and this says what became of
     each: woken, left in a closed lane's mailbox for when it opens, or skipped and why. */
  const backendNames = { claude: "Claude", codex: "Codex" };
  const skipReasons = { archived: "已归档", finished: "已完成", unbound: "没有对话", missing: "不存在", delivery_failed: "没能写进信箱" };
  function continueSummary(result) {
    const skipped = result.skipped || [];
    if (!result.notified.length && !result.queued.length && skipped.length && skipped.every(item => item.reason === "sent_within_60s")) return "60 秒内刚发过一轮，这次没有再发。";
    const parts = [];
    if (result.notified.length) parts.push(`已唤醒 ${result.notified.length} 条：${result.notified.join("、")}`);
    if (result.queued.length) parts.push(`${result.queued.length} 条没开着，信已留在它的信箱，打开时处理：${result.queued.join("、")}`);
    if (skipped.length) parts.push(`跳过 ${skipped.length} 条：${skipped.map(item => `${item.address}（${skipReasons[item.reason] || item.reason}）`).join("、")}`);
    return parts.length ? parts.join("；") + "。" : `没有在用的 ${backendNames[result.backend] || result.backend} lane。`;
  }
  async function continueLanes(backend) {
    const button = $(`${backend}-continue`), shown = $(`${backend}-continue-result`);
    button.disabled = true; shown.hidden = true; shown.classList.remove("error");
    try {
      const response = await fetch("/api/lanes/continue-after-switch", { method: "POST", headers: { "Content-Type": "application/json", "X-Account-Action": "1" }, body: JSON.stringify({ backend }) });
      const answer = await response.json(); if (!response.ok) throw new Error(describe(answer.error));
      shown.textContent = continueSummary(answer.result);
    } catch (error) { shown.textContent = error instanceof Error ? error.message : "后台连接失败。"; shown.classList.add("error"); }
    finally { shown.hidden = false; button.disabled = false; }
  }
  async function poll(repeat = true) {
    try { const response = await fetch("/api/state"); if (!response.ok) throw new Error(); state = await response.json(); $("connection").textContent = "本机后台已连接"; render(); }
    catch {
      state = null;
      $("connection").textContent = "后台未连接";
      $("status-title").textContent = "同步状态待核实";
      $("status-detail").textContent = "无法读取后台状态。恢复连接后会重新核实两个运行端。";
      $("consumers").replaceChildren();
      for (const current of document.querySelectorAll("#profiles .current")) current.remove();
      const note = document.createElement("p"); note.textContent = "Company 与 Codex lane 的当前账号尚未核实。"; $("consumers").append(note);
      $("switch").disabled = true; $("add").disabled = true; $("reauthorize").disabled = true;
      $("cancel").hidden = true; $("cancel-login").hidden = true;
      $("claude-add").disabled = true; $("claude-submit").disabled = true; $("claude-refresh-all").disabled = true;
      for (const control of document.querySelectorAll("#claude-profiles button")) control.disabled = true;
    }
    if (repeat) setTimeout(() => void poll(), 1000);
  }
  $("add").onclick = () => void action("/api/login");
  $("reauthorize").onclick = () => void action("/api/login", { profileId: selected });
  $("switch").onclick = () => void action("/api/switch", { profileId: selected });
  $("cancel").onclick = () => void action("/api/switch/cancel");
  $("cancel-login").onclick = () => void action("/api/login/cancel");
  $("claude-continue").onclick = () => void continueLanes("claude");
  $("codex-continue").onclick = () => void continueLanes("codex");
  $("claude-add").onclick = () => { $("claude-form").hidden = false; $("claude-email").focus(); };
  $("claude-refresh-all").onclick = () => { for (const profile of state?.claude?.profiles ?? []) void refreshUsage(profile.id); };
  $("claude-form-cancel").onclick = () => { $("claude-email").value = ""; $("claude-token").value = ""; $("claude-form").hidden = true; };
  $("claude-submit").onclick = async () => {
    const email = $("claude-email").value, token = $("claude-token").value;
    // Out of the page before the request leaves it, whatever the backend answers.
    $("claude-token").value = "";
    if (await claudeAction("/api/claude/profiles", { email, token })) { $("claude-email").value = ""; $("claude-form").hidden = true; }
  };
  void poll();
})();
