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
    }
    if (repeat) setTimeout(() => void poll(), 1000);
  }
  $("add").onclick = () => void action("/api/login");
  $("reauthorize").onclick = () => void action("/api/login", { profileId: selected });
  $("switch").onclick = () => void action("/api/switch", { profileId: selected });
  $("cancel").onclick = () => void action("/api/switch/cancel");
  $("cancel-login").onclick = () => void action("/api/login/cancel");
  void poll();
})();
