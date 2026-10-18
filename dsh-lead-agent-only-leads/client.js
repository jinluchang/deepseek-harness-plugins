/**
 * Client half of @local/dsh-lead-agent-only-leads: one settings PAGE that toggles which
 * tools a non-blocking Lead may use.
 *
 * Plain browser bundle (no build step): it self-registers with the page's
 * module loader and requests React, the only module-table entry it needs.
 * State lives in the Host's `configForms` namespace for the `lead-agent-only-leads`
 * profile row; each toggle is one dictionary-key write
 * (`{ op: 'set', path: ['tools', <name>], value: <bool> }`), the shipped
 * tested dict-edit path. The page only registers while the Host serves that
 * namespace (`configForms.whileServed`), so a composition without the plugin
 * shows no trace of it.
 *
 * `LEAD_TOOL_CATALOG` mirrors the host half (`dsh-lead-agent-only-leads/index.js`)
 * one-to-one — same names, same order, same `{ name, klass, def }` — and is
 * exposed on the object this factory returns so the bundle's offline suite can
 * deep-compare the two catalogs.
 *
 * @module @local/dsh-lead-agent-only-leads/client
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-lead-agent-only-leads',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useState } = React;

    /** Settings namespace: the Host profile row id that carries the `tools` map. */
    const HOST_NS = 'lead-agent-only-leads';
    /** Locale dictionary namespace. */
    const NS = 'lead-agent-only-leads';
    /** Settings section key (drives the shell's `only` filtering). */
    const SECTION_ID = 'lead-agent-only-leads-tools';
    /** Nav position: after Models (20), keeping the deployment-shaping pages together. */
    const SECTION_ORDER = 30;

    /**
     * The complete Lead tool universe, grouped by the mechanism a toggle uses.
     *
     * - `whitelist`: the allow list keeps it (`true`) or hides it (`false`).
     * - `guard`: own-scope tools a restriction cannot reach; a guard refuses
     *   them when `false`, so `true` means "not denied".
     * - `none`: not toggleable here (user commands, unmounted rows, child-only
     *   tools); `def` is fixed `false` by convention.
     */
    const LEAD_TOOL_CATALOG = [
      // ── whitelist: what the preset mounts (and reachable profile tools) ──
      { name: 'read', klass: 'whitelist', def: false },
      { name: 'read_image', klass: 'whitelist', def: false },
      { name: 'glob', klass: 'whitelist', def: false },
      { name: 'grep', klass: 'whitelist', def: false },
      { name: 'ask_user_question', klass: 'whitelist', def: true },
      { name: 'todo_write', klass: 'whitelist', def: true },
      { name: 'bash', klass: 'whitelist', def: false },
      { name: 'pwsh', klass: 'whitelist', def: false },
      { name: 'write', klass: 'whitelist', def: false },
      { name: 'edit', klass: 'whitelist', def: false },
      { name: 'job_output', klass: 'whitelist', def: false },
      { name: 'job_list', klass: 'whitelist', def: false },
      { name: 'job_kill', klass: 'whitelist', def: false },
      { name: 'schedule_create', klass: 'whitelist', def: false },
      { name: 'schedule_list', klass: 'whitelist', def: false },
      { name: 'schedule_delete', klass: 'whitelist', def: false },
      { name: 'schedule_update', klass: 'whitelist', def: false },
      { name: 'skill', klass: 'whitelist', def: false },
      { name: 'get_goal', klass: 'whitelist', def: false },
      { name: 'create_goal', klass: 'whitelist', def: false },
      { name: 'update_goal', klass: 'whitelist', def: false },
      { name: 'exit_plan_mode', klass: 'whitelist', def: true },
      { name: 'subagent_fork', klass: 'whitelist', def: false },
      { name: 'workflow', klass: 'whitelist', def: false },
      { name: 'web_search', klass: 'whitelist', def: false },
      { name: 'web_fetch', klass: 'whitelist', def: false },
      { name: 'present', klass: 'whitelist', def: true },
      { name: 'session_search', klass: 'whitelist', def: false },
      { name: 'session_event_search', klass: 'whitelist', def: false },
      { name: 'session_event_read', klass: 'whitelist', def: false },
      { name: 'session_event_trace', klass: 'whitelist', def: false },
      { name: 'session_trace', klass: 'whitelist', def: false },
      { name: 'ralph', klass: 'whitelist', def: false },
      { name: 'create_worktree', klass: 'whitelist', def: false },
      // ── guard: own-scope tools (Agent Teams + delegation) ──
      { name: 'spawn_teammate', klass: 'guard', def: true },
      { name: 'send_message', klass: 'guard', def: true },
      { name: 'list_agents', klass: 'guard', def: true },
      { name: 'interrupt_agent', klass: 'guard', def: true },
      { name: 'team_task_create', klass: 'guard', def: true },
      { name: 'team_task_list', klass: 'guard', def: true },
      { name: 'team_task_get', klass: 'guard', def: true },
      { name: 'team_task_update', klass: 'guard', def: true },
      { name: 'wait_agent', klass: 'guard', def: false },
      { name: 'subagent', klass: 'guard', def: false },
      { name: 'list_subagent_models', klass: 'guard', def: false },
      // ── none: outside either mechanism ──
      { name: '/goal', klass: 'none', def: false },
      { name: '/plan', klass: 'none', def: false },
      { name: '/compact', klass: 'none', def: false },
      { name: 'plugin_manager', klass: 'none', def: false },
      { name: 'plugin_market', klass: 'none', def: false },
      { name: 'structured_output', klass: 'none', def: false },
    ];

    /** Why a `none` row cannot be toggled, as a dictionary key suffix. */
    const NONE_REASON = {
      '/goal': 'command',
      '/plan': 'command',
      '/compact': 'command',
      plugin_manager: 'unmounted',
      plugin_market: 'unmounted',
      structured_output: 'child',
    };

    /** Group order and headings. */
    const GROUPS = ['whitelist', 'guard', 'none'];

    const en = {
      'nav': 'Lead agent only leads',
      'title': 'Lead agent only leads',
      'intro': 'Choose which tools a Team Lead may use under the Lead agent only leads preset. The rest of the Team always keeps the standard surface.',
      'applyNote': 'Changes apply to Leads created after the change. A running Lead keeps the tools it already has until its next session.',
      'contract.title': 'Lead contract prompt for the current selection',
      'contract.note': 'Preview only. This is the prompt a Lead of this preset receives. It is derived from this page\'s catalog and toggles, so it cannot know which of these tools the running profile actually mounts.',
      'overridden': 'This profile sets leadTools or denyTools explicitly, which overrides every toggle on this page. Remove those keys to use the toggles.',
      'unavailable': 'The Lead plugin is not serving its settings in this profile.',
      'loading': 'Loading settings…',
      'error': 'The change was not saved. Try again.',
      'notToggleable': 'Not toggleable',
      'default.on': 'Default: on',
      'default.off': 'Default: off',
      'group.whitelist': 'Kept from the preset',
      'group.whitelist.note': 'The keep list is an allow list: a tool that is not on is hidden from the Lead entirely.',
      'group.guard': 'Team tools (own scope)',
      'group.guard.note': 'These tools live in the Lead\'s own scope, where the allow list cannot reach. Turning one off refuses it with a guard instead of hiding it.',
      'group.none': 'Outside this page',
      'group.none.note': 'Listed so the page is honest about what it cannot change.',
      'none.command': 'A user command, not a tool — this page cannot change it, and the user can still type it.',
      'none.unmounted': 'Not mounted in this profile (its row is disabled), so there is nothing to toggle.',
      'none.child': 'Only exists inside a delegated child that asked for structured output; a Lead never has it.',
      'tool.read.desc': 'Reads a file from the workspace. Hidden by default: teammates read, and the Lead briefs instead of inspecting.',
      'tool.read_image.desc': 'Reads an image into the conversation. Hidden by default: ask a teammate what an image shows.',
      'tool.glob.desc': 'Finds files by path pattern. Hidden by default: teammates locate the code.',
      'tool.grep.desc': 'Searches file contents. Hidden by default: teammates search the workspace.',
      'tool.ask_user_question.desc': 'Asks the user a question when the decision is theirs. Kept.',
      'tool.todo_write.desc': 'Tracks a short todo list in the session. Kept.',
      'tool.bash.desc': 'Runs shell commands. Turning this on lets the Lead start long jobs and block on them — the mode exists to keep the Lead answering instead.',
      'tool.pwsh.desc': 'Runs PowerShell commands (Windows only). Turning this on re-introduces blocking shell work.',
      'tool.write.desc': 'Writes files. Turning this on makes the Lead do the writing instead of briefing a teammate.',
      'tool.edit.desc': 'Edits files. Turning this on makes the Lead do the writing instead of briefing a teammate.',
      'tool.job_output.desc': 'Reads output from a background job. Only useful with the shell tools on.',
      'tool.job_list.desc': 'Lists background jobs. Only useful with the shell tools on.',
      'tool.job_kill.desc': 'Stops a background job. Only useful with the shell tools on.',
      'tool.schedule_create.desc': 'Schedules a message for later.',
      'tool.schedule_list.desc': 'Lists scheduled messages.',
      'tool.schedule_delete.desc': 'Deletes a scheduled message.',
      'tool.schedule_update.desc': 'Updates a scheduled message.',
      'tool.skill.desc': 'Loads a skill\'s full instructions.',
      'tool.get_goal.desc': 'Reads the session goal.',
      'tool.create_goal.desc': 'Creates a goal that keeps the session working across turns. Can keep a Lead busy instead of answering.',
      'tool.update_goal.desc': 'Updates the session goal.',
      'tool.exit_plan_mode.desc': 'Presents a plan for approval and leaves plan mode. Kept: a Lead may plan while execution stays delegated.',
      'tool.subagent_fork.desc': 'Delegates to a one-shot subagent that inherits this conversation. The Lead cannot steer it afterwards; prefer spawn_teammate.',
      'tool.workflow.desc': 'Runs a multi-agent workflow script. Long orchestration the Lead would have to wait on.',
      'tool.web_search.desc': 'Searches the web.',
      'tool.web_fetch.desc': 'Fetches a web page.',
      'tool.present.desc': 'Shows a file or image card in the conversation. Kept: the Lead can present the finished work.',
      'tool.session_search.desc': 'Searches past sessions.',
      'tool.session_event_search.desc': 'Searches events in past sessions.',
      'tool.session_event_read.desc': 'Reads one past session event.',
      'tool.session_event_trace.desc': 'Traces replacements of one past session event.',
      'tool.session_trace.desc': 'Traces session lineage.',
      'tool.ralph.desc': 'Runs fresh-agent rounds until an objective completes. Long-running; the Lead would have to wait.',
      'tool.create_worktree.desc': 'Creates a git worktree and switches the session directory.',
      'tool.spawn_teammate.desc': 'Creates a named teammate. Turning this off leaves the Lead unable to delegate — its whole job.',
      'tool.send_message.desc': 'Messages a teammate, or wakes an inactive one. Turning this off strands the Team.',
      'tool.list_agents.desc': 'Lists the Team and each member\'s status. Turning this off blinds the Lead to who is running.',
      'tool.interrupt_agent.desc': 'Interrupts a teammate\'s current turn. Turning this off removes the Lead\'s stop control.',
      'tool.team_task_create.desc': 'Creates a shared task on the Team board.',
      'tool.team_task_list.desc': 'Lists shared tasks with readiness and owners.',
      'tool.team_task_get.desc': 'Reads one shared task.',
      'tool.team_task_update.desc': 'Claims, edits, completes, or deletes a shared task.',
      'tool.wait_agent.desc': 'Waits for a teammate status change. Refused by default: a non-blocking Lead ends its turn instead.',
      'tool.subagent.desc': 'Delegates to a one-shot subagent the Lead can neither steer nor re-contact. Refused by default; use spawn_teammate.',
      'tool.list_subagent_models.desc': 'Lists routes for the refused one-shot delegation tool. Refused by default.',
      'cmd.goal.desc': 'The /goal command creates and manages the session goal.',
      'cmd.plan.desc': 'The /plan command enters or leaves plan mode.',
      'cmd.compact.desc': 'The /compact command compacts the conversation.',
      'tool.plugin_manager.desc': 'Installs and manages plugins.',
      'tool.plugin_market.desc': 'Browses and installs plugins from configured markets.',
      'tool.structured_output.desc': 'Reports a structured result from a delegated child.',
    };

    const zh = {
      'nav': 'Lead 只负责带领',
      'title': 'Lead 只负责带领',
      'intro': '选择「Lead 只负责带领」预设下 Team Lead 可以使用的工具。Team 其他成员始终保持标准工具面。',
      'applyNote': '更改仅对之后创建的 Lead 生效。正在运行的 Lead 会保留已有工具，直到下一次会话。',
      'contract.title': '当前选择对应的 Lead 契约提示词',
      'contract.note': '仅为预览。这是该预设下的 Lead 实际收到的提示词；它由本页的目录与开关推导，无法得知运行中的 Profile 实际挂载了哪些工具。',
      'overridden': '该 Profile 显式设置了 leadTools 或 denyTools，会整体覆盖本页的所有开关。移除这些键后开关才会生效。',
      'unavailable': '该 Profile 中 Lead 插件未提供设置。',
      'loading': '正在加载设置…',
      'error': '保存失败，请重试。',
      'notToggleable': '不可切换',
      'default.on': '默认：开启',
      'default.off': '默认：关闭',
      'group.whitelist': '从预设保留的工具',
      'group.whitelist.note': '保留列表是白名单：未开启的工具会完全对 Lead 隐藏。',
      'group.guard': 'Team 工具（自有作用域）',
      'group.guard.note': '这些工具注册在 Lead 自己的作用域中，白名单无法触及。关闭时会由 guard 拒绝调用，而不是隐藏。',
      'group.none': '本页无法控制',
      'group.none.note': '列出这些项目，是为了如实说明本页无法改变的内容。',
      'none.command': '这是用户命令而非工具，本页无法改变；用户仍然可以输入它。',
      'none.unmounted': '该 Profile 未挂载它（对应行已禁用），因此没有可切换的内容。',
      'none.child': '只存在于请求结构化输出的被委派子代理中，Lead 永远不会拥有它。',
      'tool.read.desc': '读取工作区中的文件。默认关闭：由队友阅读，Lead 负责下达任务。',
      'tool.read_image.desc': '将图片读入对话。默认关闭：需要了解图片内容时请交给队友。',
      'tool.glob.desc': '按路径模式查找文件。默认关闭：由队友定位代码。',
      'tool.grep.desc': '搜索文件内容。默认关闭：由队友检索工作区。',
      'tool.ask_user_question.desc': '在需要用户决策时提问。予以保留。',
      'tool.todo_write.desc': '在会话中维护一份简短的待办列表。予以保留。',
      'tool.bash.desc': '运行 shell 命令。开启后 Lead 可以启动长任务并阻塞等待——该模式存在的意义正是让 Lead 保持可应答。',
      'tool.pwsh.desc': '运行 PowerShell 命令（仅 Windows）。开启后会重新引入阻塞式 shell 工作。',
      'tool.write.desc': '写入文件。开启后由 Lead 自己写作，而不是交给队友。',
      'tool.edit.desc': '编辑文件。开启后由 Lead 自己修改，而不是交给队友。',
      'tool.job_output.desc': '读取后台任务的输出。仅在开启 shell 工具后有用。',
      'tool.job_list.desc': '列出后台任务。仅在开启 shell 工具后有用。',
      'tool.job_kill.desc': '停止后台任务。仅在开启 shell 工具后有用。',
      'tool.schedule_create.desc': '安排一条稍后发送的消息。',
      'tool.schedule_list.desc': '列出已安排的消息。',
      'tool.schedule_delete.desc': '删除已安排的消息。',
      'tool.schedule_update.desc': '更新已安排的消息。',
      'tool.skill.desc': '加载某个技能的完整说明。',
      'tool.get_goal.desc': '读取当前会话目标。',
      'tool.create_goal.desc': '创建一个跨轮次持续推进的目标。可能让 Lead 忙于推进而不是回答。',
      'tool.update_goal.desc': '更新当前会话目标。',
      'tool.exit_plan_mode.desc': '提交计划以供批准并退出计划模式。默认开启：Lead 可以规划，执行仍由队友完成。',
      'tool.subagent_fork.desc': '委派给一个继承本对话的一次性子代理。之后 Lead 无法再指导它；优先使用 spawn_teammate。',
      'tool.workflow.desc': '运行多代理工作流脚本。属于 Lead 必须等待的长时编排。',
      'tool.web_search.desc': '搜索网页。',
      'tool.web_fetch.desc': '抓取网页内容。',
      'tool.present.desc': '在对话中展示文件或图片卡片。默认开启：Lead 可以展示最终成果。',
      'tool.session_search.desc': '搜索历史会话。',
      'tool.session_event_search.desc': '搜索历史会话中的事件。',
      'tool.session_event_read.desc': '读取某一条历史会话事件。',
      'tool.session_event_trace.desc': '追踪某条历史会话事件的替换链。',
      'tool.session_trace.desc': '追踪会话的继承关系。',
      'tool.ralph.desc': '循环启动全新代理轮次直到目标完成。耗时较长，Lead 必须等待。',
      'tool.create_worktree.desc': '创建 git worktree 并切换会话目录。',
      'tool.spawn_teammate.desc': '创建一个具名队友。关闭后 Lead 将无法委派——而这正是它的全部职责。',
      'tool.send_message.desc': '给队友发消息，或唤醒空闲队友。关闭后 Team 会失去联络。',
      'tool.list_agents.desc': '列出 Team 成员及其状态。关闭后 Lead 无法得知谁在运行。',
      'tool.interrupt_agent.desc': '中断队友当前轮次。关闭后 Lead 失去中止手段。',
      'tool.team_task_create.desc': '在共享任务板上创建任务。',
      'tool.team_task_list.desc': '列出共享任务及其就绪状态与负责人。',
      'tool.team_task_get.desc': '读取某一条共享任务。',
      'tool.team_task_update.desc': '认领、编辑、完成或删除共享任务。',
      'tool.wait_agent.desc': '等待队友状态变化。默认被拒绝：非阻塞 Lead 应结束本轮而不是等待。',
      'tool.subagent.desc': '委派给一个 Lead 既不能指导也无法再联系的一次性子代理。默认被拒绝；请使用 spawn_teammate。',
      'tool.list_subagent_models.desc': '列出已拒绝的一次性委派工具可用路由。默认被拒绝。',
      'cmd.goal.desc': '/goal 命令用于创建和管理会话目标。',
      'cmd.plan.desc': '/plan 命令用于进入或退出计划模式。',
      'cmd.compact.desc': '/compact 命令用于压缩对话。',
      'tool.plugin_manager.desc': '安装和管理插件。',
      'tool.plugin_market.desc': '浏览并安装来自已配置市场的插件。',
      'tool.structured_output.desc': '由被委派的子代理上报结构化结果。',
    };

    /** One stylesheet string; class names are namespaced and colors use host theme tokens. */
    const STYLE_TEXT = [
      '.dll-page { display: flex; flex-direction: column; gap: 16px; padding: 4px 0 24px; }',
      '.dll-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 16px; line-height: 24px; font-weight: 500; }',
      '.dll-intro { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.dll-note { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.dll-notice { box-sizing: border-box; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
      '.dll-quote { box-sizing: border-box; margin: 0; padding: 10px 12px; border: 0.5px solid var(--dsw-alias-border-l2); border-left: 3px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-module-platform); }',
      '.dll-quote-title { margin: 0 0 6px; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 20px; font-weight: 500; }',
      '.dll-quote-body { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
      '.dll-quote-note { margin: 6px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.dll-alert { margin: 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; line-height: 18px; }',
      '.dll-group { display: flex; flex-direction: column; }',
      '.dll-group-title { margin: 0; color: var(--dsw-alias-label-primary); font-size: 14px; line-height: 22px; font-weight: 500; }',
      '.dll-group-note { margin: 2px 0 4px; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.dll-row { box-sizing: border-box; display: flex; align-items: center; justify-content: space-between; gap: 16px; min-height: 60px; padding: 14px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2); }',
      '.dll-row-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }',
      '.dll-row-name { color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; line-height: 20px; }',
      '.dll-row-desc { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 18px; }',
      '.dll-row-default { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.dll-row-none { margin: 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; }',
      '.dll-row-action { flex: none; display: flex; align-items: center; gap: 8px; }',
      '.dll-badge { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border: 0.5px solid var(--dsw-alias-border-l3); border-radius: var(--dsw-radius-sm); color: var(--dsw-alias-label-tertiary); font-size: 11px; line-height: 16px; }',
      '.dll-switch { position: relative; display: inline-flex; width: 36px; height: 20px; cursor: pointer; }',
      '.dll-switch input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer; }',
      '.dll-switch input:disabled { cursor: not-allowed; }',
      '.dll-track { box-sizing: border-box; width: 36px; height: 20px; border-radius: 10px; background: var(--dsw-alias-interactive-bg-hover); transition: background 120ms ease; }',
      '.dll-track::after { content: ""; display: block; width: 16px; height: 16px; margin: 2px; border-radius: 50%; background: var(--dsw-alias-label-primary-foreground); box-shadow: var(--dsw-elevation-prominent); transition: transform 120ms ease; }',
      '.dll-switch input:checked + .dll-track { background: var(--dsw-alias-button-primary-fill); }',
      '.dll-switch input:checked + .dll-track::after { transform: translateX(16px); }',
      '.dll-switch input:focus-visible + .dll-track { outline: 2px solid var(--dsw-alias-border-l3); outline-offset: 2px; }',
      '.dll-switch input:disabled + .dll-track { opacity: 0.4; }',
    ].join('\n');

    /**
     * Dictionary key for one row's description.
     * @param name - catalog tool name; slash commands use a `cmd.` key.
     * @returns the flat dictionary key.
     */
    function descKey(name) {
      return name.startsWith('/') ? `cmd.${name.slice(1)}.desc` : `tool.${name}.desc`;
    }

    /**
     * The catalog-derived defaults, mirroring the host's `catalogDefaults()` and
     * its `DEFAULT_LEAD_TOOLS`/`DEFAULT_DENIED_TOOLS` constants (which mirror the
     * same filters). Deriving them here keeps the two halves from drifting: the
     * catalogs are deep-compared, so these lists are equal by construction.
     */
    const DEFAULT_LEAD_TOOLS = Object.freeze(
      LEAD_TOOL_CATALOG.filter(entry => entry.klass === 'whitelist' && entry.def).map(entry => entry.name));
    const DEFAULT_DENIED_TOOLS = Object.freeze(
      LEAD_TOOL_CATALOG.filter(entry => entry.klass === 'guard' && !entry.def).map(entry => entry.name));

    /**
     * Normalize a configured or defaulted name list, mirroring the host's
     * `nameList()`: unique, non-empty names in first-seen order.
     * @param value - the configured value, honoured only when it is an array.
     * @param fallback - names used when `value` is absent.
     * @returns the normalized names.
     */
    function nameList(value, fallback) {
      const source = Array.isArray(value) ? value : fallback;
      return [...new Set(source.filter(entry => typeof entry === 'string' && entry.length > 0))];
    }

    /**
     * Unwrap a possibly-volatile field, mirroring the host's `volatileValue()`.
     * @param value - the raw or wrapped config field.
     * @returns the underlying value, or `undefined` when absent.
     */
    function plainValue(value) {
      if (value === undefined || value === null) return undefined;
      return typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
    }

    /**
     * Resolve a row config into its effective keep and deny lists, mirroring the
     * host's `resolveToolPolicy()`: a `whitelist` tool is kept iff
     * `tools[name] ?? def` and a `guard` tool is denied iff that is OFF, while an
     * explicitly configured legacy `leadTools`/`denyTools` array wins wholesale
     * for its own list.
     * @param config - a `{ tools, leadTools, denyTools }` row config.
     * @returns `{ keep, deny, keepConfigured, denyConfigured }`.
     */
    function resolvePreviewPolicy(config = {}) {
      const tools = plainValue(config.tools) ?? {};
      const legacyKeep = plainValue(config.leadTools);
      const legacyDeny = plainValue(config.denyTools);
      const keepConfigured = Array.isArray(legacyKeep);
      const denyConfigured = Array.isArray(legacyDeny);
      const on = entry => tools[entry.name] ?? entry.def;
      const catalogKeep = LEAD_TOOL_CATALOG
        .filter(entry => entry.klass === 'whitelist' && on(entry))
        .map(entry => entry.name);
      const catalogDeny = LEAD_TOOL_CATALOG
        .filter(entry => entry.klass === 'guard' && !on(entry))
        .map(entry => entry.name);
      return {
        keep: keepConfigured ? nameList(legacyKeep, DEFAULT_LEAD_TOOLS) : catalogKeep,
        deny: denyConfigured ? nameList(legacyDeny, DEFAULT_DENIED_TOOLS) : catalogDeny,
        keepConfigured,
        denyConfigured,
      };
    }

    /**
     * Join already-formatted names the way the contract reads them, mirroring the
     * host's `joinQuoted()`: `A`, `A and B`, or `A, B, and C`.
     * @param names - the formatted names, in display order.
     * @returns the joined list, or `''` for no names.
     */
    function joinQuoted(names) {
      if (names.length === 0) return '';
      if (names.length === 1) return names[0];
      if (names.length === 2) return `${names[0]} and ${names[1]}`;
      return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
    }

    /**
     * The Lead contract prompt for one resolved policy, mirroring the host's
     * `leadContract()` line for line — same refusal clause, same 0/1/many grammar,
     * same resolved-tools sentence, same fixed template, same defaults. The two
     * halves share no module and the plugin has no build step, so they are kept in
     * sync by hand and `verify.mjs` compares them byte for byte.
     * @param options - the resolved policy: `deny`, `tools`, and the three hides.
     * @returns the contract text.
     */
    function contractPreview(options = {}) {
      // An unknown fact (a non-array `deny`) falls back to the catalog defaults
      // rather than guessing, which is also the pre-options text.
      const deny = Array.isArray(options?.deny)
        ? [...new Set(options.deny.filter(entry => typeof entry === 'string' && entry.length > 0))]
        : DEFAULT_DENIED_TOOLS
      // The resolved allow list named as the Lead's own tools. An absent or
      // unreadable one falls back to the catalog ON list, the same conservative
      // stance the boolean flags take.
      const tools = Array.isArray(options?.tools)
        ? [...new Set(options.tools.filter(entry => typeof entry === 'string' && entry.length > 0))]
        : DEFAULT_LEAD_TOOLS
      // Only an explicit `false` drops a claim: an unknown flag keeps today's text.
      const shellHidden = options?.shellHidden !== false
      const writersHidden = options?.writersHidden !== false
      const readersHidden = options?.readersHidden !== false

      const quoted = deny.map(entry => `\`${entry}\``)
      const refused = quoted.length === 0 ? '' : `${joinQuoted(quoted)} ${quoted.length === 1 ? 'is' : 'are'} refused`
      const followOn = [
        deny.includes('wait_agent') ? 'waiting' : undefined,
        deny.includes('subagent') ? 'one-shot delegation' : undefined,
      ].filter(Boolean)
      const refusal = refused === '' || followOn.length === 0
        ? refused
        : `${refused} — do not count on ${followOn.join(' or on ')}`

      const claims = []
      if (shellHidden) claims.push('You cannot run shell commands')
      if (writersHidden) claims.push('you cannot write or edit files')
      if (readersHidden) claims.push('you cannot read files, search the workspace, or view images')
      if (refusal !== '') claims.push(refusal)
      const joined = claims.length <= 1
        ? claims.join('')
        : `${claims.slice(0, -1).join(', ')}${claims.length > 2 ? ',' : ''} and ${claims[claims.length - 1]}`
      const restriction = joined === '' ? '' : ` ${joined[0].toUpperCase()}${joined.slice(1)}.`

      // Name the Lead's actual tools, derived from the resolved allow list, so the
      // text cannot go stale when the catalog changes. An empty list must not leave
      // a dangling "are , plus".
      const toolList = joinQuoted(tools.map(entry => `\`${entry}\``))
      const ownTools = toolList === ''
        ? "You keep none of the preset's tools, plus the Team tools; everything else the preset mounts is off your list."
        : `Your own tools are ${toolList}, plus the Team tools; everything else the preset mounts is off your list.`

      return `Non-blocking Lead

You are a non-blocking Team Lead.${restriction} ${ownTools} This supersedes the Agent Teams instruction to wait for teammates before answering.

Hand every part of the job out, and answer the user as soon as it is out.
- Give each teammate a brief that states the goal, the exact files it may write, and how it must verify the result. To know those files or checks, you may create a reconnaissance task: deploy one teammate on a read-only task — recorded on the shared board like any other task — that states the question and asks for the facts (where the code lives, which files a change touches, how the result should be verified). End your turn; the report arrives as your next turn, and you split and brief the real work from it.
- Record ownership and dependencies on the shared task board (team_task_*), and use list_agents to see who is running.
- Use send_message to steer a teammate or to wake an inactive one; a teammate report arrives as a new turn, and the next user message can arrive at any time.
- Teammates do the reading, searching, and writing; you brief and coordinate. Use ask_user_question when the decision is the user's to make.
- Assemble the final answer from teammate reports. When a report you need is missing, send_message that teammate and end your turn.`
    }

    /**
     * The contract text a selection produces: resolve the keep and deny lists from
     * the row config, then derive the three hide flags from the keep list the way
     * the host derives them from its live `reachable` scope. The client cannot read
     * that scope, so a keep name the profile does not mount still counts here.
     * @param config - a `{ tools, leadTools, denyTools }` row config.
     * @returns the contract text the current selection produces.
     */
    function contractPreviewFor(config = {}) {
      const policy = resolvePreviewPolicy(config);
      const keep = policy.keep;
      return contractPreview({
        deny: policy.deny,
        shellHidden: !keep.includes('bash') && !keep.includes('pwsh'),
        writersHidden: !keep.includes('write') && !keep.includes('edit'),
        readersHidden: !keep.includes('read') && !keep.includes('read_image')
          && !keep.includes('glob') && !keep.includes('grep'),
        tools: keep,
      });
    }

    /**
     * Track one configForms namespace as a hook-friendly observable.
     * @param form - `ctx.configForms.get(ns)` controller.
     * @returns `{ getSnapshot, subscribe, dispose }` for the slot `hooks` compartment.
     */
    function createFormStore(form) {
      let snapshot = form.getSnapshot();
      const listeners = new Set();
      const unsubscribe = form.subscribe(() => {
        snapshot = form.getSnapshot();
        for (const listener of [...listeners]) listener();
      });
      return {
        getSnapshot: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        dispose() {
          unsubscribe();
          listeners.clear();
        },
      };
    }

    /**
     * One toggle row. A togglable row renders its default text immediately after
     * the description, plus a switch; a `none` row renders neither — that label
     * was inert for a row no toggle can affect — and instead shows the reason and
     * a `Not toggleable` badge where the switch would be.
     * @param props - row entry, live value, disabled state, and writers.
     * @returns the row element.
     */
    function ToolRow({ entry, enabled, disabled, pending, onToggle, t }) {
      const reason = entry.klass === 'none' ? NONE_REASON[entry.name] : undefined;
      return h('div', { className: 'dll-row' },
        h('div', { className: 'dll-row-text' },
          h('div', { className: 'dll-row-name' }, entry.name),
          h('p', { className: 'dll-row-desc' }, t(descKey(entry.name))),
          entry.klass === 'none'
            ? null
            : h('p', { className: 'dll-row-default' }, t(entry.def ? 'default.on' : 'default.off')),
          reason === undefined
            ? null
            : h('p', { className: 'dll-row-none' }, t(`none.${reason}`)),
        ),
        h('div', { className: 'dll-row-action' },
          entry.klass === 'none'
            ? h('span', { className: 'dll-badge' }, t('notToggleable'))
            : h('label', { className: 'dll-switch' },
              h('input', {
                type: 'checkbox',
                role: 'switch',
                checked: enabled,
                disabled: disabled || pending,
                'aria-label': entry.name,
                onChange: event => { onToggle(entry.name, event.target.checked); },
              }),
              h('span', { className: 'dll-track', 'aria-hidden': 'true' }),
            ),
        ),
      );
    }

    /**
     * The "Lead agent only leads" settings page: every catalog tool grouped by class, each row with
     * its description, its default, and its toggle.
     * @param props - slot owner props, the injected face, and localized copy.
     * @returns the page element tree.
     */
    function LeadToolsPage({ useLeadTools, setTool, t }) {
      const snapshot = useLeadTools(value => value);
      const [pending, setPending] = useState(() => new Set());
      const [failed, setFailed] = useState(false);

      const toggle = useCallback((name, next) => {
        setFailed(false);
        setPending(current => new Set(current).add(name));
        Promise.resolve(setTool(name, next))
          .then(ok => { if (ok !== true) setFailed(true); })
          .catch(() => { setFailed(true); })
          .finally(() => {
            setPending(current => {
              const nextSet = new Set(current);
              nextSet.delete(name);
              return nextSet;
            });
          });
      }, [setTool]);

      if (snapshot === undefined || snapshot.status === 'loading') {
        return h('div', { className: 'dll-page' }, h('p', { className: 'dll-note' }, t('loading')));
      }
      if (snapshot.status === 'unavailable') {
        return h('div', { className: 'dll-page' }, h('p', { className: 'dll-note' }, t('unavailable')));
      }

      const overridden = snapshot.user !== undefined && snapshot.user !== null
        && (snapshot.user.leadTools !== undefined || snapshot.user.denyTools !== undefined);
      const writable = snapshot.writable !== false && !overridden;
      const tools = (snapshot.value !== undefined && snapshot.value !== null && typeof snapshot.value.tools === 'object' && snapshot.value.tools !== null)
        ? snapshot.value.tools
        : {};
      // The quote reflects the selection the rows below show; when a legacy
      // `leadTools`/`denyTools` override is present the toggles do not drive
      // policy, so the quote is derived from those keys instead — the lists the
      // Lead actually receives.
      const contractText = contractPreviewFor(overridden
        ? { leadTools: snapshot.user.leadTools, denyTools: snapshot.user.denyTools }
        : { tools });

      return h('div', { className: 'dll-page' },
        h('style', null, STYLE_TEXT),
        h('div', null,
          h('h2', { className: 'dll-title' }, t('title')),
          h('p', { className: 'dll-intro' }, t('intro')),
          h('blockquote', { className: 'dll-quote' },
            h('p', { className: 'dll-quote-title' }, t('contract.title')),
            h('div', { className: 'dll-quote-body' }, contractText),
            h('p', { className: 'dll-quote-note' }, t('contract.note')),
          ),
          h('p', { className: 'dll-note' }, t('applyNote')),
        ),
        overridden ? h('div', { className: 'dll-notice', role: 'status' }, t('overridden')) : null,
        failed ? h('p', { className: 'dll-alert', role: 'alert' }, t('error')) : null,
        ...GROUPS.map(group => h('section', { className: 'dll-group', key: group },
          h('h3', { className: 'dll-group-title' }, t(`group.${group}`)),
          h('p', { className: 'dll-group-note' }, t(`group.${group}.note`)),
          ...LEAD_TOOL_CATALOG.filter(entry => entry.klass === group).map(entry =>
            h(ToolRow, {
              key: entry.name,
              entry,
              enabled: tools[entry.name] === undefined ? entry.def : tools[entry.name] === true,
              disabled: !writable,
              pending: pending.has(entry.name),
              onToggle: toggle,
              t,
            })),
        )),
      );
    }

    return {
      name: '@local/dsh-lead-agent-only-leads',
      inject: ['slots', 'locale', 'configForms'],
      /** Shared catalog; verify.mjs deep-compares it against the host half. */
      LEAD_TOOL_CATALOG,
      /**
       * The contract builder the page quotes; verify.mjs compares it with the
       * host's `leadContract()` byte for byte.
       */
      contractPreview,
      /**
       * The contract text one row config produces: the selection-derived preview
       * the page renders, resolvable without a React render.
       */
      contractPreviewFor,
      /**
       * Register the dictionaries, follow the Host namespace, and mount the page.
       * @param ctx - client root context.
       */
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), '@local/dsh-lead-agent-only-leads: dictionaries');
        const form = ctx.configForms.get(HOST_NS);
        const store = createFormStore(form);
        ctx.effect(() => () => store.dispose(), '@local/dsh-lead-agent-only-leads: form state');
        ctx.effect(() => ctx.configForms.whileServed([HOST_NS], () => ctx.slots.inject('settings.section',
          () => ctx.slots.register({
            name: 'settings.section',
            id: SECTION_ID,
            order: SECTION_ORDER,
            label: () => ctx.locale.bind(NS)('nav'),
            locale: NS,
            inject: () => ({
              hooks: { leadTools: store },
              setTool: (name, next) => form.mutate([{ op: 'set', path: ['tools', name], value: next }]),
            }),
          }, LeadToolsPage))), '@local/dsh-lead-agent-only-leads: tools page');
      },
    };
  },
});
