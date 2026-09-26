(async function() {
  // ★★★★★ 实例管理 ★★★★★
  const WI_INSTANCE_ID = 'psychowi-editor';
  const WI_VERSION = '1.0.0';   // ← 以后每次发版改这里
  const __wiInstanceInfo = { id: WI_INSTANCE_ID, version: WI_VERSION, ts: Date.now(), kill: null };

  // 比较版本号：a > b 返回正数
  function __wiCompareVer(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const va = pa[i] || 0, vb = pb[i] || 0;
      if (va !== vb) return va - vb;
    }
    return 0;
  }

  // 用顶层 window 存注册表（脚本跑在 iframe 里，window 是隔离的）
  const __wiTopWin = (function() {
    try {
      if (window.top && window.top !== window && window.top.document) return window.top;
    } catch (e) {}
    return window;
  })();
  __wiTopWin.__wiInstances = __wiTopWin.__wiInstances || [];
  const __wiAlive = [];
  let __wiShouldExit = false;

  for (const inst of __wiTopWin.__wiInstances) {
    if (!inst || inst.id !== WI_INSTANCE_ID) { __wiAlive.push(inst); continue; }
    const cmp = __wiCompareVer(inst.version, WI_VERSION);
    if (cmp > 0) {
      // 旧实例版本更高 → 我退出
      console.log('[PsychoWI] 检测到更高版本 ' + inst.version + '，本实例（' + WI_VERSION + '）退出');
      __wiShouldExit = true;
      __wiAlive.push(inst); // 保留它
      continue;
    }
    if (cmp === 0) {
      // 同版本 → 后来者胜，杀旧的
      console.log('[PsychoWI] 检测到同版本旧实例，清理它');
    } else {
      // 旧实例版本更低 → 杀
      console.log('[PsychoWI] 检测到旧版本 ' + inst.version + '，清理它');
    }
    try { if (typeof inst.kill === 'function') inst.kill(); } catch (e) {}
    // 不 push 到 __wiAlive，等于丢弃
  }
  __wiTopWin.__wiInstances = __wiAlive;

  if (__wiShouldExit) {
    console.log('[PsychoWI] 本实例退出');
    return;
  }

  // 注册自己（kill 稍后填充）
  __wiTopWin.__wiInstances.push(__wiInstanceInfo);
  console.log('[PsychoWI] 实例已注册 v' + WI_VERSION + '，当前实例数：' + __wiTopWin.__wiInstances.length);

  // ★★★★★ 实例管理结束 ★★★★★

  console.log('🚀🚀🚀 [WI编辑器] 脚本开始加载 v=' + Date.now());
  window.__wiScriptLoaded = Date.now();
  async function waitTavernHelperAPI(maxWaitSec = 30) {
    const start = Date.now();
    while(Date.now() - start < maxWaitSec * 1000) {
      if (typeof getWorldbook === "function"
        && typeof replaceWorldbook === "function"
        && typeof getWorldbookNames === "function"
        && typeof getCharWorldbookNames === "function") {
        console.log("[WI编辑器] ✅酒馆助手API就绪");
        return true;
      }
      await new Promise(r => setTimeout(r, 800));
    }
    alert("[WI编辑器] ❌等待酒馆助手API超时");
    return false;
  }
  const apiReady = await waitTavernHelperAPI(25);
  if (!apiReady) return;

  const PANEL_ID = 'wi_live_editor_panel';
  const BTN_ID = 'wi_live_editor_btn';
  const USE_IMMEDIATE_RENDER = true;
  const LINE_HEIGHT = 18;
  const HISTORY_LIMIT = 20;

  const __wiRootDoc = (function() {
    try {
      if (window !== window.top && window.top && window.top.document) {
        return window.top.document;
      }
    } catch (e) {}
    return document;
  })();
  console.log('[WI编辑器] 监听根文档:', __wiRootDoc === document ? '当前 document' : '主 document');

  const POSITION_MAP = [
    { num: 0, str: 'before_character_definition', label: '↑Char 角色定义前' },
    { num: 1, str: 'after_character_definition',  label: '↓Char 角色定义后' },
    { num: 2, str: 'before_author_note',          label: '↑AT 作者注释前' },
    { num: 3, str: 'after_author_note',           label: '↓AT 作者注释后' },
    { num: 4, str: 'at_depth',                    label: '@D 指定深度' },
  ];

  const log = (...args) => console.log('[WI编辑器]', ...args);
  const err = (...args) => console.error('[WI编辑器]', ...args);

  async function safeGetCharWbNames(charName = 'current') {
    try { return await getCharWorldbookNames(charName); } catch (e) { err(e); return null; }
  }
  async function safeGetWb(name) {
    try { const data = await getWorldbook(name); return Array.isArray(data) ? data : []; }
    catch (e) { err('读取失败', e); return []; }
  }
  async function safeSaveWb(name, entries) {
    try {
      const opt = USE_IMMEDIATE_RENDER ? { render: true } : {};
      await replaceWorldbook(name, entries, opt);
      log('✅保存', entries.length);
      try {
        const ctx = SillyTavern.getContext();
        if (ctx && typeof ctx.reloadWorldInfoEditor === 'function') {
          ctx.reloadWorldInfoEditor(name, true);
        }
      } catch (e) {}
    } catch (e) { err('❌保存失败', e); }
  }
  // ============ 世界书分组 ============
  const WB_META_UID = -99999;   // 特殊 uid，用于存分组元数据的隐藏条目

  // 从世界书条目里读分组数据
  function parseWbGroupsFromEntries(entries) {
    state.wbGroups = {};
    state.wbGroupOrder = [];
    state.wbGroupCollapsed = {};

    // 1. 从每个条目的 extra._wiGroup 读归属
    entries.forEach(e => {
      if (e.uid === WB_META_UID) return;
      if (e.extra && e.extra._wiGroup && typeof e.extra._wiGroup === 'string') {
        const g = e.extra._wiGroup;
        if (!state.wbGroups[g]) state.wbGroups[g] = [];
        state.wbGroups[g].push(e.uid);
      }
    });

    // 2. 从隐藏条目读组顺序/折叠状态
    const metaEntry = entries.find(e => e.uid === WB_META_UID);
    if (metaEntry && metaEntry.content) {
      try {
        const data = JSON.parse(metaEntry.content);
        if (Array.isArray(data.order)) {
          state.wbGroupOrder = data.order;
        }
        if (data.collapsed && typeof data.collapsed === 'object') {
          state.wbGroupCollapsed = data.collapsed;
        }
      } catch (e) { err('解析分组元数据失败', e); }
    }

    // 3. 补全组顺序（从条目里发现的组，如果没在 order 里，追加）
    Object.keys(state.wbGroups).forEach(g => {
      if (!state.wbGroupOrder.includes(g)) {
        state.wbGroupOrder.push(g);
      }
    });
  }

  // 把当前分组数据写回条目
  function syncWbGroupsToEntries() {
    // 1. 每个条目更新 extra._wiGroup
    state.entries.forEach(e => {
      if (e.uid === WB_META_UID) return;
      // 找到它属于哪个组
      let foundGroup = null;
      for (const g of Object.keys(state.wbGroups)) {
        if (state.wbGroups[g].includes(e.uid)) {
          foundGroup = g;
          break;
        }
      }
      if (!e.extra) e.extra = {};
      if (foundGroup) {
        e.extra._wiGroup = foundGroup;
      } else {
        delete e.extra._wiGroup;
      }
    });

    // 2. 更新/创建元数据条目
    const metaData = {
      order: state.wbGroupOrder,
      collapsed: state.wbGroupCollapsed,
    };
    let metaEntry = state.entries.find(e => e.uid === WB_META_UID);
    if (!metaEntry) {
      metaEntry = {
        uid: WB_META_UID,
        name: '__WI_GROUPS__',
        content: '',
        enabled: false,
        strategy: {
          type: 'constant',
          keys: [],
          keys_secondary: { logic: 'and_any', keys: [] },
          scan_depth: 'same_as_global',
        },
        position: {
          type: 'before_character_definition',
          role: 'system',
          depth: 4,
          order: 9999,
        },
        probability: 100,
        recursion: { prevent_incoming: false, prevent_outgoing: false, delay_until: null },
        effect: { sticky: null, cooldown: null, delay: null },
        addMemo: true,
        group: '',
        groupOverride: false,
        groupWeight: 100,
        useGroupScoring: false,
        automationId: '',
        ignoreBudget: false,
        outletName: '',
        triggers: [],
        characterFilter: { isExclude: false, names: [], tags: [] },
        extra: { _wiMeta: true },
      };
      state.entries.push(metaEntry);
    }
    metaEntry.content = JSON.stringify(metaData);
  }

  // ============ 开场白标记 → 世界书组开关 ============
  const WB_GROUP_MARK_RE = /<!--\s*group\s*:\s*([^\-]+?)\s*-->/g;

  // 从一段文本里提取所有 <!-- group: xxx --> 里的组名
  function extractGroupMarks(text) {
    if (!text) return [];
    const out = [];
    let m;
    WB_GROUP_MARK_RE.lastIndex = 0;
    while ((m = WB_GROUP_MARK_RE.exec(text)) !== null) {
      const name = m[1].trim();
      if (name && !out.includes(name)) out.push(name);
    }
    return out;
  }

  // 读第一条消息当前生效的 swipe 内容
  async function readFirstMessageText() {
    try {
      const ctx = SillyTavern.getContext();
      // 优先用酒馆原生 chat 数据
      if (ctx.chat && ctx.chat[0]) {
        const m = ctx.chat[0];
        if (Array.isArray(m.swipes) && m.swipes.length > 0) {
          const idx = Number(m.swipe_id ?? 0);
          const txt = m.swipes[idx];
          if (typeof txt === 'string' && txt.length > 0) return txt;
        }
        if (typeof m.mes === 'string' && m.mes.length > 0) return m.mes;
      }
      // 退路：用酒馆助手 API
      if (typeof getChatMessages === 'function') {
        const msgs = getChatMessages('0', { include_swipes: true });
        if (msgs && msgs[0]) {
          const m = msgs[0];
          if (Array.isArray(m.swipes) && m.swipes.length > 0) {
            const idx = Number(m.swipe_id ?? 0);
            if (typeof m.swipes[idx] === 'string') return m.swipes[idx];
          }
          if (typeof m.message === 'string') return m.message;
        }
      }
    } catch (e) {
      err('读取第一条消息失败', e);
    }
    return '';
  }

  // 扫描开场白里的 <!-- group: xxx --> 标记，并应用到世界书条目开关
  async function scanAndApplyGroups(reason = 'manual') {
    if (!state.activeBook) {
      return;
    }
    if (Object.keys(state.wbGroups).length === 0) {
      return;
    }

    const text = await readFirstMessageText();
    const marks = extractGroupMarks(text);

    // 没写任何标记 → 不动
    if (marks.length === 0) {
      return;
    }

    // 标记里存在的组名（忽略不存在的）
    const validMarks = marks.filter(g => state.wbGroups[g] !== undefined);
    const unknownMarks = marks.filter(g => state.wbGroups[g] === undefined);
    if (unknownMarks.length > 0) {
      console.warn('[WI编辑器] 开场白标记了不存在的组:', unknownMarks);
    }

    if (validMarks.length === 0) {
      return;
    }

    // 替换式：validMarks 里的组开，其他组全关
    let changed = 0;
    state.entries.forEach(e => {
      if (e.uid === WB_META_UID) return;
      const g = getEntryGroup(e.uid);
      if (!g || g === '未分组') return; // 未分组条目不动

      const shouldEnable = validMarks.includes(g);
      const isEnabled = e.enabled !== false;
      if (shouldEnable !== isEnabled) {
        e.enabled = shouldEnable;
        changed++;
      }
    });

    if (changed === 0) {
      return;
    }

    // 写回世界书 + 刷新视图
    await safeSaveWb(state.activeBook, state.entries);
    if (state.groupView) renderEntryList();
  }

  // 该条目是否属于任意分组
  function getEntryGroup(uid) {
    for (const g of Object.keys(state.wbGroups)) {
      if (state.wbGroups[g].includes(uid)) return g;
    }
    return null;
  }

  function escapeHtml(s, maxLen = 800) {
    let str = String(s ?? '');
    if (str.length > maxLen) str = str.slice(0, maxLen) + `\n…（已截断，原长 ${String(s ?? '').length} 字）`;
    return str.replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function readTitle(e) { return e.name ?? ''; }
  function readContent(e) { return e.content ?? ''; }
  function readKeysStr(e) {
    const k = e.strategy?.keys;
    return Array.isArray(k) ? k.join(', ') : '';
  }
  function readPosNum(e) {
    const type = e.position?.type ?? 'before_character_definition';
    const item = POSITION_MAP.find(x => x.str === type);
    return item ? item.num : 0;
  }
  function readDepthVal(e) {
    const d = Number(e.position?.depth);
    return isNaN(d) ? 4 : d;
  }
  function readInsertOrder(e) {
    const v = Number(e.position?.order);
    return isNaN(v) ? 50 : v;
  }
  function readEnabled(e) { return e.enabled !== false; }

  function fillEntry(entry, formData) {
    entry.name = formData.name;
    entry.content = formData.content;
    if (!entry.strategy) entry.strategy = {};
    entry.strategy.type = formData.strategyType || entry.strategy.type || 'constant';
    entry.strategy.keys = formData.keys
      .split(/[,，;；\n\r\t]+/)
      .map(s => s.trim())
      .filter(Boolean);
    if (!entry.position) entry.position = {};
    const posItem = POSITION_MAP.find(x => x.num === formData.posNum) || POSITION_MAP[1];
    entry.position.type = posItem.str;
    entry.position.depth = Number(formData.depth);
    entry.position.order = Number(formData.order);
    if (!entry.position.role) entry.position.role = 'system';
    entry.enabled = formData.enabled;
    // 递归设置
    if (!entry.recursion) entry.recursion = { prevent_incoming: false, prevent_outgoing: false, delay_until: null };
    entry.recursion.prevent_outgoing = !!formData.preventOutgoing;
    entry.recursion.prevent_incoming = !!formData.preventIncoming;
    return entry;
  }

  let state = {
    books: [],
    activeBook: null,
    entries: [],
    selectedIdx: -1,
    followChar: true,
    // ★ 世界书分组相关
    groupView: false,          // 是否在分组视图
    wbGroups: {},              // { 组名: [uid, ...] }  用 uid 记录成员
    wbGroupOrder: [],          // 组顺序
    wbGroupCollapsed: {},      // 折叠状态
    searchTerm: '',
    searchRegex: false,
    matchList: [],
    matchCursor: -1,
    dragSrcIdx: -1,
    isFullscreen: false,
    batchMode: false,
    selectedUids: new Set(),
    history: [],
    activeTab: 'worldbook',
  };

  const BTN_CSS = 'padding:5px 12px;background:var(--wi-bg-2);color:var(--wi-fg-2);border:1px solid var(--wi-border);border-radius:6px;cursor:pointer;font-size:12px;transition:background .15s,border-color .15s;';
  const BTN_PRIMARY_CSS = 'padding:5px 12px;background:var(--wi-primary-bg);color:var(--wi-primary-fg);border:1px solid var(--wi-primary-bg);border-radius:6px;cursor:pointer;font-size:12px;font-weight:500;';
  const BTN_DANGER_CSS = 'padding:5px 12px;background:var(--wi-danger-bg);color:var(--wi-danger-fg);border:1px solid var(--wi-danger-bg);border-radius:6px;cursor:pointer;font-size:12px;';
  const BTN_NAV_CSS = 'padding:4px 8px;background:var(--wi-bg-2);color:var(--wi-fg-2);border:1px solid var(--wi-border);border-radius:6px;cursor:pointer;font-size:12px;';
  const INPUT_CSS = 'width:100%;background:var(--wi-bg);color:var(--wi-fg);border:1px solid var(--wi-border);border-radius:6px;padding:6px 8px;box-sizing:border-box;font-size:12px;outline:none;';
  const LABEL_CSS = 'margin:10px 0 4px;font-size:11px;color:var(--wi-fg-dim);';
  const PREVIEW_CSS = 'margin-top:6px;padding:10px;background:var(--wi-bg-2);border:1px solid var(--wi-border);border-radius:6px;font-size:12px;white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;color:var(--wi-fg-2);font-family:inherit;position:relative;';

  function ensureMeasureEl() {
    if ($('#wi_measure').length) return;
    $('<div id="wi_measure">').css({
      position: 'absolute',
      visibility: 'hidden',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      fontFamily: 'inherit',
      fontSize: '12px',
      lineHeight: LINE_HEIGHT + 'px',
      padding: '5px',
      boxSizing: 'border-box',
      pointerEvents: 'none',
      zIndex: -1,
      top: 0,
      left: 0,
    }).appendTo('body');
  }

  // ★ 主题拖拽指示线
  (function injectThDragCSS() {
    if (__wiRootDoc.getElementById('wi_th_drag_css')) return;
    const st = __wiRootDoc.createElement('style');
    st.id = 'wi_th_drag_css';
    st.textContent = `
      .wi-th-card.wi-th-drag-above {
        box-shadow: 0 -2px 0 0 #4a9eff inset !important;
      }
      .wi-th-card.wi-th-drag-below {
        box-shadow: 0 2px 0 0 #4a9eff inset !important;
      }
    `;
    __wiRootDoc.head.appendChild(st);
  })();

  // ★ 开场白拖拽指示线
  (function injectGrDragCSS() {
    if (__wiRootDoc.getElementById('wi_gr_drag_css')) return;
    const st = __wiRootDoc.createElement('style');
    st.id = 'wi_gr_drag_css';
    st.textContent = `
      #wi_ch_greeting_list [data-gr-idx].wi-gr-drag-above {
        box-shadow: 0 -2px 0 0 #4a9eff inset !important;
      }
      #wi_ch_greeting_list [data-gr-idx].wi-gr-drag-below {
        box-shadow: 0 2px 0 0 #4a9eff inset !important;
      }
    `;
    __wiRootDoc.head.appendChild(st);
  })();

  // ★ 世界书分组视图
  function renderWbGroupList($list) {
    const term = state.searchTerm || '';
    const metaUid = WB_META_UID;
    const allEntries = state.entries.filter(e => e.uid !== metaUid);
    const totalCount = allEntries.length;

    // 收集所有在组里的 uid
    const inGroups = new Set();
    Object.values(state.wbGroups).forEach(arr => arr.forEach(uid => inGroups.add(uid)));
    const ungroupedUids = allEntries.filter(e => !inGroups.has(e.uid)).map(e => e.uid);

    // 把"未分组"组和"没标记"的条目合并，统一显示为"未分组"
    const mergedGroups = {};
    state.wbGroupOrder.forEach(g => {
      mergedGroups[g] = (state.wbGroups[g] || []).slice();
    });
    // 确保有"未分组"这个组
    if (!mergedGroups['未分组']) mergedGroups['未分组'] = [];
    // 把没标记的 uid 追加到"未分组"
    ungroupedUids.forEach(uid => {
      if (!mergedGroups['未分组'].includes(uid)) {
        mergedGroups['未分组'].push(uid);
      }
    });

    // 渲染顺序：有顺序的组 + 未分组放最后
    const renderGroups = state.wbGroupOrder
      .filter(g => mergedGroups[g] && mergedGroups[g].length > 0);
    if (!renderGroups.includes('未分组') && mergedGroups['未分组'].length > 0) {
      renderGroups.push('未分组');
    }

    if (renderGroups.length === 0) {
      $list.append('<div style="color:#888;text-align:center;padding:40px;font-size:12px">没有任何条目</div>');
      return;
    }

    // 画一个组
    const drawGroup = (gname, uids) => {
      const collapsed = !!state.wbGroupCollapsed[gname];
      const $header = $(`<div class="wi-wb-group-header" data-group="${escapeHtml(gname)}" style="padding:6px 10px;cursor:pointer;background:var(--wi-bg-3);border-bottom:1px solid var(--wi-border);display:flex;align-items:center;gap:6px;user-select:none;position:sticky;top:0;z-index:2">
        <span style="color:var(--wi-fg-dim);font-size:10px;width:10px;display:inline-block">${collapsed ? '▶' : '▼'}</span>
        <span style="font-size:12px;color:var(--wi-fg);font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(gname)}</span>
        <span style="font-size:10px;color:var(--wi-fg-dim)">(${uids.length})</span>
        <span class="wi-wb-group-menu" data-group="${escapeHtml(gname)}" style="font-size:12px;color:var(--wi-fg-dim);cursor:pointer;padding:0 4px" title="分组菜单">⋯</span>
      </div>`);

      $header.on('click', (ev) => {
        if ($(ev.target).hasClass('wi-wb-group-menu')) return;
        state.wbGroupCollapsed[gname] = !collapsed;
        syncWbGroupsToEntries();
        safeSaveWb(state.activeBook, state.entries).then(() => renderEntryList());
      });

      $header.find('.wi-wb-group-menu').on('click', (ev) => {
        ev.stopPropagation();
        openWbGroupMenu(ev, gname);
      });

      // ★ 接收条目拖拽
      $header.on('dragover', (ev) => {
        if (!window.__wiWbDragUid) return;
        ev.preventDefault();
        ev.stopPropagation();
        ev.originalEvent.dataTransfer.dropEffect = 'move';
        $header.css({ background: 'var(--wi-accent)', color: 'var(--wi-accent-fg)' });
        return false;
      });
      $header.on('dragleave', (ev) => {
        // 只有真正离开才清（避免子元素触发）
        if (ev.originalEvent && $header[0].contains(ev.originalEvent.relatedTarget)) return;
        $header.css({ background: 'var(--wi-bg-3)', color: '' });
      });
      $header.on('drop', async (ev) => {
        if (!window.__wiWbDragUid) return;
        ev.preventDefault();
        ev.stopPropagation();
        $header.css({ background: 'var(--wi-bg-3)', color: '' });

        const uid = window.__wiWbDragUid;
        const targetGroup = gname;

        // 从所有组里移除该 uid
        Object.keys(state.wbGroups).forEach(k => {
          state.wbGroups[k] = state.wbGroups[k].filter(u => u !== uid);
        });
        // 加到目标组（"未分组"就只移出不加入）
        if (targetGroup !== '未分组') {
          if (!state.wbGroups[targetGroup]) state.wbGroups[targetGroup] = [];
          if (!state.wbGroups[targetGroup].includes(uid)) {
            state.wbGroups[targetGroup].push(uid);
          }
        }
        syncWbGroupsToEntries();
        await safeSaveWb(state.activeBook, state.entries);
        renderEntryList();
        if (window.toastr) window.toastr.success(`已移到「${targetGroup}」`);
      });

      $list.append($header);

      if (collapsed) return;

      uids.forEach(uid => {
        const idx = state.entries.findIndex(e => e.uid === uid);
        if (idx < 0) return;
        const e = state.entries[idx];
        const title = readTitle(e) || `【无标题】`;
        const enabled = readEnabled(e);
        const isSelected = idx === state.selectedIdx;
        const isChecked = e.uid !== undefined && state.selectedUids.has(e.uid);
        const strategyType = e.strategy?.type || 'constant';
        let dotColor;
        if (!enabled) dotColor = '#555';
        else if (strategyType === 'constant') dotColor = '#4a9eff';
        else dotColor = '#58b600';
        const bg = isSelected ? '#3a3a44' : (isChecked ? '#2a2a3a' : '');

        let titleHtml = escapeHtml(title);
        if (term) {
          const lower = title.toLowerCase();
          const ti = lower.indexOf(term.toLowerCase());
          if (ti >= 0) {
            titleHtml = escapeHtml(title.slice(0, ti)) +
              `<mark style="background:#ffcc00;color:#000">${escapeHtml(title.slice(ti, ti + term.length))}</mark>` +
              escapeHtml(title.slice(ti + term.length));
          }
        }

        const bgVar = isSelected ? 'var(--wi-selected)' : (isChecked ? 'var(--wi-hover)' : 'transparent');
        const $item = $(`<div class="wi-list-item" data-idx="${idx}" data-uid="${e.uid ?? ''}" style="padding:6px 10px 6px 24px;cursor:pointer;border-bottom:1px solid var(--wi-border);display:flex;align-items:flex-start;gap:6px;background:${bgVar}" draggable="true">
          <span class="wi-wb-handle" style="cursor:grab;color:var(--wi-fg-dim);font-size:12px;padding-top:2px;user-select:none" title="拖拽">☰</span>
          <span style="flex-shrink:0;display:inline-block;width:8px;height:8px;border-radius:50%;background:${dotColor};margin-top:5px"></span>
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;color:${enabled ? 'var(--wi-fg)' : 'var(--wi-fg-dim)'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${titleHtml}</div>
          </div>
        </div>`);

        $item.on('click', async (ev) => {
          if ($(ev.target).hasClass('wi-wb-handle')) return;
          await flushAutoSave();
          state.selectedIdx = idx;
          fillFormByEntry(e);
          renderEntryList();
          renderAllPreviews();
        });

        // 右键 → 移到分组菜单
        $item.on('contextmenu', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          try {
            openWbEntryMoveMenu(ev, e.uid, e.name);
          } catch (err) {
            console.error('[WI编辑器] openWbEntryMoveMenu 调用失败:', err);
            alert('右键菜单出错：' + err.message);
          }
        });

        // ★ 拖动条目 → 拖到分组标题
        // 只有按住 ☰ 手柄才能拖，避免误触
        const $handle = $item.find('.wi-wb-handle');

        // 默认不可拖
        $item.attr('draggable', 'false');

        $handle.on('mousedown', () => {
          $item.attr('draggable', 'true');
        });
        $handle.on('mouseup', () => {
          // 鼠标松开后禁用，避免后续误触
          setTimeout(() => $item.attr('draggable', 'false'), 0);
        });

        $item.on('dragstart', (ev) => {
          window.__wiWbDragUid = e.uid;
          $item.css('opacity', '0.4');
          if (ev.originalEvent && ev.originalEvent.dataTransfer) {
            ev.originalEvent.dataTransfer.effectAllowed = 'move';
            try { ev.originalEvent.dataTransfer.setData('text/plain', String(e.uid)); } catch (_) {}
          }
        });
        $item.on('dragend', () => {
          window.__wiWbDragUid = null;
          $item.css('opacity', '1');
          $item.attr('draggable', 'false');
          $header.css({ background: 'var(--wi-bg-3)', color: '' });
        });

        $list.append($item);
      });
    };

    renderGroups.forEach(g => drawGroup(g, mergedGroups[g]));
  }

  // ★ 可搜索下拉框
  //   调用方式：openSearchableDropdown(ev, { items, onPick, placeholder })
  //   items: [{ value, label }]
  function openSearchableDropdown(ev, opts) {
    try { if (ev) ev.preventDefault(); } catch (e) {}
    try { if (ev) ev.stopPropagation(); } catch (e) {}

    const { items = [], onPick, placeholder = '搜索…', triggerEl: optTriggerEl } = opts || {};

    // 移除旧面板
    __wiRootDoc.querySelectorAll('.wi-search-dropdown').forEach(el => el.remove());

    // 定位：优先用 opts.triggerEl，其次从 ev 拿
    let triggerEl = optTriggerEl || (ev && (ev.currentTarget || ev.target)) || null;
    // ★ 兜底：直接查 DOM 里的世界书按钮
    if (!triggerEl || !triggerEl.getBoundingClientRect) {
      const fallback = __wiRootDoc.getElementById('wi_book_select_btn');
      if (fallback && fallback.getBoundingClientRect) triggerEl = fallback;
    }
    // ★ 兜底：如果没拿到 triggerEl，直接查 #wi_book_select_btn
    if (!triggerEl) {
      const fallbackBtn = __wiRootDoc.getElementById('wi_book_select_btn');
      if (fallbackBtn && fallbackBtn.getBoundingClientRect) {
        // 用 fallbackBtn 替代
        const r = fallbackBtn.getBoundingClientRect();
        if (r.width > 0) {
          // 走定位逻辑
          const panel0 = __wiRootDoc.createElement('div');  // 先不创建，直接后续代码用 fallbackBtn
          // 把 triggerEl 换成 fallbackBtn
          // ↓ 通过重新赋值（如果可以）
        }
      }
    }
    console.log('[WI编辑器·搜索下拉] triggerEl =', triggerEl, ' 类型:', triggerEl?.tagName, ' id:', triggerEl?.id);
    let x = 100, y = 100, width = 260;
    if (triggerEl && triggerEl.getBoundingClientRect) {
      const r = triggerEl.getBoundingClientRect();
      console.log('[WI编辑器·搜索下拉] 定位 rect =', r.left, r.top, r.right, r.bottom);
      x = r.left;
      y = r.bottom + 4;
      width = Math.max(220, r.width);
    } else {
      console.log('[WI编辑器·搜索下拉] ❌ 没拿到 triggerEl！用默认 x=100,y=100');
    }

    const panel = __wiRootDoc.createElement('div');
    panel.className = 'wi-search-dropdown';
    panel.style.cssText = `
      position: fixed;
      z-index: 2147483647;
      left: ${x}px;
      top: ${y}px;
      width: ${width}px;
      max-height: 320px;
      background: var(--wi-bg);
      border: 1px solid var(--wi-border-strong);
      border-radius: 8px;
      box-shadow: 0 8px 24px var(--wi-shadow);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-size: 12px;
      color: var(--wi-fg);
    `;

    // 输入框
    const input = __wiRootDoc.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.style.cssText = `border:none;border-bottom:1px solid var(--wi-border);background:var(--wi-bg-2);color:var(--wi-fg);padding:8px 10px;font-size:12px;outline:none;flex-shrink:0;`;
    panel.appendChild(input);

    // 列表容器
    const listWrap = __wiRootDoc.createElement('div');
    listWrap.style.cssText = `overflow-y:auto;flex:1;min-height:0;`;
    panel.appendChild(listWrap);

    // 空状态
    const emptyEl = __wiRootDoc.createElement('div');
    emptyEl.style.cssText = `padding:14px;text-align:center;color:var(--wi-fg-dim);font-size:11px;display:none;`;
    emptyEl.textContent = '没有匹配项';
    panel.appendChild(emptyEl);

    __wiRootDoc.body.appendChild(panel);

    // 屏幕边缘修正（用顶层 window，因为脚本可能在无布局的 iframe 里）
    const _win = (window.top && window.top.innerWidth) ? window.top : window;
    const rect = panel.getBoundingClientRect();
    if (rect.right > _win.innerWidth - 8) {
      panel.style.left = Math.max(8, _win.innerWidth - rect.width - 8) + 'px';
    }
    if (rect.bottom > _win.innerHeight - 8) {
      panel.style.top = Math.max(8, y - rect.height - (triggerEl ? triggerEl.getBoundingClientRect().height : 0) - 8) + 'px';
    }

    // 状态
    let filtered = items.slice();
    let cursor = 0;

    const renderList = (term) => {
      const t = (term || '').trim().toLowerCase();
      filtered = !t ? items.slice() : items.filter(it => (it.label || '').toLowerCase().includes(t));
      listWrap.innerHTML = '';
      if (filtered.length === 0) {
        emptyEl.style.display = 'block';
        return;
      }
      emptyEl.style.display = 'none';
      if (cursor >= filtered.length) cursor = filtered.length - 1;
      if (cursor < 0) cursor = 0;

      filtered.forEach((it, i) => {
        const row = __wiRootDoc.createElement('div');
        const isActive = i === cursor;
        row.style.cssText = `padding:8px 10px;cursor:pointer;color:${isActive ? 'var(--wi-accent)' : 'var(--wi-fg)'};background:${isActive ? 'var(--wi-hover)' : 'transparent'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`;

        // 高亮匹配
        if (t) {
          const lower = (it.label || '').toLowerCase();
          const idx = lower.indexOf(t);
          if (idx >= 0) {
            const before = document.createTextNode(it.label.slice(0, idx));
            const mark = document.createElement('mark');
            mark.style.cssText = 'background:#ffcc00;color:#000;padding:0 1px;border-radius:2px';
            mark.textContent = it.label.slice(idx, idx + t.length);
            const after = document.createTextNode(it.label.slice(idx + t.length));
            row.appendChild(before); row.appendChild(mark); row.appendChild(after);
          } else {
            row.textContent = it.label;
          }
        } else {
          row.textContent = it.label;
        }

        row.addEventListener('mouseenter', () => {
          cursor = i;
          renderList(input.value);
        });
        row.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          close();
          if (typeof onPick === 'function') onPick(it.value, it);
        });
        listWrap.appendChild(row);

        if (isActive) {
          // 滚动到可见
          setTimeout(() => {
            try { row.scrollIntoView({ block: 'nearest' }); } catch (e) {}
          }, 0);
        }
      });
    };

    input.addEventListener('input', () => {
      cursor = 0;
      renderList(input.value);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        cursor = Math.min(cursor + 1, filtered.length - 1);
        renderList(input.value);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        cursor = Math.max(cursor - 1, 0);
        renderList(input.value);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[cursor]) {
          const it = filtered[cursor];
          close();
          if (typeof onPick === 'function') onPick(it.value, it);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });

    // 关闭
    let closed = false;
    function close() {
      if (closed) return;
      closed = true;
      panel.remove();
      __wiRootDoc.removeEventListener('click', outsideHandler, true);
      __wiRootDoc.removeEventListener('keydown', escHandler, true);
    }
    function outsideHandler(e) {
      if (!panel.contains(e.target) && e.target !== triggerEl) close();
    }
    function escHandler(e) {
      if (e.key === 'Escape') close();
    }
    setTimeout(() => {
      __wiRootDoc.addEventListener('click', outsideHandler, true);
      __wiRootDoc.addEventListener('keydown', escHandler, true);
    }, 0);

    renderList('');
    setTimeout(() => input.focus(), 30);
    return { close };
  }

  // 条目的"移到分组"菜单
  function openWbEntryMoveMenu(ev, uid, entryName) {
    // 收集所有分组名
    const groups = [];
    state.wbGroupOrder.forEach(g => {
      if (!groups.includes(g)) groups.push(g);
    });
    Object.keys(state.wbGroups).forEach(g => {
      if (!groups.includes(g)) groups.push(g);
    });
    // 确保有"未分组"
    if (!groups.includes('未分组')) groups.push('未分组');

    // 找当前条目在哪个组
    let curGroup = null;
    for (const g of Object.keys(state.wbGroups)) {
      if (state.wbGroups[g].includes(uid)) {
        curGroup = g;
        break;
      }
    }

    const items = groups.map(g => ({
      label: (curGroup === g ? '✓ ' : '  ') + (g === '未分组' ? '📥 ' : '📁 ') + g,
      action: () => {
        // 从所有组移除
        Object.keys(state.wbGroups).forEach(k => {
          state.wbGroups[k] = state.wbGroups[k].filter(u => u !== uid);
        });
        // 加到目标组
        if (g !== '未分组') {
          if (!state.wbGroups[g]) state.wbGroups[g] = [];
          state.wbGroups[g].push(uid);
        }
        syncWbGroupsToEntries();
        safeSaveWb(state.activeBook, state.entries).then(() => renderEntryList());
      },
    }));

    items.push({ divider: true });
    items.push({
      label: '＋ 新建分组并移入…',
      action: () => {
        const newName = prompt('新分组名：', '');
        if (!newName) return;
        Object.keys(state.wbGroups).forEach(k => {
          state.wbGroups[k] = state.wbGroups[k].filter(u => u !== uid);
        });
        if (!state.wbGroups[newName]) {
          state.wbGroups[newName] = [];
          state.wbGroupOrder.push(newName);
        }
        state.wbGroups[newName].push(uid);
        syncWbGroupsToEntries();
        safeSaveWb(state.activeBook, state.entries).then(() => renderEntryList());
      },
    });

    const fn = window.__wiShowMiniMenu || (typeof showMiniMenu === 'function' ? showMiniMenu : null);
    if (fn) {
      fn(ev, items);
    } else {
      console.error('[WI编辑器] showMiniMenu 不可用');
      alert('菜单系统未就绪，请重载脚本');
    }
  }

  // 分组菜单
  function openWbGroupMenu(ev, gname) {
    ev.preventDefault();
    ev.stopPropagation();
    const items = [
      {
        label: '✏️ 重命名分组',
        action: () => {
          const newName = prompt('新分组名：', gname);
          if (!newName || newName === gname) return;
          const oldUids = state.wbGroups[gname] || [];
          delete state.wbGroups[gname];
          state.wbGroups[newName] = oldUids;
          state.wbGroupOrder = state.wbGroupOrder.map(g => g === gname ? newName : g);
          if (state.wbGroupCollapsed[gname] !== undefined) {
            state.wbGroupCollapsed[newName] = state.wbGroupCollapsed[gname];
            delete state.wbGroupCollapsed[gname];
          }
          syncWbGroupsToEntries();
          safeSaveWb(state.activeBook, state.entries).then(() => renderEntryList());
        },
      },
      {
        label: '➕ 把未分组条目全加进来',
        action: () => {
          const inGroups = new Set();
          Object.values(state.wbGroups).forEach(arr => arr.forEach(u => inGroups.add(u)));
          if (!state.wbGroups[gname]) state.wbGroups[gname] = [];
          state.entries.forEach(e => {
            if (e.uid === WB_META_UID) return;
            if (!inGroups.has(e.uid)) {
              state.wbGroups[gname].push(e.uid);
            }
          });
          syncWbGroupsToEntries();
          safeSaveWb(state.activeBook, state.entries).then(() => renderEntryList());
        },
      },
      { divider: true },
      {
        label: '🗑️ 删除分组（条目移到未分组）',
        danger: true,
        action: () => {
          if (!confirm(`确定删除分组「${gname}」？\n\n组里的条目会移到"未分组"。`)) return;
          delete state.wbGroups[gname];
          state.wbGroupOrder = state.wbGroupOrder.filter(g => g !== gname);
          delete state.wbGroupCollapsed[gname];
          syncWbGroupsToEntries();
          safeSaveWb(state.activeBook, state.entries).then(() => renderEntryList());
        },
      },
    ];
    const fn = window.__wiShowMiniMenu || (typeof showMiniMenu === 'function' ? showMiniMenu : null);
    if (fn) {
      fn(ev, items);
    } else {
      console.error('[WI编辑器] showMiniMenu 不可用');
      alert('菜单系统未就绪，请重载脚本');
    }
  }

  // ============ 撤销 ============
  function pushHistory() {
    try {
      const snapshot = JSON.stringify(state.entries);
      state.history.push({
        book: state.activeBook,
        data: snapshot,
        ts: Date.now(),
      });
      if (state.history.length > HISTORY_LIMIT) {
        state.history.shift();
      }
      updateUndoBtn();
    } catch (e) {
      err('pushHistory 失败', e);
    }
  }

  function updateUndoBtn() {
    const $b = $('#wi_undo');
    if ($b.length) {
      const n = state.history.length;
      $b.prop('disabled', n === 0).css('opacity', n === 0 ? 0.4 : 1);
      $b.attr('title', n === 0 ? '没有可撤销的操作' : `撤销 (${n} 步可撤)`);
    }
  }

  async function undo() {
    if (state.history.length === 0) {
      alert('没有可撤销的操作');
      return;
    }
    const last = state.history[state.history.length - 1];
    if (last.book !== state.activeBook) {
      if (!confirm(`上一步操作是在世界书「${last.book}」上。撤销会切换回该世界书，继续？`)) {
        return;
      }
    }

    const restored = JSON.parse(last.data);
    state.history.pop();

    state.activeBook = last.book;
    state.entries = restored;
    state.selectedIdx = -1;

    await safeSaveWb(state.activeBook, state.entries);
    await loadEntries();
    renderEntryList();
    renderAllPreviews();
    updateMatchCounter();
    updateUndoBtn();
    alert('已撤销');
  }

  // ============ 导入 / 导出 ============

  function exportSelected() {
    const uids = state.selectedUids;
    let list;
    if (uids.size > 0) {
      list = state.entries.filter(e => e.uid !== undefined && uids.has(e.uid));
    } else if (state.selectedIdx >= 0 && state.entries[state.selectedIdx]) {
      list = [state.entries[state.selectedIdx]];
    } else {
      alert('请先选中一条或勾选多条条目');
      return;
    }

    const exportData = list.map(e => ({
      name: e.name || '',
      content: e.content || '',
      keys: (e.strategy?.keys || []).slice(),
      strategyType: e.strategy?.type || 'constant',
      positionType: e.position?.type || 'before_character_definition',
      depth: e.position?.depth ?? 4,
      order: e.position?.order ?? 50,
      enabled: e.enabled !== false,
    }));

    const json = JSON.stringify(exportData, null, 2);

    showModal(`
      <div style="font-size:13px;font-weight:700;color:#eee;margin-bottom:6px">📤 导出 ${exportData.length} 条条目</div>
      <div style="font-size:11px;color:#888;margin-bottom:8px">全选复制下面的 JSON，粘贴到别处保存。或点"复制到剪贴板"。</div>
      <textarea id="wi_export_area" readonly style="width:100%;height:280px;background:#161618;color:#bbb;border:1px solid #444;border-radius:4px;padding:8px;box-sizing:border-box;font-family:monospace;font-size:11px;resize:vertical">${json.replace(/</g, '&lt;')}</textarea>
      <div style="margin-top:8px;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">
        <button id="wi_exp_download" style="${BTN_PRIMARY_CSS}">💾 下载为 .json 文件</button>
        <button id="wi_exp_copy" style="${BTN_CSS}">📋 复制到剪贴板</button>
        <button id="wi_exp_close" onclick="(function(e){e.preventDefault();e.stopPropagation();var m=this.closest('#wi_modal_mask');if(m)m.remove();else document.querySelectorAll('#wi_modal_mask').forEach(function(x){x.remove()});}).call(this,event)" style="${BTN_CSS}">关闭</button>
      </div>
    `, ($m) => {
      $('#wi_exp_download').on('click', () => {
        const bookName = state.activeBook || 'worldbook';
        const ts = new Date().toISOString().slice(0, 10);
        const fname = `${safeFilename(bookName)}_${ts}.json`;
        if (downloadJson(fname, exportData)) {
          alert(`已下载：${fname}`);
        } else {
          alert('下载失败，请用"复制到剪贴板"');
        }
      });
      $('#wi_exp_copy').on('click', async () => {
        const ta = $m.find('#wi_export_area')[0];
        try {
          await navigator.clipboard.writeText(ta.value);
          alert('已复制到剪贴板');
        } catch (e) {
          ta.select();
          document.execCommand('copy');
          alert('已复制到剪贴板');
        }
      });
    });
  }

  function importJson() {
    showModal(`
      <div style="font-size:13px;font-weight:700;color:#eee;margin-bottom:6px">📥 导入 JSON</div>
      <div style="font-size:11px;color:#888;margin-bottom:8px;line-height:1.6">
        粘贴之前导出的 JSON 数组。选择：
        <br>· <b>追加</b>：加到当前世界书末尾
        <br>· <b>替换</b>：清空当前世界书后写入（危险）
      </div>
      <textarea id="wi_import_area" placeholder="[{ &quot;name&quot;: &quot;...&quot;, &quot;content&quot;: &quot;...&quot;, ... }]" style="width:100%;height:240px;background:#161618;color:#bbb;border:1px solid #444;border-radius:4px;padding:8px;box-sizing:border-box;font-family:monospace;font-size:11px;resize:vertical"></textarea>
      <div id="wi_import_status" style="font-size:11px;color:#888;margin-top:6px"></div>
      <div style="margin-top:8px;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">
        <button id="wi_imp_file" style="${BTN_CSS}">📁 从文件选择…</button>
        <button id="wi_imp_append" style="${BTN_PRIMARY_CSS}">追加到末尾</button>
        <button id="wi_imp_replace" style="${BTN_DANGER_CSS}">替换整个世界书</button>
        <button id="wi_imp_close" onclick="(function(e){e.preventDefault();e.stopPropagation();var m=this.closest('#wi_modal_mask');if(m)m.remove();else document.querySelectorAll('#wi_modal_mask').forEach(function(x){x.remove()});}).call(this,event)" style="${BTN_CSS}">取消</button>
      </div>
    `, ($m) => {
      const doImport = async (mode) => {
        const raw = $m.find('#wi_import_area').val() || '';
        if (!raw.trim()) { alert('请粘贴 JSON'); return; }
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          $m.find('#wi_import_status').text('❌ JSON 解析失败：' + e.message).css('color', '#f88');
          return;
        }
        if (!Array.isArray(parsed)) {
          $m.find('#wi_import_status').text('❌ 根节点必须是数组').css('color', '#f88');
          return;
        }
        if (mode === 'replace') {
          if (!confirm(`将用 ${parsed.length} 条替换当前世界书的全部 ${state.entries.length} 条。确定？`)) return;
        }

        const converted = parsed.map((item, i) => {
          const posItem = POSITION_MAP.find(p => p.str === item.positionType)
            || POSITION_MAP.find(p => p.num === item.position)
            || POSITION_MAP[0];
          return {
            uid: Date.now() + i,
            name: item.name || item.comment || `导入条目${i + 1}`,
            content: item.content || '',
            enabled: item.enabled !== false,
            strategy: {
              type: item.strategyType || (item.constant ? 'constant' : 'selective'),
              keys: Array.isArray(item.keys) ? item.keys : (Array.isArray(item.key) ? item.key : []),
              keys_secondary: { logic: 'and_any', keys: [] },
              scan_depth: 'same_as_global'
            },
            position: {
              type: posItem.str,
              role: 'system',
              depth: typeof item.depth === 'number' ? item.depth : (item.position && typeof item.position === 'object' ? item.position.depth : 4),
              order: typeof item.order === 'number' ? item.order : (item.position && typeof item.position === 'object' ? item.position.order : 50),
            },
            probability: 100,
            recursion: { prevent_incoming: false, prevent_outgoing: false, delay_until: null },
            effect: { sticky: null, cooldown: null, delay: null },
            addMemo: true,
            group: '',
            groupOverride: false,
            groupWeight: 100,
            useGroupScoring: false,
            automationId: '',
            ignoreBudget: false,
            outletName: '',
            triggers: [],
            characterFilter: { isExclude: false, names: [], tags: [] }
          };
        });

        pushHistory();

        if (mode === 'replace') {
          state.entries = converted;
        } else {
          state.entries = state.entries.concat(converted);
        }

        await safeSaveWb(state.activeBook, state.entries);
        await loadEntries();
        renderEntryList();
        renderAllPreviews();
        updateMatchCounter();
        document.querySelectorAll('#wi_modal_mask').forEach(el => el.remove());
        alert(`已导入 ${converted.length} 条（${mode === 'replace' ? '替换' : '追加'}）`);
      };

      $('#wi_imp_file').on('click', async () => {
        const picked = await pickJsonFile();
        if (!picked) return;
        $m.find('#wi_import_area').val(picked.text);
        $m.find('#wi_import_status').text(`📄 已读取：${picked.name}（${picked.text.length} 字符）`).css('color', '#8cf');
      });

      $('#wi_imp_append').on('click', () => doImport('append'));
      $('#wi_imp_replace').on('click', () => doImport('replace'));
    });
  }

  // 自动清理残留遮罩
  window.__wiModalCleanupTimer = setInterval(() => {
    const mask = document.getElementById('wi_modal_mask');
    if (!mask) return;
    if (mask.children.length === 0) {
      mask.remove();
      return;
    }
    const first = mask.children[0];
    const s = getComputedStyle(first);
    if (s.display === 'none' || s.visibility === 'hidden' || first.offsetWidth === 0) {
      mask.remove();
    }
  }, 800);

  // ============ 文件下载 / 上传 ============
  function downloadJson(filename, data) {
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (e) {
      err('下载失败', e);
      return false;
    }
  }

  function pickJsonFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.style.display = 'none';
      document.body.appendChild(input);
      input.onchange = () => {
        const file = input.files && input.files[0];
        document.body.removeChild(input);
        if (!file) { resolve(null); return; }
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, text: String(reader.result || '') });
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
      };
      input.click();
    });
  }

  function safeFilename(s) {
    return String(s || 'export').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
  }

  // ★ 兜底：清掉浏览器可能残留的拖拽高亮状态
  //   ★ 只在"确实在拖拽"时才清，避免误伤下拉框等原生弹层
  let __wiWasDragging = false;
  __wiRootDoc.addEventListener('dragstart', () => {
    __wiWasDragging = true;
  }, true);
  function __wiClearDragHighlight() {
    if (!__wiWasDragging) return;   // ← 关键：没拖过就不清
    __wiWasDragging = false;
    try {
      // 触发一次 body 重绘，让 Chromium 刷新拖拽状态
      __wiRootDoc.body.style.pointerEvents = 'none';
      requestAnimationFrame(() => {
        __wiRootDoc.body.style.pointerEvents = '';
      });
    } catch (e) {}
  }
  __wiRootDoc.addEventListener('dragend', __wiClearDragHighlight, true);
  __wiRootDoc.addEventListener('drop', __wiClearDragHighlight, true);
  __wiRootDoc.addEventListener('mouseup', __wiClearDragHighlight, true);

  // ★ 用透明图片替代浏览器默认拖拽预览，避免 Chromium 残留半透明层
  __wiRootDoc.addEventListener('dragstart', function (ev) {
    try {
      if (!ev.dataTransfer) return;
      // 只处理我们自己的拖拽元素（有 wi- 开头 class 的，或者带 data-uid 的）
      const t = ev.target;
      if (!t || !t.closest) return;
      const isOurs = t.closest('.wi-list-item, .wi-th-card, [data-gr-idx], .wi-ch-gr-row, .wi-re-item');
      if (!isOurs) return;

      const blank = __wiRootDoc.createElement('canvas');
      blank.width = 1;
      blank.height = 1;
      ev.dataTransfer.setDragImage(blank, 0, 0);
    } catch (e) {}
  }, true);

  // 全局事件委托（原生 DOM，捕获阶段，不依赖 jQuery）
  function __wiGlobalCloseHandler(e) {
    let el = e.target;
    while (el && el !== document) {
      if (el.hasAttribute && el.hasAttribute('data-wi-close')) {
        const mask = el.closest('#wi_modal_mask');
        if (mask) mask.remove();
        else document.querySelectorAll('#wi_modal_mask').forEach(m => m.remove());
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      el = el.parentElement;
    }
    if (e.target && e.target.id === 'wi_modal_mask') {
      e.target.remove();
    }
  }


  __wiRootDoc.addEventListener('click', __wiGlobalCloseHandler, true);
  __wiRootDoc.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      __wiRootDoc.querySelectorAll('#wi_modal_mask').forEach(el => el.remove());
    }
  }, true);

  (function () {
    if (window.__wiClosePatched) return;
    window.__wiClosePatched = true;

    document.addEventListener('click', function (e) {
      let el = e.target;
      while (el && el !== document) {
        if (el.hasAttribute && el.hasAttribute('data-wi-close')) {
          const mask = el.closest('#wi_modal_mask');
          if (mask) mask.remove();
          else document.querySelectorAll('#wi_modal_mask').forEach(m => m.remove());
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        el = el.parentElement;
      }
      if (e.target && e.target.id === 'wi_modal_mask') {
        e.target.remove();
      }
    }, true);

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        document.querySelectorAll('#wi_modal_mask').forEach(el => el.remove());
      }
    }, true);
  })();

  // 简易模态框
  function showModal(innerHtml, afterRender) {
    document.querySelectorAll('#wi_modal_mask').forEach(el => el.remove());

    setTimeout(() => {
      const masks = document.querySelectorAll('#wi_modal_mask');
      masks.forEach(mask => {
        mask.querySelectorAll('[data-wi-close]').forEach(btn => {
          if (btn.__wiBound) return;
          btn.__wiBound = true;
          btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            const m = this.closest('#wi_modal_mask');
            if (m) m.remove();
            else document.querySelectorAll('#wi_modal_mask').forEach(x => x.remove());
          }, true);
        });
      });
    }, 0);

    const $mask = $('<div id="wi_modal_mask">').css({
      position: 'fixed',
      inset: 0,
      background: 'rgba(0,0,0,.6)',
      zIndex: 1000000,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    });
    const $box = $('<div>').css({
      background: '#1f1f22',
      border: '1px solid #444',
      borderRadius: '8px',
      padding: '14px',
      width: '600px',
      maxWidth: '92vw',
      maxHeight: '85vh',
      overflow: 'auto',
      color: '#ddd',
      boxShadow: '0 8px 32px rgba(0,0,0,.6)',
    }).html(innerHtml);
    $mask.append($box);
    $('body').append($mask);

    window.__wiCloseModal = () => {
      const m = document.getElementById('wi_modal_mask');
      if (m) m.remove();
    };

    if (afterRender) {
      try {
        afterRender($box);
      } catch (e) {
        console.error('[WI编辑器] afterRender 出错:', e);
      }
    }
    return $box;
  }

  // ============ WI 面板主题系统 ============
  const WI_THEMES = {
    paper: {
      name: '素纸',
      vars: {
        '--wi-bg': '#faf8f4',
        '--wi-bg-2': '#f2ede4',
        '--wi-bg-3': '#e9e2d5',
        '--wi-border': '#d8cfbc',
        '--wi-border-strong': '#c4b89f',
        '--wi-fg': '#3a3226',
        '--wi-fg-2': '#6b5d4f',
        '--wi-fg-dim': '#9a8d7c',
        '--wi-accent': '#8b7355',
        '--wi-accent-2': '#a89070',
        '--wi-accent-fg': '#ffffff',
        '--wi-primary-bg': '#8b7355',
        '--wi-primary-fg': '#ffffff',
        '--wi-danger-bg': '#a85c5c',
        '--wi-danger-fg': '#ffffff',
        '--wi-hover': '#ede6d8',
        '--wi-selected': '#e3dac7',
        '--wi-shadow': 'rgba(58, 50, 38, 0.08)',
      },
    },
    mist: {
      name: '雾蓝',
      vars: {
        '--wi-bg': '#f5f7fa',
        '--wi-bg-2': '#ebeef3',
        '--wi-bg-3': '#dfe4ec',
        '--wi-border': '#ccd4de',
        '--wi-border-strong': '#b3bec9',
        '--wi-fg': '#2c3440',
        '--wi-fg-2': '#5b6675',
        '--wi-fg-dim': '#8d98a8',
        '--wi-accent': '#5b7c99',
        '--wi-accent-2': '#7899b5',
        '--wi-accent-fg': '#ffffff',
        '--wi-primary-bg': '#5b7c99',
        '--wi-primary-fg': '#ffffff',
        '--wi-danger-bg': '#9e5e6b',
        '--wi-danger-fg': '#ffffff',
        '--wi-hover': '#e4e9f0',
        '--wi-selected': '#d8e0ea',
        '--wi-shadow': 'rgba(44, 52, 64, 0.08)',
      },
    },
    celadon: {
      name: '青瓷',
      vars: {
        '--wi-bg': '#f6f9f7',
        '--wi-bg-2': '#ebf1ee',
        '--wi-bg-3': '#dfe8e3',
        '--wi-border': '#c9d8d0',
        '--wi-border-strong': '#aec3b9',
        '--wi-fg': '#25332d',
        '--wi-fg-2': '#566860',
        '--wi-fg-dim': '#879a91',
        '--wi-accent': '#5d8a7a',
        '--wi-accent-2': '#7aa895',
        '--wi-accent-fg': '#ffffff',
        '--wi-primary-bg': '#5d8a7a',
        '--wi-primary-fg': '#ffffff',
        '--wi-danger-bg': '#a06262',
        '--wi-danger-fg': '#ffffff',
        '--wi-hover': '#e3ece7',
        '--wi-selected': '#d5e3dc',
        '--wi-shadow': 'rgba(37, 51, 45, 0.08)',
      },
    },
    lotus: {
      name: '藕荷',
      vars: {
        '--wi-bg': '#faf7f9',
        '--wi-bg-2': '#f2ebf0',
        '--wi-bg-3': '#e8dde5',
        '--wi-border': '#d9c9d4',
        '--wi-border-strong': '#c2aeba',
        '--wi-fg': '#3b2c35',
        '--wi-fg-2': '#6d5766',
        '--wi-fg-dim': '#9d8a97',
        '--wi-accent': '#9a7a94',
        '--wi-accent-2': '#b394ad',
        '--wi-accent-fg': '#ffffff',
        '--wi-primary-bg': '#9a7a94',
        '--wi-primary-fg': '#ffffff',
        '--wi-danger-bg': '#a86070',
        '--wi-danger-fg': '#ffffff',
        '--wi-hover': '#ede1e9',
        '--wi-selected': '#e2d2dd',
        '--wi-shadow': 'rgba(59, 44, 53, 0.08)',
      },
    },
  };

  let __wiTheme = localStorage.getItem('wi_panel_theme') || 'paper';
  function applyWiTheme(themeKey) {
    if (!WI_THEMES[themeKey]) themeKey = 'paper';
    __wiTheme = themeKey;
    localStorage.setItem('wi_panel_theme', themeKey);
    const vars = WI_THEMES[themeKey].vars;
    // ★ 挂到面板元素（主容器）上
    const panelEl = __wiRootDoc.getElementById('wi_live_editor_panel');
    if (panelEl) {
      Object.entries(vars).forEach(([k, v]) => panelEl.style.setProperty(k, v));
    }
    // ★ 也挂到 body 上：让挂在 body 下的 #wi_modal_mask 能读到变量
    //   （body 不影响酒馆主题，酒馆主题读的是 <html> 上的变量）
    const bodyEl = __wiRootDoc.body;
    if (bodyEl) {
      Object.entries(vars).forEach(([k, v]) => bodyEl.style.setProperty(k, v));
    }
  }

  // 注入一段 CSS，覆盖面板内部所有深色残留
  function injectWiThemeCSS() {
    if (__wiRootDoc.getElementById('wi_theme_override_css')) return;
    const style = __wiRootDoc.createElement('style');
    style.id = 'wi_theme_override_css';
    style.textContent = `
      /* ============ WI 面板 · 覆盖内联深色 ============ */
      
      /* 面板内所有元素默认继承主题色 */
      #wi_live_editor_panel,
      #wi_live_editor_panel * {
        color: var(--wi-fg);
      }


      /* ★ 弹窗（#wi_modal_mask 挂在 body 上，不在面板内）也纳入主题 */
      #wi_modal_mask,
      #wi_modal_mask * {
        color: var(--wi-fg);
      }

      #wi_modal_mask [style*="background:#1f1f22"],
      #wi_modal_mask [style*="background: #1f1f22"],
      #wi_modal_mask [style*="background:#222225"],
      #wi_modal_mask [style*="background: #222225"],
      #wi_modal_mask [style*="background:#1a1a1d"],
      #wi_modal_mask [style*="background: #1a1a1d"],
      #wi_modal_mask [style*="background:#1c1c20"],
      #wi_modal_mask [style*="background: #1c1c20"],
      #wi_modal_mask [style*="background:#232326"],
      #wi_modal_mask [style*="background: #232326"],
      #wi_modal_mask [style*="background:#252528"],
      #wi_modal_mask [style*="background: #252528"],
      #wi_modal_mask [style*="background:#2a2a30"],
      #wi_modal_mask [style*="background: #2a2a30"] {
        background: var(--wi-bg-2) !important;
      }

      #wi_modal_mask [style*="color:#ddd"],
      #wi_modal_mask [style*="color: #ddd"],
      #wi_modal_mask [style*="color:#eee"],
      #wi_modal_mask [style*="color: #eee"],
      #wi_modal_mask [style*="color:#ccc"],
      #wi_modal_mask [style*="color: #ccc"] {
        color: var(--wi-fg) !important;
      }

      #wi_modal_mask [style*="color:#aaa"],
      #wi_modal_mask [style*="color: #aaa"],
      #wi_modal_mask [style*="color:#bbb"],
      #wi_modal_mask [style*="color: #bbb"],
      #wi_modal_mask [style*="color:#888"],
      #wi_modal_mask [style*="color: #888"] {
        color: var(--wi-fg-2) !important;
      }

      #wi_modal_mask [style*="color:#666"],
      #wi_modal_mask [style*="color: #666"],
      #wi_modal_mask [style*="color:#777"],
      #wi_modal_mask [style*="color: #777"] {
        color: var(--wi-fg-dim) !important;
      }

      #wi_modal_mask [style*="border:1px solid #444"],
      #wi_modal_mask [style*="border: 1px solid #444"],
      #wi_modal_mask [style*="border:1px solid #3a3a3a"],
      #wi_modal_mask [style*="border: 1px solid #3a3a3a"] {
        border-color: var(--wi-border) !important;
      }

      /* 弹窗里 pre 也应用主题 */
      #wi_modal_mask pre {
        background: var(--wi-bg-3) !important;
        color: var(--wi-fg-2) !important;
        border-color: var(--wi-border) !important;
      }

      /* 左侧列表面板 */
      #wi_list,
      #wi_re_list,
      #wi_ch_fieldlist,
      #wi_sc_list,
      #wi_th_list,
      #wi_ch_greeting_list {
        background: var(--wi-bg-2) !important;
        color: var(--wi-fg) !important;
      }

      /* 所有 Tab 内容的深色横条（工具栏、搜索栏、批量栏） */
      #wi_live_editor_panel [style*="background:#252528"],
      #wi_live_editor_panel [style*="background: #252528"],
      #wi_live_editor_panel [style*="background:#232326"],
      #wi_live_editor_panel [style*="background: #232326"],
      #wi_live_editor_panel [style*="background:#1c1c20"],
      #wi_live_editor_panel [style*="background: #1c1c20"],
      #wi_live_editor_panel [style*="background:#1f1f1f"],
      #wi_live_editor_panel [style*="background: #1f1f1f"],
      #wi_live_editor_panel [style*="background:#2a2a30"],
      #wi_live_editor_panel [style*="background: #2a2a30"],
      #wi_live_editor_panel [style*="background:#222225"],
      #wi_live_editor_panel [style*="background: #222225"],
      #wi_live_editor_panel [style*="background:#1a1a1d"],
      #wi_live_editor_panel [style*="background: #1a1a1d"],
      #wi_live_editor_panel [style*="background:#161618"],
      #wi_live_editor_panel [style*="background: #161618"],
      #wi_live_editor_panel [style*="background:#1f1f22"],
      #wi_live_editor_panel [style*="background: #1f1f22"] {
        background: var(--wi-bg-2) !important;
      }

      /* 列表项（条目/正则/脚本等） */
      #wi_live_editor_panel .wi-list-item,
      #wi_live_editor_panel .wi-re-item,
      #wi_live_editor_panel .wi-th-card,
      #wi_live_editor_panel .wi-wb-group-header,
      #wi_live_editor_panel .wi-re-group-header,
      #wi_live_editor_panel .wi-th-group-header {
        border-color: var(--wi-border) !important;
      }

      /* 选中的列表项 */
      #wi_live_editor_panel .wi-list-item[style*="#3a3a44"],
      #wi_live_editor_panel .wi-list-item[style*="background:#3a3a44"],
      #wi_live_editor_panel .wi-re-item[style*="background:#3a3a44"] {
        background: var(--wi-selected) !important;
      }

      /* 文字颜色修正：把深色主题里的白字/灰字统一到主题色 */
      #wi_live_editor_panel [style*="color:#ddd"],
      #wi_live_editor_panel [style*="color: #ddd"],
      #wi_live_editor_panel [style*="color:#eee"],
      #wi_live_editor_panel [style*="color: #eee"],
      #wi_live_editor_panel [style*="color:#ccc"],
      #wi_live_editor_panel [style*="color: #ccc"] {
        color: var(--wi-fg) !important;
      }

      #wi_live_editor_panel [style*="color:#aaa"],
      #wi_live_editor_panel [style*="color: #aaa"],
      #wi_live_editor_panel [style*="color:#bbb"],
      #wi_live_editor_panel [style*="color: #bbb"],
      #wi_live_editor_panel [style*="color:#888"],
      #wi_live_editor_panel [style*="color: #888"] {
        color: var(--wi-fg-2) !important;
      }

      #wi_live_editor_panel [style*="color:#666"],
      #wi_live_editor_panel [style*="color: #666"],
      #wi_live_editor_panel [style*="color:#777"],
      #wi_live_editor_panel [style*="color: #777"] {
        color: var(--wi-fg-dim) !important;
      }

      /* 边框统一 */
      #wi_live_editor_panel [style*="border-bottom:1px solid #333"],
      #wi_live_editor_panel [style*="border-bottom: 1px solid #333"],
      #wi_live_editor_panel [style*="border-bottom:1px #444 solid"],
      #wi_live_editor_panel [style*="border-bottom:1px solid #444"],
      #wi_live_editor_panel [style*="border-top:1px solid #444"],
      #wi_live_editor_panel [style*="border:1px solid #444"],
      #wi_live_editor_panel [style*="border:1px #444 solid"],
      #wi_live_editor_panel [style*="border:1px solid #3a3a3a"],
      #wi_live_editor_panel [style*="border: 1px solid #3a3a3a"] {
        border-color: var(--wi-border) !important;
      }

      /* 搜索/批量栏里的按钮，保持浅色 */
      #wi_live_editor_panel #wi_search_bar,
      #wi_live_editor_panel #wi_batch_bar {
        background: var(--wi-bg-2) !important;
        border-color: var(--wi-border) !important;
      }

      /* 主容器里那些深色背景的横条 */
      #wi_tab_content_worldbook > div:first-child,
      #wi_tab_content_regex > div:first-child,
      #wi_tab_content_character > div:first-child,
      #wi_tab_content_script > div:first-child,
      #wi_tab_content_theme > div:first-child {
        background: var(--wi-bg-2) !important;
        border-bottom-color: var(--wi-border) !important;
      }

      /* 右侧编辑区、预览区 */
      #wi_content_preview,
      #wi_keys_preview,
      #wi_th_edit_css,
      #wi_sc_code {
        background: var(--wi-bg-2) !important;
        color: var(--wi-fg-2) !important;
        border-color: var(--wi-border) !important;
      }

      /* 滚动条 */
      #wi_live_editor_panel ::-webkit-scrollbar {
        width: 8px;
        height: 8px;
      }
      #wi_live_editor_panel ::-webkit-scrollbar-track {
        background: var(--wi-bg-2);
      }
      #wi_live_editor_panel ::-webkit-scrollbar-thumb {
        background: var(--wi-border-strong);
        border-radius: 4px;
      }
      #wi_live_editor_panel ::-webkit-scrollbar-thumb:hover {
        background: var(--wi-accent-2);
      }
    `;
    __wiRootDoc.head.appendChild(style);
    console.log('[WI编辑器] 主题覆盖 CSS 已注入');
  }

  // 页面加载时注入一次
  injectWiThemeCSS();
  // 首次应用延后到面板建好之后（见 buildUI 末尾）

  // ============ 加载 CodeMirror ============
  const __wiCodeMirrorBase = 'https://cdn.jsdelivr.net/npm/codemirror@5.65.16/';
  window.__wiCodeMirrorReady = (async () => {
    const loadResource = (url, type) => new Promise((resolve, reject) => {
      if (type === 'css') {
        const link = __wiRootDoc.createElement('link');
        link.rel = 'stylesheet';
        link.href = url;
        link.onload = resolve;
        link.onerror = reject;
        __wiRootDoc.head.appendChild(link);
      } else {
        const s = __wiRootDoc.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = reject;
        __wiRootDoc.head.appendChild(s);
      }
    });
    try {
      // 检查是否已经加载过
      const w = (window.top && window.top !== window) ? window.top : window;
      if (typeof w.CodeMirror === 'function') {
        console.log('[WI编辑器] CodeMirror 已存在，跳过加载');
        return;
      }
      await loadResource(__wiCodeMirrorBase + 'lib/codemirror.min.js', 'js');
      await loadResource(__wiCodeMirrorBase + 'lib/codemirror.min.css', 'css');
      await loadResource(__wiCodeMirrorBase + 'mode/javascript/javascript.min.js', 'js');
      await loadResource(__wiCodeMirrorBase + 'addon/edit/matchbrackets.min.js', 'js');
      await loadResource(__wiCodeMirrorBase + 'addon/edit/closebrackets.min.js', 'js');
      console.log('[WI编辑器] CodeMirror 加载完成，版本:', w.CodeMirror.version);
    } catch (e) {
      console.error('[WI编辑器] CodeMirror 加载失败:', e);
    }
  })();

  // ============ 加载 diff-match-patch（文本对比） ============
  window.__wiDiffReady = (async () => {
    try {
      const w = (window.top && window.top !== window) ? window.top : window;
      if (typeof w.diff_match_patch === 'function') {
        console.log('[WI编辑器] diff-match-patch 已存在');
        return;
      }
      await new Promise((resolve, reject) => {
        const s = __wiRootDoc.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/diff-match-patch@1.0.5/index.js';
        s.onload = resolve;
        s.onerror = reject;
        __wiRootDoc.head.appendChild(s);
      });
      console.log('[WI编辑器] diff-match-patch 加载完成');
    } catch (e) {
      console.error('[WI编辑器] diff-match-patch 加载失败:', e);
    }
  })();

  // ============ 加载 js-beautify（代码格式化） ============
  window.__wiBeautifyReady = (async () => {
    const loadScript = (url) => new Promise((resolve, reject) => {
      const s = __wiRootDoc.createElement('script');
      s.src = url;
      s.onload = resolve;
      s.onerror = reject;
      __wiRootDoc.head.appendChild(s);
    });
    try {
      const w = (window.top && window.top !== window) ? window.top : window;
      if (typeof w.js_beautify === 'function') {
        console.log('[WI编辑器] js-beautify 已存在');
        return;
      }
      await loadScript('https://cdn.jsdelivr.net/npm/js-beautify@1.15.1/js/lib/beautify.min.js');
      console.log('[WI编辑器] js-beautify 加载完成');
    } catch (e) {
      console.error('[WI编辑器] js-beautify 加载失败:', e);
    }
  })();

  // ★ WI 面板设置（持久化到 localStorage）
  const WI_SETTINGS_KEY = 'wi_panel_settings';
  function loadWiSettings() {
    try {
      const raw = localStorage.getItem(WI_SETTINGS_KEY);
      if (raw) return Object.assign({ showFloatingBtn: true, showExtEntry: true }, JSON.parse(raw));
    } catch (e) {}
    return { showFloatingBtn: true, showExtEntry: true };
  }
  function saveWiSettings(s) {
    try { localStorage.setItem(WI_SETTINGS_KEY, JSON.stringify(s)); } catch (e) {}
  }
  function loadPanelLayout() {
    try {
      const raw = localStorage.getItem('wi_panel_layout');
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  }
  function savePanelLayout(layout) {
    try { localStorage.setItem('wi_panel_layout', JSON.stringify(layout)); } catch (e) {}
  }

  function loadPanelPosition() {
    try {
      const raw = localStorage.getItem('wi_panel_position');
      if (raw) return JSON.parse(raw);
    } catch (e) {}
    return null;
  }
  function savePanelPosition(pos) {
    try { localStorage.setItem('wi_panel_position', JSON.stringify(pos)); } catch (e) {}
  }
  function applyPanelPosition() {
    const layout = loadPanelLayout();
    const $p = $(`#${PANEL_ID}`);
    if (!$p.length) return;
    if (!layout) return;
    const css = {};
    if (typeof layout.left === 'number' && typeof layout.top === 'number') {
      css.right = 'auto';
      css.bottom = 'auto';
      css.left = layout.left + 'px';
      css.top = layout.top + 'px';
    }
    if (typeof layout.width === 'number') css.width = layout.width + 'px';
    if (typeof layout.height === 'number') css.height = layout.height + 'px';
    if (Object.keys(css).length) $p.css(css);
  }

  function applyWiSettings() {
    const s = loadWiSettings();
    const $btn = $(`#${BTN_ID}`);
    if ($btn.length) {
      $btn.css('display', s.showFloatingBtn ? '' : 'none');
    }
  }

  // ★ 注入到酒馆"扩展面板"（点 🧩 图标后那个页面）
  function injectIntoExtensionsPanel() {
    if (__wiRootDoc.getElementById('wi_ext_drawer')) return true; // 已注入
    // ★ 用户关掉了扩展面板入口，不注入
    const _s = loadWiSettings();
    if (_s.showExtEntry === false) return true; // 视为"处理完"，避免轮询

    // 找右栏容器
    const target = __wiRootDoc.getElementById('extensions_settings2')
                || __wiRootDoc.getElementById('extensions_settings');
    if (!target) return false; // 没找到，下次重试

    const html = `
      <div id="wi_ext_drawer" class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>PsychoWI</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down interactable"></div>
        </div>
        <div class="inline-drawer-content" style="display:none">
          <div style="padding:8px 0;font-size:0.9em;line-height:1.6">
            <p style="margin:0 0 10px;color:var(--SmartThemeBodyColor);font-size:0.85em">
              详细设置请在面板内 → ⚙️ 设置 Tab 里调整。
            </p>
            <button id="wi_ext_open_btn" class="menu_button" style="width:100%">打开 WI 编辑器</button>
          </div>
        </div>
      </div>`;
    target.insertAdjacentHTML('beforeend', html);

    // 绑定"打开面板"
    const openBtn = __wiRootDoc.getElementById('wi_ext_open_btn');
    if (openBtn) {
      openBtn.addEventListener('click', () => {
        const $panel = $(`#${PANEL_ID}`);
        if ($panel.length) $panel.css('display', 'flex');
      });
    }
    console.log('[WI编辑器] 已注入到酒馆扩展面板');
    return true;
  }

  // ★ 轮询等待扩展面板出现，出现后注入
  (function tryInjectExtPanel(retries = 0) {
    if (injectIntoExtensionsPanel()) return;
    if (retries < 60) {
      setTimeout(() => tryInjectExtPanel(retries + 1), 500);
    }
  })();

  function buildUI() {
    if ($(`#${PANEL_ID}`).length) return;
    const $btn = $('<button>')
      .attr('id', BTN_ID)
      .text('WI 编辑')
      .attr('style', 'position:fixed;right:0;top:50%;transform:translateY(-50%);z-index:9999;' +
        'writing-mode:vertical-rl;text-orientation:upright;letter-spacing:2px;' +
        'padding:14px 6px;border-radius:8px 0 0 8px;' +
        'background:var(--wi-primary-bg);color:var(--wi-primary-fg);' +
        'border:1px solid var(--wi-primary-bg);border-right:none;' +
        'cursor:pointer;font-size:12px;font-weight:500;' +
        'box-shadow:-2px 0 8px var(--wi-shadow);' +
        'transition:background .15s,box-shadow .15s;')
      .click(togglePanel);
    $('body').append($btn);

    const $panel = $(`
    <div id="${PANEL_ID}" class="wi-theme-${__wiTheme}" style="display:none;position:fixed;right:16px;bottom:52px;width:780px;height:82vh;
    background:var(--wi-bg);color:var(--wi-fg);border:1px solid var(--wi-border-strong);border-radius:10px;z-index:9998;
    flex-direction:column;overflow:hidden;box-shadow:0 12px 40px var(--wi-shadow)">

      <div id="wi_tab_bar" style="padding:0;border-bottom:1px solid var(--wi-border);background:var(--wi-bg-2);display:flex;gap:0;flex-shrink:0;align-items:center;cursor:grab">
        <span style="padding:0 10px 0 14px;font-size:12px;color:var(--wi-fg-dim);font-weight:600;letter-spacing:0.5px;user-select:none;border-right:1px solid var(--wi-border);margin-right:4px">PsychoWI</span>
        <div class="wi-tab" data-tab="worldbook" style="padding:10px 16px;cursor:pointer;font-size:12px;color:var(--wi-accent);border-bottom:2px solid var(--wi-accent);transition:all .15s;user-select:none">📚 世界书</div>
        <div class="wi-tab" data-tab="regex" style="padding:10px 16px;cursor:pointer;font-size:12px;color:var(--wi-fg-dim);border-bottom:2px solid transparent;transition:all .15s;user-select:none">🔣 正则</div>
        <div class="wi-tab" data-tab="character" style="padding:10px 16px;cursor:pointer;font-size:12px;color:var(--wi-fg-dim);border-bottom:2px solid transparent;transition:all .15s;user-select:none">🎭 角色卡</div>
        <div class="wi-tab" data-tab="script" style="padding:10px 16px;cursor:pointer;font-size:12px;color:var(--wi-fg-dim);border-bottom:2px solid transparent;transition:all .15s;user-select:none">📜 脚本</div>
        <div class="wi-tab" data-tab="theme" style="padding:10px 16px;cursor:pointer;font-size:12px;color:var(--wi-fg-dim);border-bottom:2px solid transparent;transition:all .15s;user-select:none">🎨 主题</div>
        <div class="wi-tab" data-tab="settings" style="padding:10px 16px;cursor:pointer;font-size:12px;color:var(--wi-fg-dim);border-bottom:2px solid transparent;transition:all .15s;user-select:none">⚙️ 设置</div>
        <span style="flex:1"></span>
        <button id="wi_theme_btn" style="padding:5px 10px;background:var(--wi-bg-2);color:var(--wi-fg-2);border:1px solid var(--wi-border);border-radius:6px;cursor:pointer;font-size:12px;margin:6px 2px" title="切换主题">🎨</button>
        <button id="wi_fullscreen" style="padding:5px 10px;background:var(--wi-bg-2);color:var(--wi-fg-2);border:1px solid var(--wi-border);border-radius:6px;cursor:pointer;font-size:12px;margin:6px 2px" title="全屏 (Esc 退出)">⛶</button>
        <button id="wi_close" style="padding:5px 10px;background:var(--wi-bg-2);color:var(--wi-fg-2);border:1px solid var(--wi-border);border-radius:6px;cursor:pointer;font-size:12px;margin:6px 8px 6px 2px">✕</button>
      </div>

      <div id="wi_tab_content_worldbook" style="display:flex;flex-direction:column;flex:1;overflow:hidden">
        <div style="padding:8px;border-bottom:1px #444 solid;display:flex;gap:8px;align-items:center;background:#252528;flex-wrap:wrap">
          <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" id="wi_follow_char">跟随角色</label>
          <button id="wi_book_select_btn" style="${INPUT_CSS}flex:1;min-width:120px;text-align:left;cursor:pointer;display:flex;align-items:center;justify-content:space-between;gap:6px">
            <span id="wi_book_select_label" style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">(加载中…)</span>
            <span style="color:var(--wi-fg-dim);font-size:10px">▼</span>
          </button>
          <select id="wi_book_select" style="display:none"></select>
          <button id="wi_refresh" style="${BTN_CSS}">刷新</button>
          <button id="wi_undo" style="${BTN_CSS}" disabled>↶ 撤销</button>
          <button id="wi_export_btn" style="${BTN_CSS}">📤</button>
          <button id="wi_import_btn" style="${BTN_CSS}">📥</button>
          <button id="wi_search_toggle" style="${BTN_CSS}">🔍</button>
          <button id="wi_batch_toggle" style="${BTN_CSS}">☑ 批量</button>
          <button id="wi_wb_group_toggle" style="${BTN_CSS}" title="切换分组视图">📁 分组</button>
        </div>
        <div id="wi_search_bar" style="display:none;padding:8px;border-bottom:1px solid #444;background:#252528;gap:6px;flex-direction:column">
          <div style="display:flex;gap:6px;align-items:center">
            <input id="wi_search_input" placeholder="搜索：关键词 / 正文" style="${INPUT_CSS}flex:1">
            <label style="font-size:11px;color:#aaa;display:flex;align-items:center;gap:4px;cursor:pointer;white-space:nowrap">
              <input type="checkbox" id="wi_search_regex"> 正则
            </label>
            <button id="wi_search_prev" style="${BTN_NAV_CSS}" title="上一个匹配 (Shift+Enter)">▲</button>
            <button id="wi_search_next" style="${BTN_NAV_CSS}" title="下一个匹配 (Enter)">▼</button>
            <span id="wi_match_counter" style="font-size:11px;color:#aaa;min-width:70px;text-align:center">0 / 0</span>
          </div>
          <div style="display:flex;gap:6px;align-items:center">
            <input id="wi_replace_input" placeholder="替换为…" style="${INPUT_CSS}flex:1">
            <button id="wi_replace_one" style="${BTN_CSS}">替换当前</button>
            <button id="wi_replace_btn" style="${BTN_DANGER_CSS}">全部替换</button>
            <button id="wi_search_clear" style="${BTN_CSS}">清空</button>
          </div>
          <div id="wi_search_status" style="font-size:11px;color:#888;padding-top:2px"></div>
        </div>
        <div id="wi_batch_bar" style="display:none;padding:6px 8px;border-bottom:1px solid #444;background:#232326;gap:6px;align-items:center;font-size:11px;flex-wrap:wrap">
          <span style="color:#aaa">已选 <span id="wi_batch_count">0</span> / <span id="wi_batch_total">0</span></span>
          <button id="wi_batch_select_all" style="${BTN_CSS}font-size:11px">全选</button>
          <button id="wi_batch_select_none" style="${BTN_CSS}font-size:11px">全不选</button>
          <button id="wi_batch_select_invert" style="${BTN_CSS}font-size:11px">反选</button>
          <span style="flex:1"></span>
          <button id="wi_batch_export" style="${BTN_CSS}font-size:11px">📤 导出选中</button>
          <button id="wi_batch_enable" style="padding:5px 12px;background:#5c8a5c;color:#fff;border:1px solid #5c8a5c;border-radius:6px;cursor:pointer;font-size:11px;font-weight:500">启用选中</button>
          <button id="wi_batch_disable" style="${BTN_DANGER_CSS}font-size:11px">禁用选中</button>
        </div>
        <div style="display:flex;flex:1;overflow:hidden">
          <div id="wi_list" style="width:260px;overflow-y:auto;border-right:1px solid var(--wi-border);background:var(--wi-bg-2);transition:width .2s"></div>
          <div style="flex:1;padding:10px;overflow-y:auto">
            <div style="${LABEL_CSS}">标题 (name)</div>
            <input id="wi_name" style="${INPUT_CSS}">
            <div style="${LABEL_CSS}">正文 (content)</div>
            <textarea id="wi_content" style="${INPUT_CSS}height:120px;resize:vertical;font-family:inherit;line-height:${LINE_HEIGHT}px"></textarea>
            <div id="wi_content_preview" style="${PREVIEW_CSS}line-height:${LINE_HEIGHT}px;display:none"></div>
            <div style="${LABEL_CSS}">关键词 (strategy.keys，逗号分隔)</div>
            <input id="wi_keys" style="${INPUT_CSS}">
            <div id="wi_keys_preview" style="${PREVIEW_CSS}line-height:${LINE_HEIGHT}px;display:none"></div>
            <div style="${LABEL_CSS}">插入位置 (position.type)</div>
            <select id="wi_pos" style="${INPUT_CSS}"></select>
            <div style="${LABEL_CSS}">触发类型 (strategy.type)</div>
            <select id="wi_strategy" style="${INPUT_CSS}">
              <option value="constant">🔵 常驻 (constant)</option>
              <option value="selective">🟢 关键词触发 (selective)</option>
            </select>
            <div style="${LABEL_CSS}">
              深度 (position.depth)
              <span id="wi_depth_hint" style="color:#888;font-weight:normal;margin-left:4px"></span>
            </div>
            <input type="number" id="wi_depth" min="0" max="999" style="${INPUT_CSS}">
            <div style="${LABEL_CSS}">排序 (position.order)</div>
            <input type="number" id="wi_order" min="0" style="${INPUT_CSS}">
            <label style="display:flex;align-items:center;gap:6px;margin-top:10px;font-size:12px;cursor:pointer">
              <input type="checkbox" id="wi_enabled">启用条目
            </label>
            <label style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;cursor:pointer" title="防止进一步递归：这条触发后，不再用这条的内容去触发别的条目">
              <input type="checkbox" id="wi_prevent_outgoing">防止进一步递归
            </label>
            <label style="display:flex;align-items:center;gap:6px;margin-top:6px;font-size:12px;cursor:pointer" title="不可递归：这条不会被其他条目递归触发">
              <input type="checkbox" id="wi_prevent_incoming">不可递归
            </label>
            <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">
              <button id="wi_new_entry" style="${BTN_CSS}">新建条目</button>
              <button id="wi_del_entry" style="${BTN_DANGER_CSS}">删除条目</button>
            </div>
          </div>
        </div>
      </div>

      <div id="wi_tab_content_regex" style="display:none;flex-direction:column;flex:1;overflow:hidden">
        <div style="padding:8px;border-bottom:1px #444 solid;display:flex;gap:8px;align-items:center;background:#252528;flex-wrap:wrap">
          <input id="wi_re_search" placeholder="🔍 筛选正则名称 / 表达式" style="${INPUT_CSS}flex:1;min-width:140px">
          <span id="wi_re_count" style="font-size:11px;color:#888;white-space:nowrap">0 条</span>
          <button id="wi_re_new" style="${BTN_PRIMARY_CSS}">＋ 新建</button>
          <button id="wi_re_refresh" style="${BTN_CSS}">刷新</button>
        </div>
        <div style="display:flex;flex:1;overflow:hidden">
          <div id="wi_re_list" style="width:280px;overflow-y:auto;border-right:1px solid var(--wi-border);background:var(--wi-bg-2)"></div>
          <div style="flex:1;padding:10px;overflow-y:auto">
            <div style="${LABEL_CSS}">名称 (scriptName)</div>
            <input id="wi_re_name" style="${INPUT_CSS}">
            <div style="${LABEL_CSS}">查找正则 (findRegex)</div>
            <textarea id="wi_re_find" style="${INPUT_CSS}height:70px;resize:vertical;font-family:monospace;font-size:12px;line-height:${LINE_HEIGHT}px"></textarea>
            <div id="wi_re_find_status" style="font-size:11px;color:#888;margin-top:3px"></div>
            <div style="${LABEL_CSS}">替换为 (replaceString)</div>
            <textarea id="wi_re_replace" style="${INPUT_CSS}height:90px;resize:vertical;font-family:monospace;font-size:12px;line-height:${LINE_HEIGHT}px"></textarea>
            <div style="${LABEL_CSS}">作用域 (placement，可多选)</div>
            <div id="wi_re_placement" style="display:flex;flex-wrap:wrap;gap:10px;padding:6px 0">
              <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" class="wi-re-place" value="1">用户输入</label>
              <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" class="wi-re-place" value="2">AI 输出</label>
              <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" class="wi-re-place" value="3">斜杠命令</label>
              <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" class="wi-re-place" value="4">世界书</label>
              <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" class="wi-re-place" value="5">推理</label>
              <label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" class="wi-re-place" value="6">快速回复</label>
            </div>
            <div style="${LABEL_CSS}">深度范围 (minDepth / maxDepth，留空=不限制)</div>
            <div style="display:flex;gap:8px;align-items:center">
              <input type="number" id="wi_re_mindepth" placeholder="min" style="${INPUT_CSS}flex:1">
              <span style="color:#888">~</span>
              <input type="number" id="wi_re_maxdepth" placeholder="max" style="${INPUT_CSS}flex:1">
            </div>
            <div style="${LABEL_CSS}">选项</div>
            <div style="display:flex;flex-direction:column;gap:6px">
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
                <input type="checkbox" id="wi_re_enabled">启用（取消勾选 = disabled）
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
                <input type="checkbox" id="wi_re_runonedit">编辑消息时也运行 (runOnEdit)
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
                <input type="checkbox" id="wi_re_markdownonly">仅显示效果 (markdownOnly)
              </label>
              <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
                <input type="checkbox" id="wi_re_promptonly">仅作用于提示词 (promptOnly)
              </label>
            </div>
            <div id="wi_re_meta" style="margin-top:10px;font-size:11px;color:#666"></div>
            <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">
              <button id="wi_re_dup" style="${BTN_CSS}">复制条目</button>
              <button id="wi_re_del" style="${BTN_DANGER_CSS}">删除条目</button>
              <button id="wi_re_sync" style="${BTN_PRIMARY_CSS}" title="立即写回酒馆并重新应用正则（官方 API 会自动同步原生面板）">💾 立即应用</button>
            </div>
          </div>
        </div>
      </div>

      <div id="wi_tab_content_character" style="display:none;flex-direction:column;flex:1;overflow:hidden">
        <div style="padding:8px;border-bottom:1px #444 solid;display:flex;gap:8px;align-items:center;background:#252528;flex-wrap:wrap">
          <span style="font-size:12px;color:#aaa;white-space:nowrap">角色卡</span>
          <select id="wi_ch_select" style="${INPUT_CSS}flex:1;min-width:150px;color-scheme:light"></select>
          <button id="wi_ch_reload" style="${BTN_CSS}">🔄 重载</button>
          <button id="wi_ch_undo" style="${BTN_CSS}" disabled>↶ 撤销</button>
          <button id="wi_ch_hotupdate" style="${BTN_PRIMARY_CSS}">🔄 热更新</button>
        </div>
        <div id="wi_ch_status" style="padding:4px 10px;font-size:11px;color:#666;background:#1c1c20;border-bottom:1px solid #333"></div>
        <div style="display:flex;flex:1;overflow:hidden">
          <div id="wi_ch_fieldlist" style="width:180px;overflow-y:auto;border-right:1px solid var(--wi-border);background:var(--wi-bg-2)"></div>
          <div style="flex:1;padding:10px;overflow-y:auto">
            <div id="wi_ch_empty" style="color:#888;text-align:center;padding:60px 20px;font-size:13px">
              <div style="font-size:32px;margin-bottom:12px">🎭</div>
              <div>请在上方选择一个角色卡</div>
            </div>
            <div id="wi_ch_editor" style="display:none">
              <div id="wi_ch_field_title" style="font-size:14px;font-weight:700;color:#ddd;margin-bottom:8px"></div>
              <div id="wi_ch_field_hint" style="font-size:11px;color:#888;margin-bottom:8px"></div>
              <div id="wi_ch_single">
                <textarea id="wi_ch_field_input" style="${INPUT_CSS}height:320px;resize:vertical;font-family:inherit;line-height:${LINE_HEIGHT}px"></textarea>
                <div id="wi_ch_char_count" style="font-size:11px;color:#888;margin-top:4px;text-align:right"></div>
              </div>
              <div id="wi_ch_greetings" style="display:none">
                <div id="wi_ch_greeting_list"></div>
                <button id="wi_ch_greeting_add" style="${BTN_PRIMARY_CSS}margin-top:10px;width:100%">＋ 新增开场白</button>
              </div>
            </div>
            <div id="wi_ch_hotupdate_view" style="display:none">
              <div id="wi_hu_content"></div>
            </div>
          </div>
        </div>
      </div>

      <div id="wi_tab_content_script" style="display:none;flex-direction:column;flex:1;overflow:hidden">
        <div style="padding:8px;border-bottom:1px #444 solid;display:flex;gap:8px;align-items:center;background:#252528;flex-wrap:wrap">
          <select id="wi_sc_char_select" style="${INPUT_CSS}flex:1;min-width:140px;color-scheme:light"></select>
          <button id="wi_sc_current" style="${BTN_CSS}" title="跳到当前正在对话的角色卡">🎯 当前卡</button>
          <input id="wi_sc_search" placeholder="🔍 筛选脚本名称" style="${INPUT_CSS}flex:1;min-width:120px">
          <span id="wi_sc_count" style="font-size:11px;color:#888;white-space:nowrap">0 个</span>
          <button id="wi_sc_new" style="${BTN_PRIMARY_CSS}">＋ 新建脚本</button>
          <button id="wi_sc_export" style="${BTN_CSS}" title="导出当前角色卡的所有脚本为 JSON">📤 导出</button>
          <button id="wi_sc_import" style="${BTN_CSS}" title="从 JSON 导入脚本（追加到现有脚本）">📥 导入</button>
          <button id="wi_sc_refresh" style="${BTN_CSS}">刷新</button>
        </div>
        <div id="wi_sc_multi_bar" style="display:flex;padding:6px 8px;border-bottom:1px solid var(--wi-border);background:var(--wi-bg-3);gap:6px;align-items:center;font-size:11px;flex-wrap:wrap">
          <button id="wi_sc_sel_all" style="${BTN_CSS}font-size:11px">全选</button>
          <button id="wi_sc_sel_none" style="${BTN_CSS}font-size:11px">全不选</button>
          <button id="wi_sc_sel_invert" style="${BTN_CSS}font-size:11px">反选</button>
          <span style="color:var(--wi-fg-2)">已选 <b id="wi_sc_sel_count">0</b> 个</span>
          <span style="flex:1"></span>
          <button id="wi_sc_copy_to" style="${BTN_PRIMARY_CSS}font-size:11px">📋 复制到...</button>
          <button id="wi_sc_move_to" style="${BTN_DANGER_CSS}font-size:11px">📦 移动到...</button>
        </div>
        <div style="display:flex;flex:1;overflow:hidden">
          <div id="wi_sc_list" style="width:300px;overflow-y:auto;border-right:1px solid var(--wi-border);background:var(--wi-bg-2)"></div>
          <div style="flex:1;padding:10px;overflow-y:auto">
            <div id="wi_sc_empty" style="color:#888;text-align:center;padding:60px 20px;font-size:13px">
              <div style="font-size:32px;margin-bottom:12px">📜</div>
              <div>请选择或新建一个脚本</div>
            </div>
            <div id="wi_sc_editor" style="display:none">
              <div style="${LABEL_CSS}">名称 (name)</div>
              <input id="wi_sc_name" style="${INPUT_CSS}">
              <div style="${LABEL_CSS}">说明 (info)</div>
              <textarea id="wi_sc_info" style="${INPUT_CSS}height:60px;resize:vertical;font-family:inherit;line-height:${LINE_HEIGHT}px"></textarea>
              <div style="${LABEL_CSS}">
                代码（可编辑，保存后点「重载脚本」生效）
                <span id="wi_sc_code_len" style="color:#888;font-weight:normal;margin-left:6px"></span>
              </div>
              <div style="font-size:11px;color:var(--wi-fg-dim);margin-bottom:6px;line-height:1.5">
                ⚠️ 保存后立即写入磁盘并生效，无需额外操作。但「酒馆助手」原生脚本面板需要 F5 才会显示最新内容，请以本面板为准。
              </div>
              <div id="wi_sc_code_wrap" style="border:1px solid var(--wi-border);border-radius:6px;overflow:hidden">
                <textarea id="wi_sc_code" spellcheck="false" style="display:none"></textarea>
              </div>
              <div id="wi_sc_meta" style="margin-top:10px;font-size:11px;color:#666"></div>
              <div style="margin-top:12px;display:flex;gap:6px;flex-wrap:wrap">
                <button id="wi_sc_save_code" style="${BTN_PRIMARY_CSS}" title="把代码框里的内容保存到这个脚本">💾 保存代码</button>
                <button id="wi_sc_format" style="${BTN_CSS}" title="自动整理代码缩进和换行">✨ 格式化</button>
                <button id="wi_sc_open_tavern" style="${BTN_CSS}">在酒馆助手中打开</button>
                <button id="wi_sc_del" style="${BTN_DANGER_CSS}">删除脚本</button>
              </div>

            </div>
          </div>
        </div>
      </div>

      <div id="wi_tab_content_theme" style="display:none;flex-direction:column;flex:1;overflow:hidden">
        <div style="padding:8px;border-bottom:1px #444 solid;display:flex;gap:8px;align-items:center;background:#252528;flex-wrap:wrap">
          <button id="wi_th_import" style="${BTN_PRIMARY_CSS}">📥 导入主题</button>
          <button id="wi_th_new_group" style="${BTN_CSS}">＋ 新建分组</button>
          <button id="wi_th_export_groups" style="${BTN_CSS}" title="导出分组配置为 JSON">📤 导出分组</button>
          <button id="wi_th_import_groups" style="${BTN_CSS}" title="从 JSON 恢复分组配置">📥 导入分组</button>
          <button id="wi_th_refresh" style="${BTN_CSS}">刷新</button>
          <input id="wi_th_search" placeholder="🔍 搜索主题名" style="${INPUT_CSS}flex:1;min-width:140px">
          <span id="wi_th_count" style="font-size:11px;color:#888;white-space:nowrap">0 个主题</span>
        </div>
        <div id="wi_th_list" style="flex:1;overflow-y:auto;padding:10px"></div>
        <div id="wi_th_editor_panel" style="display:none;flex-direction:column;border-top:2px solid #4a9eff;background:#1c1c20;max-height:60%;flex-shrink:0">
          <div style="padding:6px 10px;border-bottom:1px solid #444;display:flex;gap:8px;align-items:center;background:#252528;flex-wrap:wrap">
            <span style="font-size:12px;color:#4a9eff;font-weight:600">✏️ 编辑 CSS</span>
            <span id="wi_th_edit_name" style="font-size:11px;color:#ccc;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
            <span id="wi_th_edit_status" style="font-size:11px;color:#888"></span>
          </div>
          <textarea id="wi_th_edit_css" spellcheck="false" style="flex:1;min-height:200px;width:100%;background:#161618;color:#bbb;border:none;border-bottom:1px solid #444;padding:8px;box-sizing:border-box;font-family:monospace;font-size:11px;line-height:1.5;resize:none;outline:none"></textarea>
          <div style="padding:8px 10px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;background:#252528">
            <button id="wi_th_edit_save" style="${BTN_PRIMARY_CSS}">💾 覆盖保存</button>
            <button id="wi_th_edit_saveas" style="${BTN_CSS}">💾 另存为</button>
            <button id="wi_th_edit_discard" style="${BTN_DANGER_CSS}">↩️ 放弃</button>
            <span style="flex:1"></span>
            <button id="wi_th_edit_revert" style="${BTN_CSS}" title="恢复到进入编辑时的状态">⟲ 撤销改动</button>
          </div>
        </div>
      </div>

      <div id="wi_tab_content_settings" style="display:none;flex-direction:column;flex:1;overflow:hidden">
        <div style="flex:1;overflow-y:auto;padding:20px 24px">
          <div style="font-size:16px;font-weight:700;color:var(--wi-fg);margin-bottom:6px">⚙️ 设置</div>
          <div style="font-size:12px;color:var(--wi-fg-dim);margin-bottom:20px">PsychoWI · WI 编辑器</div>

          <div id="wi_settings_body">
            <div style="background:var(--wi-bg-2);border:1px solid var(--wi-border);border-radius:8px;padding:14px 16px;margin-bottom:12px">
              <div style="font-size:13px;font-weight:600;color:var(--wi-fg);margin-bottom:10px">🎛️ 界面</div>
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:6px 0">
                <input type="checkbox" id="wi_set_show_floating">
                <span style="font-size:13px;color:var(--wi-fg)">显示右下角悬浮长条</span>
              </label>
              <div style="font-size:11px;color:var(--wi-fg-dim);margin-top:2px;padding-left:26px;line-height:1.5">
                关掉后右下角长条消失。想再打开面板，从酒馆的扩展面板（🧩 图标）进 PsychoWI → 点"打开 WI 编辑器"。
              </div>
            </div>

            <div style="background:var(--wi-bg-2);border:1px solid var(--wi-border);border-radius:8px;padding:14px 16px;margin-bottom:12px">
              <div style="font-size:13px;font-weight:600;color:var(--wi-fg);margin-bottom:10px">📐 面板布局</div>
              <div style="font-size:11px;color:var(--wi-fg-dim);margin-bottom:10px;line-height:1.5">
                面板位置和大小会记住。拖标题栏移动，拖右边缘 / 下边缘 / 右下角改大小。
              </div>
              <button id="wi_set_reset_layout" style="${BTN_CSS}width:100%">↺ 恢复默认布局</button>
            </div>

            <div style="background:var(--wi-bg-2);border:1px solid var(--wi-border);border-radius:8px;padding:14px 16px;margin-bottom:12px">
              <div style="font-size:13px;font-weight:600;color:var(--wi-fg);margin-bottom:10px">🧩 扩展面板入口</div>
              <label style="display:flex;align-items:center;gap:10px;cursor:pointer;padding:6px 0">
                <input type="checkbox" id="wi_set_show_ext_entry">
                <span style="font-size:13px;color:var(--wi-fg)">在酒馆扩展面板里显示 PsychoWI</span>
              </label>
              <div style="font-size:11px;color:var(--wi-fg-dim);margin-top:2px;padding-left:26px;line-height:1.5">
                关掉后，🧩 扩展面板里不再出现 PsychoWI 折叠项。
              </div>
            </div>

            <div style="background:var(--wi-bg-2);border:1px solid var(--wi-border);border-radius:8px;padding:14px 16px;margin-bottom:12px">
              <div style="font-size:13px;font-weight:600;color:var(--wi-fg);margin-bottom:10px">ℹ️ 关于</div>
              <div style="font-size:12px;color:var(--wi-fg-2);line-height:1.8">
                <div><b>PsychoWI</b> · WI 编辑器</div>
                <div>作者：<b>赛博精神病</b></div>
                <div style="color:var(--wi-fg-dim);font-size:11px;margin-top:4px">一个给 SillyTavern 用的世界书 / 正则 / 角色卡 / 脚本管理面板。</div>
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>`);
    $('body').append($panel);

    const $posSel = $('#wi_pos');
    POSITION_MAP.forEach(p => $posSel.append($('<option>').val(p.num).text(p.label)));

    function switchTab(tabName) {
      state.activeTab = tabName;
      ['worldbook', 'regex', 'character', 'script', 'theme', 'settings'].forEach(t => {
        const $tab = $(`.wi-tab[data-tab="${t}"]`);
        const $content = $(`#wi_tab_content_${t}`);
        if (t === tabName) {
          $tab.css({ color: '#4a9eff', borderBottomColor: '#4a9eff' });
          $content.css('display', 'flex');
        } else {
          $tab.css({ color: '#888', borderBottomColor: 'transparent' });
          $content.css('display', 'none');
        }
      });
    }

    // 切换到角色卡 Tab 时，自动刷新角色卡列表
    $('.wi-tab[data-tab="character"]').on('click', async () => {
      // 保存当前编辑内容，避免丢失
      try {
        await flushCharSave();
        await flushCharSaveGreeting();
      } catch (e) {}
      await loadCharList();
    });

    $('.wi-tab').on('click', function () {
      switchTab($(this).data('tab'));
    });

    switchTab('worldbook');

    // ============ 角色卡 Tab ============
    let chState = {
      allIds: [],
      activeAvatar: null,
      activeName: null,
      data: null,
      currentField: null,
      history: [],
      greetingIdx: -1,
    };

    const CH_FIELDS = [
      { key: 'description', label: '📝 角色描述', hint: '永久发送给 AI 的人设描述' },
      { key: 'first_mes', label: '💬 主开场白', hint: '新对话时的第一条消息', fromFirstMessages: 0 },
      { key: 'alternate_greetings', label: '🎬 替补开场白', hint: '开场白的备选项，可增删改', isList: true },
      { key: 'personality', label: '🧠 性格', hint: '角色性格摘要' },
      { key: 'scenario', label: '🎭 场景', hint: '对话发生的背景设定' },
      { key: 'mes_example', label: '📖 对话示例', hint: '示范角色说话风格，用 <START> 分隔' },
      { key: 'system_prompt', label: '⚙️ 系统提示词', hint: '覆盖主提示词（需开启"优先角色提示词"）' },
      { key: 'post_history_instructions', label: '📜 历史后指令', hint: '插入到历史记录之后的指令' },
      { key: 'creator_notes', label: '📌 创作者备注', hint: '给使用者的说明，不发送给 AI' },
      { key: 'creator', label: '✏️ 创作者', hint: '作者名字' },
      { key: 'version', label: '🔢 版本', hint: '角色卡版本号' },
    ];

    async function loadCharList() {
      const $sel = $('#wi_ch_select').empty();
      const TH = TavernHelper;
      try {
        const ids = TH.getCharacterIds();
        const names = TH.getCharacterNames();
        chState.allIds = ids.map((avatar, i) => ({ avatar, name: names[i] || avatar }));
        chState.allIds.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
        chState.allIds.forEach(item => {
          $sel.append($('<option>').val(item.avatar).text(`${item.name} (${item.avatar})`).css({ background: '#ffffff', color: '#2c3440' }));
        });
        const curName = await TH.getCurrentCharacterName();
        const cur = chState.allIds.find(x => x.name === curName);
        if (cur) {
          $sel.val(cur.avatar);
          await loadCharData(cur.avatar);
        } else if (chState.allIds.length > 0) {
          $sel.val(chState.allIds[0].avatar);
          await loadCharData(chState.allIds[0].avatar);
        }
      } catch (e) {
        err('加载角色列表失败', e);
      }
    }

    async function loadCharData(avatar) {
      try {
        const TH = TavernHelper;
        const data = await TH.getCharacter(avatar);
        if (!data) {
          $('#wi_ch_status').text('❌ 加载失败');
          return;
        }
        const fullData = await TH.getCharData(avatar);
        if (fullData) {
          const rawData = fullData.data || {};
          data.personality = rawData.personality || data.personality || '';
          data.scenario = rawData.scenario || data.scenario || '';
          data.mes_example = rawData.mes_example || data.mes_example || '';
          data.system_prompt = rawData.system_prompt || data.system_prompt || '';
          data.post_history_instructions = rawData.post_history_instructions || data.post_history_instructions || '';
          data.tags = Array.isArray(rawData.tags) ? rawData.tags : (data.tags || []);
          data.character_version = rawData.character_version || data.version || '';
          data.creator = rawData.creator || data.creator || '';

          // ★ 用 getCharData 返回的完整 extensions 覆盖 getCharacter 返回的残缺版本
          if (rawData.extensions && typeof rawData.extensions === 'object') {
            data.extensions = { ...(data.extensions || {}), ...rawData.extensions };
          }
        }
        chState.activeAvatar = avatar;
        chState._grDirty = false;
        // 用 getCharacterNames 拿正确名字（getCharacter 不返回 name）
        try {
          const ids = TH.getCharacterIds();
          const names = TH.getCharacterNames();
          const idx = ids.indexOf(avatar);
          chState.activeName = (idx >= 0 && names[idx]) ? names[idx] : (data.name || avatar.replace(/\.png$/i, ''));
        } catch (e) {
          chState.activeName = data.name || avatar.replace(/\.png$/i, '');
        }
        chState.data = data;
        chState.currentField = null;
        chState.greetingIdx = -1;
        chState.history = [];
        $('#wi_ch_status').text(`✅ 已加载「${chState.activeName}」`);
        renderCharFieldList();
        showCharEmpty();
        updateCharUndoBtn();
      } catch (e) {
        console.error('[WI编辑器] loadCharData 失败，完整堆栈:', e);
        console.error('[WI编辑器] avatar 参数:', JSON.stringify(avatar));
        console.error('[WI编辑器] 堆栈:', e.stack);
        $('#wi_ch_status').text('❌ ' + e.message);
      }
    }

    function renderCharFieldList() {
      const $list = $('#wi_ch_fieldlist').empty();
      if (!chState.data) return;
      CH_FIELDS.forEach(f => {
        const isSelected = chState.currentField === f.key;
        let count = 0;
        if (f.isList) {
          count = (chState.data.first_messages || []).length - 1;
          if (count < 0) count = 0;
        } else if (f.fromFirstMessages !== undefined) {
          count = (chState.data.first_messages?.[f.fromFirstMessages] || '').length;
        } else {
          count = (chState.data[f.key] || '').toString().length;
        }
        const countColor = f.isList ? '#aaa' : charCountColor(count);
        const display = f.isList ? `(${count})` : `(${count}字)`;
        const $item = $(`<div style="padding:8px 10px;cursor:pointer;border-bottom:1px solid #333;background:${isSelected ? '#3a3a44' : ''}">
          <div style="font-size:12px;color:${isSelected ? '#4a9eff' : '#ddd'}">${f.label}</div>
          <div style="font-size:10px;color:${countColor};margin-top:2px">${display}</div>
        </div>`);
        $item.on('click', () => {
          chState.currentField = f.key;
          chState.greetingIdx = -1;
          renderCharFieldList();
          renderCharEditor();
        });
        $list.append($item);
      });
    }

    function showCharEmpty() {
      $('#wi_ch_empty').show();
      $('#wi_ch_editor').hide();
    }

    function showCharEditor() {
      $('#wi_ch_empty').hide();
      $('#wi_ch_editor').show();
    }

    function renderCharEditor() {
      if (!chState.currentField || !chState.data) {
        showCharEmpty();
        return;
      }
      showCharEditor();
      const f = CH_FIELDS.find(x => x.key === chState.currentField);
      if (!f) return;
      $('#wi_ch_field_title').text(f.label);
      $('#wi_ch_field_hint').text(f.hint || '');
      if (f.isList) {
        $('#wi_ch_single').hide();
        $('#wi_ch_greetings').show();
        renderGreetingList();
      } else {
        $('#wi_ch_single').show();
        $('#wi_ch_greetings').hide();
        let val = '';
        if (f.fromFirstMessages !== undefined) {
          val = chState.data.first_messages?.[f.fromFirstMessages] || '';
        } else {
          val = chState.data[f.key] || '';
        }
        $('#wi_ch_field_input').val(val);
        updateCharCharCount();
      }
    }

    function updateCharCharCount() {
      const n = ($('#wi_ch_field_input').val() || '').length;
      $('#wi_ch_char_count').text(`${n} 字`).css('color', charCountColor(n));
    }

    function renderGreetingList() {
      // ★ 先确保 #wi_ch_greetings 恢复成"列表模式"的 HTML（如果之前是编辑模式）
      if (!$('#wi_ch_greetings').find('#wi_ch_greeting_list').length) {
        $('#wi_ch_greetings').html(`
          <div id="wi_ch_greeting_list"></div>
          <button id="wi_ch_greeting_add" style="${BTN_PRIMARY_CSS}margin-top:10px;width:100%">＋ 新增开场白</button>
        `);
        // 重新绑定"新增开场白"按钮
        $('#wi_ch_greeting_add').off('click').on('click', async () => {
          pushCharHistory();
          if (!chState.data.first_messages) chState.data.first_messages = [];
          chState.data.first_messages.push('<!-- group: 填入分类 -->\n');
          await saveChar();
          renderGreetingList();
          renderCharFieldList();
          chState.greetingIdx = chState.data.first_messages.length - 1;
          renderGreetingEditor();
        });
      }
      const $list = $('#wi_ch_greeting_list').empty();
      const greetings = chState.data.first_messages || [];
      const alts = greetings.slice(1);
      if (alts.length === 0) {
        $list.append('<div style="color:#888;text-align:center;padding:20px;font-size:12px">还没有替补开场白</div>');
        return;
      }
      alts.forEach((text, i) => {
        const realIdx = i + 1;
        const charCount = text.length;
        const titleMatch = text.match(/<!--\s*title:\s*([^-]+?)\s*-->/);
        const title = titleMatch ? titleMatch[1].trim() : `开场白 #${realIdx}`;
        const preview = text.replace(/<!--[\s\S]*?-->/g, '').trim().slice(0, 40);
        const isFirst = i === 0;
        const isLast = i === alts.length - 1;
        const $row = $(`<div class="wi-ch-gr-row" style="padding:8px 10px;background:#232326;margin-bottom:4px;border-radius:4px" data-gr-idx="${realIdx}">
          <div style="display:flex;align-items:center;gap:8px">
            <span class="wi-ch-gr-handle" style="cursor:grab;color:#888;font-size:13px;padding:0 2px;user-select:none" title="拖拽排序">☰</span>
            <div style="flex:1;min-width:0">
              <div style="font-size:12px;color:#ddd;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">#${realIdx} ${title}</div>
              <div style="font-size:10px;color:#888;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${preview || '(空)'}</div>
            </div>
            <span style="font-size:10px;color:${charCountColor(charCount)};white-space:nowrap">${charCount}字</span>
            <button class="wi-ch-gr-up" data-idx="${realIdx}" style="${BTN_NAV_CSS}padding:2px 6px;font-size:11px" title="上移" ${isFirst ? 'disabled' : ''}>↑</button>
            <button class="wi-ch-gr-down" data-idx="${realIdx}" style="${BTN_NAV_CSS}padding:2px 6px;font-size:11px" title="下移" ${isLast ? 'disabled' : ''}>↓</button>
            <button class="wi-ch-gr-edit" data-idx="${realIdx}" style="${BTN_CSS}padding:3px 8px;font-size:11px">编辑</button>
            <button class="wi-ch-gr-del" data-idx="${realIdx}" style="${BTN_DANGER_CSS}padding:3px 8px;font-size:11px">删除</button>
          </div>
        </div>`);
        $list.append($row);
      });

      // ★ 排序改动未保存 → 顶部吸顶显示保存按钮
      if (chState._grDirty) {
        const $saveBar = $(`<div class="wi-ch-gr-savebar" style="position:sticky;top:0;z-index:5;margin:0 0 8px;padding:8px;background:#3a2a2a;border:1px solid #7a4a4a;border-radius:6px;display:flex;align-items:center;gap:8px;box-shadow:0 2px 8px rgba(0,0,0,.3)">
          <span style="flex:1;font-size:11px;color:#e0c060">⚠️ 排序已改，尚未保存</span>
          <button id="wi_ch_gr_save" style="${BTN_PRIMARY_CSS}padding:4px 12px;font-size:11px">💾 保存排序</button>
          <button id="wi_ch_gr_cancel" style="${BTN_CSS}padding:4px 12px;font-size:11px">↩️ 放弃</button>
        </div>`);
        $list.prepend($saveBar);

        $list.find('#wi_ch_gr_save').on('click', async () => {
          try {
            await saveChar();
            chState._grDirty = false;
            renderGreetingList();
            renderCharFieldList();
            if (window.toastr) window.toastr.success('已保存排序');
          } catch (e) {
            alert('保存失败：' + e.message);
          }
        });

        $list.find('#wi_ch_gr_cancel').on('click', async () => {
          if (!confirm('放弃本次排序改动？')) return;
          if (chState.history.length > 0) {
            const snap = chState.history.pop();
            try {
              chState.data = JSON.parse(snap);
            } catch (e) {}
          }
          chState._grDirty = false;
          updateCharUndoBtn();
          renderGreetingList();
          renderCharFieldList();
        });
      }

      $list.find('.wi-ch-gr-up').on('click', function () {
        const idx = Number($(this).data('idx'));
        if (idx <= 1) return;   // #0 是主开场白，不能动
        pushCharHistory();
        const arr = chState.data.first_messages;
        [arr[idx - 1], arr[idx]] = [arr[idx], arr[idx - 1]];
        chState._grDirty = true;
        renderGreetingList();
        renderCharFieldList();
      });

      $list.find('.wi-ch-gr-down').on('click', function () {
        const idx = Number($(this).data('idx'));
        const arr = chState.data.first_messages;
        if (idx >= arr.length - 1) return;
        pushCharHistory();
        [arr[idx], arr[idx + 1]] = [arr[idx + 1], arr[idx]];
        chState._grDirty = true;
        renderGreetingList();
        renderCharFieldList();
      });

      $list.find('.wi-ch-gr-edit').on('click', function () {
        const idx = Number($(this).data('idx'));
        chState.greetingIdx = idx;
        renderGreetingEditor();
      });

      $list.find('.wi-ch-gr-del').on('click', async function () {
        const idx = Number($(this).data('idx'));
        if (!confirm(`确定删除开场白 #${idx}？`)) return;
        pushCharHistory();
        chState.data.first_messages.splice(idx, 1);
        await saveChar();
        renderGreetingList();
        renderCharFieldList();
      });

      // ★ 拖拽排序（拖 ☰ 手柄）
      let _grDragFrom = -1;
      $list.find('.wi-ch-gr-handle').on('mousedown', function () {
        const $row = $(this).closest('[data-gr-idx]');
        $row.attr('draggable', 'true');
      });
      $list.find('[data-gr-idx]').on('dragstart', function (ev) {
        const idx = Number($(this).data('gr-idx'));
        // #0 是主开场白，不能拖（但列表里显示的 realIdx 从 1 开始，所以 idx=1 是最上面一条）
        if (idx < 1) return;
        _grDragFrom = idx;
        $(this).css('opacity', 0.4);
        if (ev.originalEvent && ev.originalEvent.dataTransfer) {
          ev.originalEvent.dataTransfer.effectAllowed = 'move';
          try { ev.originalEvent.dataTransfer.setData('text/plain', String(idx)); } catch (e) {}
        }
      });
      $list.find('[data-gr-idx]').on('dragend', function () {
        $(this).css('opacity', 1).removeAttr('draggable');
        $list.removeClass('wi-gr-drag-above wi-gr-drag-below');
        $list.find('.wi-gr-drag-above, .wi-gr-drag-below').removeClass('wi-gr-drag-above wi-gr-drag-below');
        _grDragFrom = -1;
        _grLastHover = -1;
      });
      let _grLastHover = -1;
      $list.find('[data-gr-idx]').on('dragover', function (ev) {
        if (_grDragFrom < 0) return;
        const idx = Number($(this).data('gr-idx'));
        if (idx === _grDragFrom) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.originalEvent && ev.originalEvent.dataTransfer) {
          ev.originalEvent.dataTransfer.dropEffect = 'move';
        }
        // ★ 只有换了目标条目才重绘指示线，避免每次都全列表重设样式
        if (_grLastHover === idx) return;
        _grLastHover = idx;

        const rect = this.getBoundingClientRect();
        const mouseY = ev.originalEvent ? ev.originalEvent.clientY : 0;
        const isLowerHalf = (mouseY - rect.top) > (rect.height / 2);

        // 只清上一个有指示线的，不全列表清
        $list.find('.wi-gr-drag-above, .wi-gr-drag-below').removeClass('wi-gr-drag-above wi-gr-drag-below');
        $(this).addClass(isLowerHalf ? 'wi-gr-drag-below' : 'wi-gr-drag-above');
        return false;
      });
      $list.find('[data-gr-idx]').on('dragleave', function (ev) {
        // 只有在真正离开条目边界时才清（避免子元素触发）
        if (ev.originalEvent && this.contains(ev.originalEvent.relatedTarget)) return;
        $(this).removeClass('wi-gr-drag-above wi-gr-drag-below');
      });
      $list.find('[data-gr-idx]').on('drop', function (ev) {
        if (_grDragFrom < 0) return;
        ev.preventDefault();
        ev.stopPropagation();
        const targetIdx = Number($(this).data('gr-idx'));
        const fromIdx = _grDragFrom;
        if (fromIdx === targetIdx) return;
        const rect = this.getBoundingClientRect();
        const mouseY = ev.originalEvent ? ev.originalEvent.clientY : 0;
        const isLowerHalf = (mouseY - rect.top) > (rect.height / 2);

        const arr = chState.data.first_messages;
        // fromIdx 是"实际索引"（1-based 替补的第 fromIdx 条）
        // 移除 source
        const [moved] = arr.splice(fromIdx, 1);
        // 计算插入位置
        let insertIdx = isLowerHalf ? targetIdx + 1 : targetIdx;
        if (fromIdx < insertIdx) insertIdx -= 1;
        arr.splice(insertIdx, 0, moved);

        pushCharHistory();
        chState._grDirty = true;
        renderGreetingList();
        renderCharFieldList();
        return false;
      });
    }

    function renderGreetingEditor() {
      const idx = chState.greetingIdx;
      const text = chState.data.first_messages?.[idx] || '';
      const charCount = text.length;
      $('#wi_ch_greetings').html(`
        <button id="wi_ch_gr_back" style="${BTN_CSS}margin-bottom:8px">← 返回列表</button>
        <div style="font-size:12px;color:#aaa;margin-bottom:6px">编辑开场白 #${idx}</div>
        <textarea id="wi_ch_gr_input" style="${INPUT_CSS}height:320px;resize:vertical;font-family:inherit;line-height:${LINE_HEIGHT}px"></textarea>
        <div id="wi_ch_gr_count" style="font-size:11px;color:${charCountColor(charCount)};margin-top:4px;text-align:right">${charCount} 字</div>

        <div id="wi_ch_gr_groups_panel" style="margin-top:14px;border:1px solid var(--wi-border);border-radius:6px;background:var(--wi-bg-2);padding:0">
          <div id="wi_ch_gr_groups_toggle" style="padding:8px 12px;cursor:pointer;user-select:none;display:flex;align-items:center;gap:6px;font-size:12px;color:var(--wi-fg)">
            <span id="wi_ch_gr_groups_arrow" style="color:var(--wi-fg-dim);font-size:10px;width:10px;display:inline-block">▶</span>
            <span style="font-weight:600">🏷️ 世界书分组联动</span>
            <span id="wi_ch_gr_groups_count" style="color:var(--wi-fg-dim);font-size:11px;margin-left:auto"></span>
          </div>
          <div id="wi_ch_gr_groups_body" style="display:none;padding:0 12px 12px 12px">
            <div style="font-size:11px;color:var(--wi-fg-dim);margin-bottom:8px;line-height:1.5">
              勾选的分组会在切换到这条开场白时启用，其它分组禁用。
            </div>
            <div id="wi_ch_gr_groups_list" style="display:flex;flex-wrap:wrap;gap:6px 14px"></div>
          </div>
        </div>
      `);
      $('#wi_ch_gr_input').val(text);
      $('#wi_ch_gr_input').on('input', function () {
        const n = ($(this).val() || '').length;
        $('#wi_ch_gr_count').text(`${n} 字`).css('color', charCountColor(n));
        scheduleCharSaveGreeting();
        syncGreetingToGroupChecks();
      }).on('blur', function () {
        flushCharSaveGreeting();
      });
      $('#wi_ch_gr_back').on('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        chState.greetingIdx = -1;
        renderGreetingList();
        renderCharFieldList();
        flushCharSaveGreeting().catch(err => {
          console.error('[WI编辑器] 返回列表时保存失败:', err);
        });
      });

      // ★ 分组联动：绑定展开/收起
      $('#wi_ch_gr_groups_toggle').on('click', () => {
        const $body = $('#wi_ch_gr_groups_body');
        const $arrow = $('#wi_ch_gr_groups_arrow');
        if ($body.is(':visible')) {
          $body.hide();
          $arrow.text('▶');
        } else {
          $body.show();
          $arrow.text('▼');
        }
      });

      // ★ 异步加载分组列表
      loadGroupsForGreetingEditor().then(groups => {
        renderGreetingGroupChecks(groups);
        syncGreetingToGroupChecks();
      });
    }

    // ★ 加载当前角色卡绑定世界书里的所有分组
    async function loadGroupsForGreetingEditor() {
      const groups = new Map(); // 组名 → 条目数
      try {
        const charWb = await safeGetCharWbNames('current');
        const bookNames = [];
        if (charWb?.primary) bookNames.push(charWb.primary);
        if (Array.isArray(charWb?.additional)) bookNames.push(...charWb.additional);

        for (const book of bookNames) {
          const entries = await safeGetWb(book);
          entries.forEach(e => {
            if (e.extra && typeof e.extra._wiGroup === 'string' && e.extra._wiGroup) {
              const g = e.extra._wiGroup;
              groups.set(g, (groups.get(g) || 0) + 1);
            }
          });
        }
      } catch (e) {
        console.warn('[WI编辑器] 读取分组失败:', e);
      }
      return groups;
    }

    // ★ 渲染勾选框
    function renderGreetingGroupChecks(groupsMap) {
      const $list = $('#wi_ch_gr_groups_list').empty();
      const $count = $('#wi_ch_gr_groups_count');

      if (!groupsMap || groupsMap.size === 0) {
        $list.append('<div style="font-size:11px;color:var(--wi-fg-dim)">（当前绑定的世界书里没有分组）</div>');
        $count.text('');
        return;
      }

      $count.text(`共 ${groupsMap.size} 个分组`);

      // 按组名排序
      const sorted = Array.from(groupsMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
      sorted.forEach(([name, count]) => {
        const id = 'wi_ch_gr_g_' + name.replace(/[^\w\u4e00-\u9fa5]/g, '_');
        const $label = $(`<label style="display:flex;align-items:center;gap:5px;cursor:pointer;font-size:12px;color:var(--wi-fg);padding:2px 0">
          <input type="checkbox" class="wi-ch-gr-group-cb" data-group="${escapeHtml(name)}" id="${id}">
          <span>${escapeHtml(name)}</span>
          <span style="color:var(--wi-fg-dim);font-size:10px">(${count})</span>
        </label>`);
        $list.append($label);
      });

      // 勾选事件
      $list.find('.wi-ch-gr-group-cb').on('change', () => {
        syncGroupsToGreetingText();
      });
    }

    // ★ 勾选框 → textarea（用户勾选时）
    function syncGroupsToGreetingText() {
      const checked = [];
      $('#wi_ch_gr_groups_list .wi-ch-gr-group-cb:checked').each(function () {
        checked.push($(this).data('group'));
      });

      const raw = $('#wi_ch_gr_input').val() || '';
      // 删掉所有分组标记
      const cleaned = raw.replace(/<!--\s*group\s*:\s*[^-]+?\s*-->\s*\n?/g, '').replace(/\n{3,}/g, '\n\n');
      // 重新插入
      const marks = checked.map(g => `<!-- group: ${g} -->`).join('\n');
      const finalText = marks ? marks + '\n' + cleaned : cleaned;

      if (finalText !== raw) {
        $('#wi_ch_gr_input').val(finalText);
        const n = finalText.length;
        $('#wi_ch_gr_count').text(`${n} 字`).css('color', charCountColor(n));
        scheduleCharSaveGreeting();
      }
    }

    // ★ textarea → 勾选框（用户改文本时）
    function syncGreetingToGroupChecks() {
      const raw = $('#wi_ch_gr_input').val() || '';
      const marks = extractGroupMarks(raw);
      $('#wi_ch_gr_groups_list .wi-ch-gr-group-cb').each(function () {
        const g = $(this).data('group');
        $(this).prop('checked', marks.includes(g));
      });
    }

    let _chTimer = null;
    let _chGrTimer = null;
    let _chGrIdx = -1;

    function scheduleCharSave() {
      if (_chTimer) clearTimeout(_chTimer);
      _chTimer = setTimeout(() => { _chTimer = null; autoSaveCharField(); }, 600);
    }
    function flushCharSave() {
      if (_chTimer) {
        clearTimeout(_chTimer);
        _chTimer = null;
        return autoSaveCharField();
      }
      return Promise.resolve();
    }

    function scheduleCharSaveGreeting() {
      _chGrIdx = chState.greetingIdx;
      if (_chGrTimer) clearTimeout(_chGrTimer);
      _chGrTimer = setTimeout(() => { _chGrTimer = null; autoSaveGreeting(); }, 600);
    }
    function flushCharSaveGreeting() {
      if (_chGrTimer) {
        clearTimeout(_chGrTimer);
        _chGrTimer = null;
        return autoSaveGreeting();
      }
      return Promise.resolve();
    }

    async function autoSaveCharField() {
      if (!chState.currentField || !chState.data) {
        return;
      }
      const f = CH_FIELDS.find(x => x.key === chState.currentField);
      if (!f || f.isList) {
        return;
      }
      const newVal = $('#wi_ch_field_input').val() || '';
      let oldVal;
      if (f.fromFirstMessages !== undefined) {
        oldVal = chState.data.first_messages?.[f.fromFirstMessages] || '';
      } else {
        oldVal = chState.data[f.key] || '';
      }
      if (oldVal === newVal) {
        return;
      }
      pushCharHistory();
      if (f.fromFirstMessages !== undefined) {
        if (!chState.data.first_messages) chState.data.first_messages = [];
        chState.data.first_messages[f.fromFirstMessages] = newVal;
      } else {
        chState.data[f.key] = newVal;
      }
      await saveChar();
      renderCharFieldList();
    }

    async function autoSaveGreeting() {
      if (!chState.data || _chGrIdx < 0) return;
      const newVal = $('#wi_ch_gr_input').val() || '';
      const oldVal = chState.data.first_messages?.[_chGrIdx] || '';
      if (oldVal === newVal) return;
      pushCharHistory();
      chState.data.first_messages[_chGrIdx] = newVal;
      await saveChar();
    }

    async function saveChar() {
      if (!chState.activeAvatar || !chState.data) {
        return;
      }
      try {
        const TH = TavernHelper;
        const ctx = SillyTavern.getContext();

        const payload = {
          avatar: chState.data.avatar,
          name: chState.activeName || chState.data.name || '',
          version: chState.data.version || chState.data.character_version || '',
          creator: chState.data.creator || '',
          creator_notes: chState.data.creator_notes || '',
          description: chState.data.description || '',
          first_messages: chState.data.first_messages || [],
          worldbook: chState.data.worldbook || '',
          personality: chState.data.personality || '',
          scenario: chState.data.scenario || '',
          mes_example: chState.data.mes_example || '',
          system_prompt: chState.data.system_prompt || '',
          post_history_instructions: chState.data.post_history_instructions || '',
        };

        const isCurrentChar0 = (chState.activeAvatar === ctx.characters?.[ctx.characterId]?.avatar);
        if (isCurrentChar0) {
          const $mesTa = $('#mes_example_textarea');
          if ($mesTa.length && chState.data.mes_example !== undefined) {
            const newMes = chState.data.mes_example || '';
            if ($mesTa.val() !== newMes) {
              if (ctx.characters[ctx.characterId]?.data) {
                ctx.characters[ctx.characterId].data.mes_example = newMes;
              }
              $mesTa.val(newMes);
              $mesTa.trigger('input');
            }
          }
        }

        await TH.replaceCharacter(chState.activeName, payload);

        const isCurrentChar = (chState.activeAvatar === ctx.characters?.[ctx.characterId]?.avatar);
        if (isCurrentChar && typeof ctx.writeExtensionField === 'function' && chState.data.extensions) {
          const ext = chState.data.extensions;
          try {
            if (ext.regex_scripts !== undefined) {
              await ctx.writeExtensionField(ctx.characterId, 'regex_scripts', ext.regex_scripts);
            }
            if (ext.tavern_helper !== undefined) {
              await ctx.writeExtensionField(ctx.characterId, 'tavern_helper', ext.tavern_helper);
            }
            if (ext.world !== undefined) {
              await ctx.writeExtensionField(ctx.characterId, 'world', ext.world);
            }
          } catch (e) {
            console.error('[WI编辑器] 写 extensions 失败:', e);
          }
        }

        if (isCurrentChar) {
          const domFieldMap = {
            description: '#description_textarea',
            personality: '#personality_textarea',
            scenario: '#scenario_textarea',
            mes_example: '#mes_example_textarea',
            creator_notes: '#creator_notes_textarea',
            system_prompt: '#system_prompt_textarea',
            post_history_instructions: '#post_history_instructions_textarea',
          };
          const jqRoot = window.top && window.top.jQuery ? window.top.jQuery : (window.jQuery || $);
          Object.entries(domFieldMap).forEach(([field, selector]) => {
            const newVal = chState.data[field] || '';
            // 1. 无论如何都更新内存里的角色卡数据
            if (ctx.characters[ctx.characterId]?.data) {
              if (ctx.characters[ctx.characterId].data[field] !== newVal) {
                ctx.characters[ctx.characterId].data[field] = newVal;
              }
            }
            // 2. 如果原生编辑器的元素当前在 DOM 里，同步 UI
            const el = __wiRootDoc.querySelector(selector);
            if (!el) return;
            const oldVal = el.value || '';
            if (oldVal !== newVal) {
              el.value = newVal;
              try {
                const ev = new Event('input', { bubbles: true });
                el.dispatchEvent(ev);
              } catch (e) {}
              try {
                jqRoot(el).trigger('input');
              } catch (e) {}
            }
          });
        }

        $('#wi_ch_status').text(`💾 已保存「${chState.activeName}」`).css('color', '#8cf');
      } catch (e) {
        console.error('[WI编辑器] saveChar 失败，完整堆栈:', e);
        console.error('[WI编辑器] activeAvatar:', JSON.stringify(chState.activeAvatar));
        console.error('[WI编辑器] data.avatar:', JSON.stringify(chState.data?.avatar));
        console.error('[WI编辑器] 堆栈:', e.stack);
        $('#wi_ch_status').text('❌ 保存失败：' + e.message).css('color', '#f88');
      }
    }

    function updateCharUndoBtn() {
      const n = chState.history.length;
      const $b = $('#wi_ch_undo');
      $b.prop('disabled', n === 0).css('opacity', n === 0 ? 0.4 : 1);
      $b.attr('title', n === 0 ? '没有可撤销的操作' : `撤销 (${n} 步可撤)`);
    }

    function pushCharHistory() {
      try {
        chState.history.push(JSON.stringify(chState.data));
        if (chState.history.length > 20) chState.history.shift();
        updateCharUndoBtn();
      } catch (e) {}
    }

    async function undoChar() {
      if (chState.history.length === 0) return;
      const snapshot = chState.history.pop();
      try {
        chState.data = JSON.parse(snapshot);
        await saveChar();
        renderCharFieldList();
        renderCharEditor();
        updateCharUndoBtn();
      } catch (e) {
        err('撤销失败', e);
      }
    }

    $('#wi_ch_select').on('change', async function () {
      const avatar = $(this).val();

      // 检查这个角色卡是否还存在
      const TH = TavernHelper;
      const ids = TH.getCharacterIds();
      if (!ids.includes(avatar)) {
        // 角色卡已被删除，刷新下拉框并跳过
        console.warn('[WI编辑器] 选中的角色卡已不存在，刷新下拉框:', avatar);
        await loadCharList();
        return;
      }

      await flushCharSave();
      await flushCharSaveGreeting();
      await loadCharData(avatar);
    });

    $('#wi_ch_reload').on('click', async () => {
      if (chState.activeAvatar) {
        await loadCharData(chState.activeAvatar);
      } else {
        await loadCharList();
      }
    });

    $('#wi_ch_undo').on('click', undoChar);

    $('#wi_ch_field_input').on('input', function () {
      updateCharCharCount();
      scheduleCharSave();
    }).on('blur', () => {
      flushCharSave();
    });

    $('#wi_ch_greeting_add').on('click', async () => {
      pushCharHistory();
      if (!chState.data.first_messages) chState.data.first_messages = [];
      chState.data.first_messages.push('<!-- group: 填入分类 -->\n');
      await saveChar();
      renderGreetingList();
      renderCharFieldList();
      chState.greetingIdx = chState.data.first_messages.length - 1;
      renderGreetingEditor();
    });

    setTimeout(() => {
      if (chState.allIds.length === 0) loadCharList();
    }, 100);

    // 内嵌世界书条目级差异：按 comment 匹配，只比 content
    function diffWorldbookEntries(oldCb, newCb) {
      const oldEntries = oldCb?.entries || [];
      const newEntries = newCb?.entries || [];

      // 按 comment 分组
      const groupByComment = (arr) => {
        const m = new Map();
        arr.forEach(e => {
          const key = (e.comment || '').trim() || `__no_comment_${Math.random()}`;
          if (!m.has(key)) m.set(key, []);
          m.get(key).push(e);
        });
        return m;
      };

      const oldMap = groupByComment(oldEntries);
      const newMap = groupByComment(newEntries);

      const allKeys = new Set([...oldMap.keys(), ...newMap.keys()]);
      const result = [];

      allKeys.forEach(key => {
        const olds = oldMap.get(key) || [];
        const news = newMap.get(key) || [];
        const maxLen = Math.max(olds.length, news.length);

        for (let i = 0; i < maxLen; i++) {
          const o = olds[i];
          const n = news[i];

          if (o && !n) {
            // 删除
            result.push({
              status: 'deleted',
              comment: o.comment || '(无标题)',
              oldContent: o.content || '',
              newContent: '',
              oldLen: (o.content || '').length,
              newLen: 0,
            });
          } else if (!o && n) {
            // 新增
            result.push({
              status: 'added',
              comment: n.comment || '(无标题)',
              oldContent: '',
              newContent: n.content || '',
              oldLen: 0,
              newLen: (n.content || '').length,
            });
          } else if (o && n) {
            const oC = o.content || '';
            const nC = n.content || '';
            if (oC !== nC) {
              result.push({
                status: 'modified',
                comment: n.comment || o.comment || '(无标题)',
                oldContent: oC,
                newContent: nC,
                oldLen: oC.length,
                newLen: nC.length,
              });
            }
            // 相同则不入 result（只显示有变化的）
          }
        }
      });

      // 排序：新增 → 修改 → 删除
      const order = { added: 0, modified: 1, deleted: 2 };
      result.sort((a, b) => order[a.status] - order[b.status]);

      return result;
    }

    // ============ 角色卡热更新 ============
    function diffCharCards(oldCard, newCard) {
      const FIELD_LABELS = {
        'description': '📝 角色描述',
        'first_mes': '💬 主开场白',
        'alternate_greetings': '🎬 替补开场白',
        'personality': '🧠 性格',
        'scenario': '🎭 场景',
        'mes_example': '📖 对话示例',
        'system_prompt': '⚙️ 系统提示词',
        'post_history_instructions': '📜 历史后指令',
        'creator_notes': '📌 创作者备注',
        'creator': '✏️ 创作者',
        'version': '🔢 版本',
        'tags': '🏷️ 标签',
        'character_book': '📚 内嵌世界书',
        'regex_scripts': '🔣 内嵌正则',
        'tavern_helper': '📜 内嵌脚本',
        'world': '🌍 绑定的世界书',
      };

      const diffs = [];

      for (const key of ['description', 'personality', 'scenario', 'mes_example',
                          'system_prompt', 'post_history_instructions',
                          'creator_notes', 'creator', 'version']) {
        const o = (oldCard[key] ?? '').toString();
        const n = (newCard[key] ?? '').toString();
        if (o !== n) {
          diffs.push({
            key, label: FIELD_LABELS[key] || key, type: 'text',
            oldVal: o, newVal: n,
            oldPreview: o.slice(0, 100) + (o.length > 100 ? `…(${o.length}字)` : ''),
            newPreview: n.slice(0, 100) + (n.length > 100 ? `…(${n.length}字)` : ''),
            oldLen: o.length, newLen: n.length,
          });
        }
      }

      const oFirst = oldCard.first_messages?.[0] || '';
      const nFirst = newCard.first_messages?.[0] || '';
      if (oFirst !== nFirst) {
        diffs.push({
          key: 'first_mes', label: FIELD_LABELS['first_mes'], type: 'text',
          oldVal: oFirst, newVal: nFirst,
          oldPreview: oFirst.slice(0, 100) + (oFirst.length > 100 ? `…` : ''),
          newPreview: nFirst.slice(0, 100) + (nFirst.length > 100 ? `…` : ''),
          oldLen: oFirst.length, newLen: nFirst.length,
        });
      }

      const oAlts = (oldCard.first_messages || []).slice(1);
      const nAlts = (newCard.first_messages || []).slice(1);
      const arrayDiffers = (a, b) => {
        if (a.length !== b.length) return true;
        for (let i = 0; i < a.length; i++) {
          if (a[i] !== b[i]) return true;
        }
        return false;
      };
      if (arrayDiffers(oAlts, nAlts)) {
        diffs.push({
          key: 'alternate_greetings', label: FIELD_LABELS['alternate_greetings'], type: 'array',
          oldCount: oAlts.length, newCount: nAlts.length,
          oldVal: oAlts, newVal: nAlts,
          oldPreview: `${oAlts.length} 条`, newPreview: `${nAlts.length} 条`,
        });
      }

      const oTags = oldCard.tags || [];
      const nTags = newCard.tags || [];
      const tagsDiffer = oTags.length !== nTags.length || oTags.some((v, i) => v !== nTags[i]);
      if (tagsDiffer) {
        diffs.push({
          key: 'tags', label: FIELD_LABELS['tags'], type: 'array',
          oldVal: oldCard.tags || [], newVal: newCard.tags || [],
          oldPreview: `${(oldCard.tags || []).length} 个`,
          newPreview: `${(newCard.tags || []).length} 个`,
        });
      }

      const oExt = oldCard.extensions || {};
      const nExt = newCard.extensions || {};

      const oReArr = oExt.regex_scripts || [];
      const nReArr = nExt.regex_scripts || [];
      const reDiffer = oReArr.length !== nReArr.length || oReArr.some((v, i) => JSON.stringify(v) !== JSON.stringify(nReArr[i]));
      if (reDiffer) {
        diffs.push({
          key: 'regex_scripts', label: FIELD_LABELS['regex_scripts'], type: 'ext-array',
          extKey: 'regex_scripts',
          oldVal: oExt.regex_scripts || [], newVal: nExt.regex_scripts || [],
          oldPreview: `${(oExt.regex_scripts || []).length} 条`,
          newPreview: `${(nExt.regex_scripts || []).length} 条`,
        });
      }

      const oTh = JSON.stringify(oExt.tavern_helper || {});
      const nTh = JSON.stringify(nExt.tavern_helper || {});
      if (oTh !== nTh) {
        const oTHArr = oExt.tavern_helper?.scripts || oExt.tavern_helper?.script_trees || [];
        const nTHArr = nExt.tavern_helper?.scripts || nExt.tavern_helper?.script_trees || [];
        const oScriptsCount = Array.isArray(oTHArr) ? oTHArr.length : 0;
        const nScriptsCount = Array.isArray(nTHArr) ? nTHArr.length : 0;
        diffs.push({
          key: 'tavern_helper', label: FIELD_LABELS['tavern_helper'], type: 'ext-obj',
          extKey: 'tavern_helper',
          oldVal: oExt.tavern_helper || {}, newVal: nExt.tavern_helper || {},
          oldPreview: `脚本 ${oScriptsCount} 个`, newPreview: `脚本 ${nScriptsCount} 个`,
        });
      }

      const oWorld = JSON.stringify(oExt.world || '');
      const nWorld = JSON.stringify(nExt.world || '');
      if (oWorld !== nWorld) {
        diffs.push({
          key: 'world', label: FIELD_LABELS['world'], type: 'ext-text',
          extKey: 'world',
          oldVal: oExt.world || '', newVal: nExt.world || '',
          oldPreview: (oExt.world || '(无)'), newPreview: (nExt.world || '(无)'),
        });
      }

      const oCb = JSON.stringify(oldCard.character_book || null);
      const nCb = JSON.stringify(newCard.character_book || null);
      if (oCb !== nCb) {
        const oEntries = oldCard.character_book?.entries?.length || 0;
        const nEntries = newCard.character_book?.entries?.length || 0;

        // 做条目级差异：按 comment 匹配，只比 content
        const entryDiffs = diffWorldbookEntries(
          oldCard.character_book,
          newCard.character_book
        );

        diffs.push({
          key: 'character_book', label: FIELD_LABELS['character_book'], type: 'wb-entries',
          oldVal: JSON.stringify(oldCard.character_book || null),
          newVal: JSON.stringify(newCard.character_book || null),
          oldPreview: `${oEntries} 条目`, newPreview: `${nEntries} 条目`,
          oldLen: oEntries, newLen: nEntries,
          entryDiffs,
        });
      }

      return diffs;
    }

    function openHotUpdate() {
      if (!chState.activeAvatar || !chState.data) {
        alert('请先在顶部选择一个角色卡作为更新目标');
        return;
      }

      $('#wi_ch_empty').hide();
      $('#wi_ch_editor').hide();
      $('#wi_ch_fieldlist').hide();
      $('#wi_ch_hotupdate_view').show();
      $('#wi_ch_hotupdate_view').css('flex', '1');

      $('#wi_hu_content').html(`
        <div style="padding:10px 14px">
          <div style="font-size:14px;font-weight:700;color:#eee;margin-bottom:8px">🔄 角色卡热更新</div>
          <div style="font-size:12px;color:#aaa;margin-bottom:8px">
            目标：<b style="color:#cfc">${chState.activeName}</b>
          </div>
          <div style="font-size:11px;color:#888;margin-bottom:10px;line-height:1.6">
            粘贴或选择新版角色卡的 <b>JSON 文件</b>（V1/V2 规范都行）。<br>
            点"对比差异"后列出所有变化，可逐项勾选。<br>
            <span style="color:#e0c060">⚠️ 应用前会自动把旧卡备份到剪贴板。</span>
          </div>
          <div style="margin-bottom:8px;display:flex;gap:6px">
            <button id="wi_hu_pickfile" style="${BTN_CSS}">📁 选择 JSON 文件</button>
            <button id="wi_hu_close2" style="${BTN_CSS}">← 返回编辑</button>
          </div>
          <textarea id="wi_hu_json" placeholder='粘贴角色卡 JSON...' style="width:100%;height:200px;background:#161618;color:#bbb;border:1px solid #444;border-radius:4px;padding:8px;box-sizing:border-box;font-family:monospace;font-size:11px;resize:vertical"></textarea>
          <div id="wi_hu_status" style="font-size:11px;color:#888;margin-top:6px"></div>
          <div style="margin-top:10px;display:flex;gap:6px;justify-content:flex-end">
            <button id="wi_hu_compare" style="${BTN_PRIMARY_CSS}">🔍 对比差异</button>
          </div>
        </div>
      `);

      $('#wi_hu_close2').on('click', () => {
        $('#wi_ch_hotupdate_view').hide();
        $('#wi_ch_fieldlist').show();
        showCharEmpty();
      });

      $('#wi_hu_pickfile').on('click', async () => {
        const picked = await pickJsonFile();
        if (!picked) return;
        $('#wi_hu_json').val(picked.text);
        $('#wi_hu_status').text(`📄 已读取：${picked.name}（${picked.text.length} 字符）`).css('color', '#8cf');
      });

      $('#wi_hu_compare').on('click', async () => {
        const raw = $('#wi_hu_json').val() || '';
        if (!raw.trim()) {
          $('#wi_hu_status').text('❌ 请先粘贴或选择 JSON').css('color', '#f88');
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch (e) {
          $('#wi_hu_status').text('❌ JSON 解析失败：' + e.message).css('color', '#f88');
          return;
        }
        const newData = parsed.data || parsed;
        if (!newData || typeof newData !== 'object') {
          $('#wi_hu_status').text('❌ 无法识别卡结构').css('color', '#f88');
          return;
        }

        const oldData = chState.data;
        const oldNormalized = {
          description: oldData.description || '',
          personality: oldData.personality || '',
          scenario: oldData.scenario || '',
          mes_example: oldData.mes_example || '',
          system_prompt: oldData.system_prompt || '',
          post_history_instructions: oldData.post_history_instructions || '',
          creator_notes: oldData.creator_notes || '',
          creator: oldData.creator || '',
          version: oldData.version || oldData.character_version || '',
          tags: oldData.tags || [],
          first_messages: oldData.first_messages || [],
          character_book: oldData.character_book || null,
          extensions: oldData.extensions || {},
        };

        const newNormalized = {
          description: newData.description || '',
          personality: newData.personality || '',
          scenario: newData.scenario || '',
          mes_example: newData.mes_example || '',
          system_prompt: newData.system_prompt || '',
          post_history_instructions: newData.post_history_instructions || '',
          creator_notes: newData.creator_notes || '',
          creator: newData.creator || '',
          version: newData.character_version || newData.version || '',
          tags: newData.tags || [],
          first_messages: [
            newData.first_mes || '',
            ...(newData.alternate_greetings || []),
          ],
          character_book: newData.character_book || null,
          extensions: newData.extensions || {},
        };

        const diffs = diffCharCards(oldNormalized, newNormalized);
        if (diffs.length === 0) {
          $('#wi_hu_status').text('✅ 没有发现差异，无需更新').css('color', '#6ac06a');
          return;
        }

        renderDiffPanelInline(diffs, oldNormalized, newNormalized);
      });
    }

    // ★ 文本对比：用 diff-match-patch 做字符级 diff
    function renderTextDiff(oldText, newText) {
      const w = (window.top && window.top !== window) ? window.top : window;
      const DMP = w.diff_match_patch;

      // 降级：如果库没加载好，退回原来的并排显示
      if (typeof DMP !== 'function') {
        return `
          <div style="display:flex;gap:8px">
            <div style="flex:1;min-width:0">
              <div style="font-size:10px;color:var(--wi-fg-dim);margin-bottom:3px">旧版 (${oldText.length}字)</div>
              <pre style="margin:0;padding:6px;background:var(--wi-bg-3);border:1px solid var(--wi-border);border-radius:4px;font-size:11px;color:var(--wi-fg-2);white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto">${escapeHtml(oldText, 999999)}</pre>
            </div>
            <div style="flex:1;min-width:0">
              <div style="font-size:10px;color:var(--wi-fg-dim);margin-bottom:3px">新版 (${newText.length}字)</div>
              <pre style="margin:0;padding:6px;background:var(--wi-bg-3);border:1px solid var(--wi-border);border-radius:4px;font-size:11px;color:var(--wi-fg-2);white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto">${escapeHtml(newText, 999999)}</pre>
            </div>
          </div>`;
      }

      const dmp = new DMP();
      const diffs = dmp.diff_main(oldText || '', newText || '');
      dmp.diff_cleanupSemantic(diffs);

      // 计算统计
      let addedChars = 0, removedChars = 0;
      diffs.forEach(([op, text]) => {
        if (op === 1) addedChars += text.length;
        else if (op === -1) removedChars += text.length;
      });

      // 上下文保留字符数
      const CTX = 15;
      const parts = [];
      diffs.forEach(([op, text], i) => {
        if (op === 0) {
          // 相同部分：如果太长，只保留前后各 CTX 字
          if (text.length <= CTX * 2 + 5) {
            parts.push({ type: 'same', text });
          } else {
            parts.push({ type: 'same', text: text.slice(0, CTX) });
            parts.push({ type: 'gap', text: `… ${text.length - CTX * 2} 字未变 …` });
            parts.push({ type: 'same', text: text.slice(-CTX) });
          }
        } else if (op === -1) {
          parts.push({ type: 'del', text });
        } else if (op === 1) {
          parts.push({ type: 'add', text });
        }
      });

      const htmlParts = parts.map(p => {
        const t = escapeHtml(p.text, 999999);   // ★ 不截断
        if (p.type === 'same') {
          return `<span style="color:var(--wi-fg-dim);white-space:pre-wrap">${t}</span>`;
        }
        if (p.type === 'gap') {
          return `<span style="color:var(--wi-fg-dim);font-style:italic;padding:0 4px">${t}</span>`;
        }
        if (p.type === 'del') {
          return `<span style="background:rgba(224,96,96,0.25);color:#c05050;text-decoration:line-through;border-radius:2px;padding:0 1px;white-space:pre-wrap">${t}</span>`;
        }
        if (p.type === 'add') {
          return `<span style="background:rgba(88,182,0,0.25);color:#3a8a00;border-radius:2px;padding:0 1px;white-space:pre-wrap">${t}</span>`;
        }
        return t;
      }).join('');

      const stats = [];
      if (removedChars > 0) stats.push(`<span style="color:#c05050">−${removedChars} 字</span>`);
      if (addedChars > 0) stats.push(`<span style="color:#3a8a00">+${addedChars} 字</span>`);

      return `
        <div style="font-size:10px;color:var(--wi-fg-dim);margin-bottom:6px;display:flex;gap:8px;align-items:center">
          <span>旧版 ${oldText.length} 字 → 新版 ${newText.length} 字</span>
          ${stats.length ? `<span style="margin-left:auto">${stats.join('  ')}</span>` : ''}
        </div>
        <div style="padding:8px;background:var(--wi-bg-3);border:1px solid var(--wi-border);border-radius:4px;font-size:11px;line-height:1.6;color:var(--wi-fg-2);max-height:400px;overflow:auto;word-break:break-word;font-family:monospace">${htmlParts || '<span style="color:var(--wi-fg-dim);font-style:italic">(空)</span>'}</div>
      `;
    }

    function renderDiffPanelInline(diffs, oldData, newData) {
      // 先清空之前可能残留的委托事件，避免多次对比时事件叠加
      $('#wi_ch_hotupdate_view').off('click', '.wi-hu-expand');
      $('#wi_ch_hotupdate_view').off('click', '.wi-cb-toggle');
      // 再清空按钮上的（这几个是 id 直接绑定）
      $('#wi_hu_all').off('click');
      $('#wi_hu_none').off('click');
      $('#wi_hu_apply').off('click');
      $('#wi_hu_back2').off('click');

      const diffHtml = diffs.map((d, i) => {
        let summaryHtml = '';
        if (d.type === 'wb-entries') {
          summaryHtml = `<span style="color:#888">${d.oldLen ?? 0} 条目 → ${d.newLen ?? 0} 条目</span>`;
        } else if (d.type === 'text') {
          summaryHtml = `<span style="color:#888">${d.oldLen ?? 0} 字 → ${d.newLen ?? 0} 字</span>`;
        } else if (d.type === 'array') {
          summaryHtml = `<span style="color:#888">${d.oldPreview} → ${d.newPreview}</span>`;
        } else {
          summaryHtml = `<span style="color:#888">${escapeHtml(String(d.oldPreview), 60)} → ${escapeHtml(String(d.newPreview), 60)}</span>`;
        }
        return `
          <div class="wi-hu-diff-item" data-idx="${i}" style="border:1px solid #3a3a3a;border-radius:6px;padding:8px;margin-bottom:8px;background:#222225">
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" class="wi-hu-diff-cb" data-idx="${i}" checked style="cursor:pointer">
              <span style="font-size:13px;color:#ddd;font-weight:600">${d.label}</span>
              ${summaryHtml}
            </label>
            <div style="margin-top:4px">
              <span class="wi-hu-expand" data-idx="${i}" style="font-size:11px;color:#4a9eff;cursor:pointer;user-select:none">展开对比 ▼</span>
            </div>
            <div class="wi-hu-detail" data-idx="${i}" style="display:none;margin-top:6px"></div>
          </div>`;
      }).join('');

      $('#wi_hu_content').html(`
        <div style="padding:10px 14px">
          <div style="font-size:14px;font-weight:700;color:#eee;margin-bottom:6px">🔍 差异对比（共 ${diffs.length} 处）</div>
          <div style="font-size:11px;color:#888;margin-bottom:10px;line-height:1.6">
            <b style="color:#cfc">默认全部勾选</b>（用新版覆盖旧版）。<br>
            如果某个字段你自己改过、不想被覆盖，<b>取消勾选</b>它即可保留旧版。<br>
            <span style="color:#e0c060">⚠️ 点"应用"后会自动备份旧卡到剪贴板。</span>
          </div>
          <div style="max-height:50vh;overflow-y:auto;padding-right:4px">
            ${diffHtml}
          </div>
          <div style="margin-top:10px;display:flex;gap:6px;justify-content:space-between;align-items:center;flex-wrap:wrap">
            <div style="display:flex;gap:6px">
              <button id="wi_hu_all" style="${BTN_CSS}font-size:11px">全选</button>
              <button id="wi_hu_none" style="${BTN_CSS}font-size:11px">全不选</button>
            </div>
            <div style="display:flex;gap:6px">
              <button id="wi_hu_apply" style="${BTN_PRIMARY_CSS}">✅ 应用选中的改动</button>
              <button id="wi_hu_back2" style="${BTN_CSS}">← 返回编辑</button>
            </div>
          </div>
        </div>
      `);

      $('#wi_hu_back2').on('click', () => {
        $('#wi_ch_hotupdate_view').hide();
        $('#wi_ch_fieldlist').show();
        showCharEmpty();
      });

      $('#wi_ch_hotupdate_view').on('click', '.wi-hu-expand', function () {
        const idx = Number($(this).data('idx'));
        const $detail = $(`.wi-hu-detail[data-idx="${idx}"]`);
        const $toggle = $(this);
        if ($detail.is(':visible')) {
          $detail.hide();
          $toggle.text('展开对比 ▼');
          return;
        }
        if ($detail.data('rendered') !== true) {
          const d = diffs[idx];
          let html = '';
          // 如果是内嵌世界书，且有条目级差异，优先渲染条目差异
          if (d.key === 'character_book' && Array.isArray(d.entryDiffs) && d.entryDiffs.length > 0) {
            const statusLabel = {
              added:    { icon: '🟢', text: '新增', color: '#6ac06a' },
              modified: { icon: '🟡', text: '修改', color: '#e0c060' },
              deleted:  { icon: '🔴', text: '删除', color: '#e07070' },
            };
            const rows = d.entryDiffs.map((ed, ei) => {
              const sl = statusLabel[ed.status] || statusLabel.modified;
              const detailId = `wi-cb-detail-${idx}-${ei}`;
              const lenInfo = ed.status === 'added'
                ? `${ed.newLen} 字`
                : ed.status === 'deleted'
                ? `${ed.oldLen} 字`
                : `${ed.oldLen} 字 → ${ed.newLen} 字`;
              return `
                <div style="border:1px solid #3a3a3a;border-radius:4px;padding:6px 8px;margin-bottom:6px;background:#1f1f22">
                  <div style="display:flex;align-items:center;gap:8px;font-size:12px">
                    <span style="color:${sl.color};font-weight:600">${sl.icon} ${sl.text}</span>
                    <span style="color:#ddd;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(ed.comment, 60)}</span>
                    <span style="color:#888;font-size:11px">${lenInfo}</span>
                    <span class="wi-cb-toggle" data-target="${detailId}" style="color:#4a9eff;cursor:pointer;font-size:11px;user-select:none">展开 ▼</span>
                  </div>
                  <div id="${detailId}" style="display:none;margin-top:6px"></div>
                </div>`;
            }).join('');

            html = `
              <div style="margin-bottom:8px;font-size:11px;color:#888">
                共 ${d.entryDiffs.length} 条有变化
              </div>
              <div style="max-height:400px;overflow-y:auto;padding-right:4px">
                ${rows}
              </div>`;
            $detail.html(html).data('rendered', true);
            // 直接 show 后返回，不再走下面的通用渲染
            $detail.show();
            $toggle.text('收起 ▲');
            return;
          }
          if (d.type === 'text') {
            html = renderTextDiff(d.oldVal || '', d.newVal || '');
          } else {
            html = `
              <div style="display:flex;gap:8px">
                <div style="flex:1">
                  <div style="font-size:10px;color:#888">旧版 (${d.oldPreview})</div>
                </div>
                <div style="flex:1">
                  <div style="font-size:10px;color:#888">新版 (${d.newPreview})</div>
                </div>
              </div>`;
          }
          $detail.html(html).data('rendered', true);
        }
        $detail.show();
        $toggle.text('收起 ▲');
      });

      // 条目详情展开
      $('#wi_ch_hotupdate_view').on('click', '.wi-cb-toggle', function () {
        const targetId = $(this).data('target');
        const $target = $('#' + targetId);
        if ($target.is(':visible')) {
          $target.hide();
          $(this).text('展开 ▼');
          return;
        }
        if ($target.data('rendered') !== true) {
          // 从 targetId 反推是第几条
          const m = targetId.match(/wi-cb-detail-(\d+)-(\d+)/);
          if (m) {
            const di = Number(m[1]);
            const ei = Number(m[2]);
            const d = diffs[di];
            const ed = d?.entryDiffs?.[ei];
            if (ed) {
              const showOld = ed.status !== 'added';
              const showNew = ed.status !== 'deleted';
              let inner = '';
              // 统一用 diff 渲染（新增=全绿，删除=全红，修改=精确对比）
              const _old = ed.status === 'added' ? '' : (ed.oldContent || '');
              const _new = ed.status === 'deleted' ? '' : (ed.newContent || '');
              inner += renderTextDiff(_old, _new);
              $target.html(inner).data('rendered', true);
            }
          }
        }
        $target.show();
        $(this).text('收起 ▲');
      });

      $('#wi_hu_all').on('click', () => $('.wi-hu-diff-cb').prop('checked', true));
      $('#wi_hu_none').on('click', () => $('.wi-hu-diff-cb').prop('checked', false));

      $('#wi_hu_apply').on('click', async () => {
        const selected = [];
        $('.wi-hu-diff-cb:checked').each(function () {
          selected.push(Number($(this).data('idx')));
        });

        if (selected.length === 0) {
          alert('没有勾选任何改动，无需应用');
          return;
        }

        if (!confirm(`将应用 ${selected.length} 项改动到「${chState.activeName}」。\n\n聊天记录不受影响。继续？`)) return;

        try {
          const oldJson = JSON.stringify({
            spec: 'chara_card_v3',
            spec_version: '3.0',
            data: {
              name: chState.data.name,
              description: chState.data.description || '',
              personality: chState.data.personality || '',
              scenario: chState.data.scenario || '',
              first_mes: chState.data.first_messages?.[0] || '',
              mes_example: chState.data.mes_example || '',
              creator_notes: chState.data.creator_notes || '',
              system_prompt: chState.data.system_prompt || '',
              post_history_instructions: chState.data.post_history_instructions || '',
              tags: chState.data.tags || [],
              creator: chState.data.creator || '',
              character_version: chState.data.version || '',
              alternate_greetings: (chState.data.first_messages || []).slice(1),
            },
          }, null, 2);
          await navigator.clipboard.writeText(oldJson);
          console.log('[WI编辑器] 旧卡已备份到剪贴板');
        } catch (e) {
          if (!confirm('⚠️ 备份到剪贴板失败。是否继续？')) return;
        }

        try {
          $('#wi_hu_apply').prop('disabled', true).text('应用中…');
          await applyHotUpdate(diffs, selected, newData);
          $('#wi_ch_hotupdate_view').hide();
          $('#wi_ch_fieldlist').show();
          showCharEmpty();
          setTimeout(async () => {
            alert(`✅ 已应用 ${selected.length} 项改动到「${chState.activeName}」。\n\n旧卡已备份到剪贴板。`);
            await loadCharData(chState.activeAvatar);
          }, 50);
        } catch (e) {
          err('热更新失败', e);
          $('#wi_hu_apply').prop('disabled', false).text('✅ 应用选中的改动');
          alert('❌ 热更新失败：' + e.message);
        }
      });
    }

    async function applyHotUpdate(diffs, selectedIdxs, newData) {
      if (!chState.activeAvatar || !chState.data) throw new Error('没有选中的角色卡');

      const selectedSet = new Set(selectedIdxs);
      const target = chState.data;
      if (!target.extensions) target.extensions = {};

      try {
        const cb = newData.character_book || target.character_book;
        const worldName = newData.extensions?.world || target.extensions?.world;
        if (cb && cb.entries && worldName) {
          const syncWorld = confirm(
            `检测到内嵌世界书「${cb.name || worldName}」（${cb.entries.length} 条）\n` +
            `是否把它同步覆盖到绑定的独立世界书「${worldName}」？\n\n` +
            `· 是 = 用内嵌内容覆盖独立世界书\n` +
            `· 否 = 只更新角色卡，独立世界书不动`
          );

          if (syncWorld) {
            console.log('[WI编辑器] 开始同步内嵌世界书 → 独立世界书:', worldName);

            const convertEntries = () => cb.entries.map((entry, i) => {
              let posType = 'before_character_definition';
              const ext = entry.extensions || {};
              if (ext.position === 1) posType = 'after_character_definition';
              else if (ext.position === 2) posType = 'before_author_note';
              else if (ext.position === 3) posType = 'after_author_note';
              else if (ext.position === 4) posType = 'at_depth';

              return {
                uid: Date.now() + i,
                name: entry.comment || `条目${i + 1}`,
                content: entry.content || '',
                enabled: entry.enabled !== false,
                strategy: {
                  type: entry.constant ? 'constant' : 'selective',
                  keys: Array.isArray(entry.keys) ? entry.keys : [],
                  keys_secondary: {
                    logic: 'and_any',
                    keys: Array.isArray(entry.secondary_keys) ? entry.secondary_keys : [],
                  },
                  scan_depth: 'same_as_global',
                },
                position: {
                  type: posType,
                  role: 'system',
                  depth: ext.depth ?? 4,
                  order: entry.insertion_order ?? 100,
                },
              };
            });

            const allBooks = await getWorldbookNames();
            if (!allBooks.includes(worldName)) {
              const createNew = confirm(`独立世界书「${worldName}」不存在，是否创建？`);
              if (createNew) {
                const converted = convertEntries();
                if (typeof TavernHelper.createOrReplaceWorldbook === 'function') {
                  await TavernHelper.createOrReplaceWorldbook(worldName, converted);
                } else if (typeof TavernHelper.createWorldbook === 'function') {
                  await TavernHelper.createWorldbook(worldName, converted);
                }
                console.log('[WI编辑器] ✅ 已创建独立世界书:', worldName);
              }
            } else {
              const converted = convertEntries();
              await replaceWorldbook(worldName, converted, { render: true });
              console.log('[WI编辑器] ✅ 已覆盖独立世界书:', worldName, `(${converted.length} 条)`);
            }
          }
        }
      } catch (e) {
        console.error('[WI编辑器] 同步世界书失败:', e);
        alert('⚠️ 同步内嵌世界书失败：' + e.message + '\n角色卡本身已更新。');
      }

      let hasScriptUpdate = false;
      for (let i = 0; i < diffs.length; i++) {
        const d = diffs[i];
        if (!selectedSet.has(i)) continue;

        if (d.key === 'first_mes') {
          if (!target.first_messages) target.first_messages = [];
          target.first_messages[0] = d.newVal;
        } else if (d.key === 'alternate_greetings') {
          if (!target.first_messages) target.first_messages = [];
          const main = target.first_messages[0] || '';
          target.first_messages = [main, ...d.newVal];
        } else if (d.key === 'tags') {
          target.tags = d.newVal;
        } else if (d.key === 'character_book') {
          target.character_book = JSON.parse(d.newVal);
        } else if (d.key === 'regex_scripts') {
          if (!target.extensions) target.extensions = {};
          target.extensions.regex_scripts = d.newVal || [];
        } else if (d.key === 'tavern_helper') {
          if (!target.extensions) target.extensions = {};
          const newTH = d.newVal || {};
          const oldTH = target.extensions.tavern_helper || {};
          target.extensions.tavern_helper = {
            ...oldTH,
            ...newTH,
            variables: (newTH.variables && Object.keys(newTH.variables).length > 0)
              ? newTH.variables
              : (oldTH.variables || {}),
          };
          hasScriptUpdate = true;
        } else if (d.key === 'world') {
          target.extensions.world = d.newVal;
        } else {
          target[d.key] = d.newVal;
        }
      }

      await saveChar();

      // 如果本次热更新带来了脚本变动，用官方 API 直接重写脚本树（不切卡）
      if (hasScriptUpdate) {
        try {
          const _ctx = SillyTavern.getContext();
          const _curIdx = Number(_ctx.characterId);
          const _curC = _ctx.characters[_curIdx];
          // 只有热更新目标是当前卡时，才能用 replaceScriptTrees
          if (_curC && chState.activeAvatar === _curC.avatar) {
            const trees = _curC.data?.extensions?.tavern_helper?.scripts
              || _curC.data?.extensions?.tavern_helper?.script_trees
              || [];
            TavernHelper.replaceScriptTrees(trees, { type: 'character' });
          }
          if (typeof loadScriptList === 'function') {
            await loadScriptList();
          }
        } catch (e) {
          console.warn('[WI编辑器] 热更新后重写脚本树失败（不影响其他字段）:', e);
        }
      }
    }

    $('#wi_ch_hotupdate').on('click', openHotUpdate);
  
    // ★ 监听角色卡切换 / 聊天加载 → 重新扫描开场白分组
    (function bindCharChangeEvent() {
      if (window.__wiCharChangeBound) return;
      window.__wiCharChangeBound = true;

      const _ctx = SillyTavern.getContext();
      if (!_ctx || !_ctx.eventSource) return;

      const handler = async () => {
        await new Promise(r => setTimeout(r, 500));
        try { await scanAndApplyGroups('char-change'); } catch (e) { err('角色卡切换扫描失败', e); }
      };

      // 各种可能的"聊天内容变了"的事件
      ['chat_changed', 'character_selected', 'chatLoaded'].forEach(evt => {
        _ctx.eventSource.on(evt, handler);
      });
      // SillyTavern 的真实事件名可能是 MESSAGE_RECEIVED / CHAT_CHANGED
      const evtTypes = _ctx.eventTypes || {};
      if (evtTypes.CHAT_CHANGED) _ctx.eventSource.on(evtTypes.CHAT_CHANGED, handler);
      if (evtTypes.CHARACTER_SELECTED) _ctx.eventSource.on(evtTypes.CHARACTER_SELECTED, handler);

      console.log('[WI编辑器] 已监听角色卡切换');
    })();

    // 监听 swipe 切换 → 重新扫描开场白分组标记
    (function bindSwipeEvent() {
      if (window.__wiSwipeEventBound) return;
      window.__wiSwipeEventBound = true;

      const _ctx = SillyTavern.getContext();
      if (!_ctx || !_ctx.eventSource) return;

      const evt = _ctx.eventTypes?.MESSAGE_SWIPED || 'message_swiped';
      _ctx.eventSource.on(evt, async (messageId) => {
        // 只有第一条消息的 swipe 切换才处理
        if (Number(messageId) !== 0) return;
        // 稍微延迟，等酒馆把新内容写完
        await new Promise(r => setTimeout(r, 200));
        try {
          await scanAndApplyGroups('swipe');
        } catch (e) {
          err('swipe 扫描失败', e);
        }
      });
      console.log('[WI编辑器] 已监听 MESSAGE_SWIPED');
    })();

    // 轮询兜底：主页按钮通过 setChatMessages 改 swipe，不触发事件
    (function startGroupPoll() {
      if (window.__wiGroupPollTimer) return;

      let lastKey = '';
      let _tick = 0;
      window.__wiGroupPollTimer = setInterval(async () => {
        _tick++;
        const $panel = $(`#${PANEL_ID}`);
        const panelVisible = $panel.length && $panel.is(':visible');

        // 面板不可见时，每 5 秒才跑一次（省性能）
        if (!panelVisible && _tick % 5 !== 0) return;
        // 面板可见但不在世界书 Tab，每 3 秒跑一次
        if (panelVisible && state.activeTab !== 'worldbook' && _tick % 3 !== 0) return;

        const text = await readFirstMessageText();
        if (!text) return;

        // 用"文本前 200 字 + 长度"做个轻量指纹
        const key = text.length + ':' + text.slice(0, 200);
        if (key === lastKey) return;
        lastKey = key;

        // 内容变了 → 尝试扫描（没标记会自动 return，不干扰）
        try {
          await scanAndApplyGroups('poll');
        } catch (e) {
          err('轮询扫描失败', e);
        }
      }, 1000);
      console.log('[WI编辑器] 已启动分组轮询（1秒一次，仅面板可见时）');
    })();
    
    // 监听角色卡增删，自动刷新角色卡列表下拉框（无论面板是否可见都刷新）
    (function bindCharListEvents() {
      if (window.__wiCharListEventsBound) return;
      window.__wiCharListEventsBound = true;

      const _ctx = SillyTavern.getContext();
      if (!_ctx || !_ctx.eventSource) return;

      const refresh = async () => {
        try {
          await loadCharList();
        } catch (e) {
          err('刷新角色卡列表失败', e);
        }
      };

      _ctx.eventSource.on('characterDeleted', refresh);
      _ctx.eventSource.on('character_duplicated', refresh);
      _ctx.eventSource.on('character_renamed', refresh);
      console.log('[WI编辑器] 已监听角色卡增删事件');
    })();

    // 切换到角色卡 Tab 时，自动刷新角色卡列表
    $('.wi-tab[data-tab="character"]').on('click', async () => {
      try {
        await flushCharSave();
        await flushCharSaveGreeting();
      } catch (e) {}
      await loadCharList();
    });

    // ============ 正则 Tab ============
    const PLACEMENT_LABELS = { 1:'用户输入', 2:'AI输出', 3:'斜杠', 4:'世界书', 5:'推理', 6:'快速回复' };
        let reState = {
      // 三个来源各自的原始数组
      sourceLists: { global: [], preset: [], character: [] },
      // 当前展示用的扁平列表（每条带 _source 和 _sourceIdx）
      list: [],
      filtered: [],
      selectedIdx: -1,
      filter: '',
      // 折叠状态：默认全部收起
      collapsed: { global: true, preset: true, character: true },
      // 当前选中条目属于哪个来源
      selectedSource: null,
    };

    const REGEX_SOURCE = {
      global:   { label: '🌐 全局',  key: 'global' },
      preset:   { label: '⚙️ 预设',  key: 'preset' },
      character:{ label: '🎭 角色卡', key: 'character' },
    };

    // 官方 TavernRegex (snake_case) → 内部格式 (camelCase)
    function tavernRegexToInternal(t) {
      const SOURCE_KEY = ['user_input', 'ai_output', 'slash_command', 'world_info', 'reasoning'];
      const PLACE_MAP = { user_input: 1, ai_output: 2, slash_command: 3, world_info: 4, reasoning: 5 };
      const placement = [];
      SOURCE_KEY.forEach(k => {
        if (t.source && t.source[k]) placement.push(PLACE_MAP[k]);
      });
      return {
        id: t.id,
        scriptName: t.script_name || '',
        findRegex: t.find_regex || '',
        replaceString: t.replace_string || '',
        trimStrings: Array.isArray(t.trim_strings) ? t.trim_strings : [],
        placement: placement.length > 0 ? placement : [2],
        disabled: t.enabled === false,
        markdownOnly: t.destination ? !t.destination.prompt : false,
        promptOnly: t.destination ? !t.destination.display : false,
        runOnEdit: !!t.run_on_edit,
        substituteRegex: 0,
        minDepth: t.min_depth == null ? null : t.min_depth,
        maxDepth: t.max_depth == null ? null : t.max_depth,
      };
    }

    // 内部格式 (camelCase) → 官方 TavernRegex (snake_case)
    function internalToTavernRegex(o) {
      const PLACE_MAP = { 1: 'user_input', 2: 'ai_output', 3: 'slash_command', 4: 'world_info', 5: 'reasoning' };
      const source = { user_input: false, ai_output: false, slash_command: false, world_info: false, reasoning: false };
      (o.placement || []).forEach(p => {
        const k = PLACE_MAP[p];
        if (k) source[k] = true;
      });
      return {
        id: o.id,
        script_name: o.scriptName || '',
        enabled: !o.disabled,
        find_regex: o.findRegex || '',
        replace_string: o.replaceString || '',
        trim_strings: Array.isArray(o.trimStrings) ? o.trimStrings : [],
        source,
        destination: {
          display: !o.promptOnly,
          prompt: !o.markdownOnly,
        },
        run_on_edit: !!o.runOnEdit,
        min_depth: o.minDepth == null ? null : o.minDepth,
        max_depth: o.maxDepth == null ? null : o.maxDepth,
      };
    }

    function readRegexBySource(source) {
      try {
        const TH = window.TavernHelper;
        if (!TH || typeof TH.getTavernRegexes !== 'function') {
          err('TavernHelper.getTavernRegexes 不可用');
          return [];
        }
        let raw = [];
        if (source === 'global') {
          raw = TH.getTavernRegexes({ type: 'global' });
        } else if (source === 'preset') {
          raw = TH.getTavernRegexes({ type: 'preset', name: 'in_use' });
        } else if (source === 'character') {
          raw = TH.getTavernRegexes({ type: 'character', name: 'current' });
        }
        if (!Array.isArray(raw)) return [];
        return raw.map(tavernRegexToInternal);
      } catch (e) {
        err('读取正则失败 (' + source + ')', e);
        return [];
      }
    }

    function getRegexList() {
      return readRegexBySource('global');
    }

    function uuid() {
      if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }

    function makeEmptyRegex() {
      return {
        id: uuid(), scriptName: '新正则', disabled: false, runOnEdit: false,
        findRegex: '', replaceString: '', trimStrings: [], placement: [2],
        substituteRegex: 0, minDepth: null, maxDepth: null,
        markdownOnly: false, promptOnly: false,
      };
    }

    function isValidRegex(src) {
      if (!src) return { ok: false, msg: '空表达式' };
      let body = src, flags = '';
      const m = src.match(/^\/([\s\S]*)\/([gimsuy]*)$/);
      if (m) { body = m[1]; flags = m[2]; }
      try {
        new RegExp(body, flags);
        return { ok: true, msg: m ? `字面量模式 /.../${flags}` : '裸表达式（酒馆按 gi 解析）' };
      } catch (e) {
        return { ok: false, msg: '❌ ' + e.message };
      }
    }

    function loadRegexIntoState() {
      // 分别读三个来源
      const g = readRegexBySource('global');
      const p = readRegexBySource('preset');
      const c = readRegexBySource('character');
      reState.sourceLists.global = g.map(o => ({ ...o }));
      reState.sourceLists.preset = p.map(o => ({ ...o }));
      reState.sourceLists.character = c.map(o => ({ ...o }));

      // 扁平化，方便搜索和定位
      reState.list = [];
      ['global', 'preset', 'character'].forEach(src => {
        reState.sourceLists[src].forEach((o, i) => {
          reState.list.push({ _source: src, _sourceIdx: i, data: o });
        });
      });

      reState.selectedIdx = -1;
      reState.selectedSource = null;
      applyRegexFilter();
    }

    function loadRegexIntoStateKeepCollapse(keepOpenSrc) {
      const g = reState.sourceLists.global;
      const p = reState.sourceLists.preset;
      const c = reState.sourceLists.character;
      reState.list = [];
      ['global', 'preset', 'character'].forEach(src => {
        const arr = src === 'global' ? g : src === 'preset' ? p : c;
        arr.forEach((o, i) => {
          reState.list.push({ _source: src, _sourceIdx: i, data: o });
        });
      });
      if (keepOpenSrc) reState.collapsed[keepOpenSrc] = false;
    }

    function applyRegexFilter() {
      const f = (reState.filter || '').trim().toLowerCase();
      if (!f) {
        reState.filtered = reState.list.map((_, i) => i);
      } else {
        reState.filtered = reState.list
          .map((o, i) => ({ o, i }))
          .filter(({ o }) => {
            const d = o.data;
            return (d.scriptName || '').toLowerCase().includes(f) ||
                   (d.findRegex || '').toLowerCase().includes(f);
          })
          .map(({ i }) => i);
      }
      renderRegexList();
    }

    function renderRegexList() {
      const $list = $('#wi_re_list').empty();
      const f = (reState.filter || '').trim().toLowerCase();
      const filteredSet = new Set(reState.filtered);

      ['global', 'preset', 'character'].forEach(src => {
        // 这个来源下的所有条目（在 reState.list 里的扁平索引）
        const groupIdxs = [];
        reState.list.forEach((item, i) => {
          if (item._source === src && filteredSet.has(i)) groupIdxs.push(i);
        });

        const totalInSrc = reState.sourceLists[src].length;
        // 搜索状态下：只显示有命中的来源；非搜索：全部显示
        if (f && groupIdxs.length === 0) return;
        if (!f && totalInSrc === 0) return; // 空的分组直接不画

        const isCollapsed = reState.collapsed[src];

        // 分组标题
        const $header = $(`<div class="wi-re-group-header" data-src="${src}" style="padding:8px 10px;cursor:pointer;background:#2a2a30;border-bottom:1px solid #444;display:flex;align-items:center;gap:6px;user-select:none">
          <span style="color:#888;font-size:10px;width:10px;display:inline-block">${isCollapsed ? '▶' : '▼'}</span>
          <span style="font-size:12px;color:#ccc;font-weight:600">${REGEX_SOURCE[src].label}</span>
          <span style="font-size:10px;color:#666">(${groupIdxs.length}${f ? ' / ' + totalInSrc : ''})</span>
        </div>`);
        $header.on('click', () => {
          reState.collapsed[src] = !reState.collapsed[src];
          renderRegexList();
        });
        $list.append($header);

        if (isCollapsed) return;

        // 分组内容
        groupIdxs.forEach(i => {
          const item = reState.list[i];
          const o = item.data;
          const enabled = !o.disabled;
          const isSel = i === reState.selectedIdx;
          const name = o.scriptName || '【无名称】';
          const placements = (o.placement || []).map(p => PLACEMENT_LABELS[p] || p).join('/');
          const findLen = (o.findRegex || '').length;
          const dotColor = enabled ? '#58b600' : '#555';
          const dotShadow = enabled ? '0 0 6px rgba(88,182,0,.6)' : 'none';

          let titleHtml = name;
          if (f) {
            const re = new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
            titleHtml = name.replace(re, m => `<mark style="background:#ffcc00;color:#000">${m}</mark>`);
          }

          const $item = $(`<div class="wi-re-item" data-idx="${i}" style="padding:8px 10px 8px 24px;cursor:pointer;border-bottom:1px solid #333;background:${isSel ? '#3a3a44' : ''}">
            <div style="display:flex;align-items:center;gap:6px">
              <span style="flex-shrink:0;width:10px;height:10px;border-radius:50%;background:${dotColor};box-shadow:${dotShadow}"></span>
              <div style="flex:1;min-width:0;font-size:12px;color:${enabled ? '#ddd' : '#777'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${titleHtml}</div>
            </div>
            <div style="font-size:10px;color:#888;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
              ${placements || '—'} · ${findLen}字
            </div>
          </div>`);

          $item.on('click', () => {
            flushRegexAutoSave();
            reState.selectedIdx = i;
            reState.selectedSource = item._source;
            fillRegexForm(item.data);
            renderRegexList();
          });

          $list.append($item);
        });
      });

      const totalAll = reState.list.length;
      const shownAll = reState.filtered.length;
      $('#wi_re_count').text(`${shownAll} / ${totalAll} 条`);
    }

    function fillRegexForm(o) {
      $('#wi_re_name').val(o.scriptName || '');
      $('#wi_re_find').val(o.findRegex || '');
      $('#wi_re_replace').val(o.replaceString || '');
      $('.wi-re-place').each(function () {
        const v = Number($(this).val());
        $(this).prop('checked', Array.isArray(o.placement) && o.placement.includes(v));
      });
      $('#wi_re_mindepth').val(o.minDepth == null ? '' : o.minDepth);
      $('#wi_re_maxdepth').val(o.maxDepth == null ? '' : o.maxDepth);
      $('#wi_re_enabled').prop('checked', !o.disabled);
      $('#wi_re_runonedit').prop('checked', !!o.runOnEdit);
      $('#wi_re_markdownonly').prop('checked', !!o.markdownOnly);
      $('#wi_re_promptonly').prop('checked', !!o.promptOnly);

      const v = isValidRegex(o.findRegex);
      $('#wi_re_find_status').text(v.msg).css('color', v.ok ? '#6ac06a' : '#e07070');
      $('#wi_re_meta').text(`id: ${o.id}`);
    }

    function clearRegexForm() {
      $('#wi_re_name').val('');
      $('#wi_re_find').val('');
      $('#wi_re_replace').val('');
      $('.wi-re-place').prop('checked', false);
      $('#wi_re_mindepth').val('');
      $('#wi_re_maxdepth').val('');
      $('#wi_re_enabled').prop('checked', true);
      $('#wi_re_runonedit').prop('checked', false);
      $('#wi_re_markdownonly').prop('checked', false);
      $('#wi_re_promptonly').prop('checked', false);
      $('#wi_re_find_status').text('');
      $('#wi_re_meta').text('');
    }

    function readRegexForm() {
      const placement = [];
      $('.wi-re-place:checked').each(function () { placement.push(Number($(this).val())); });
      const minRaw = $('#wi_re_mindepth').val();
      const maxRaw = $('#wi_re_maxdepth').val();
      return {
        scriptName: $('#wi_re_name').val(),
        findRegex: $('#wi_re_find').val(),
        replaceString: $('#wi_re_replace').val(),
        placement,
        minDepth: minRaw === '' ? null : Number(minRaw),
        maxDepth: maxRaw === '' ? null : Number(maxRaw),
        disabled: !$('#wi_re_enabled').prop('checked'),
        runOnEdit: $('#wi_re_runonedit').prop('checked'),
        markdownOnly: $('#wi_re_markdownonly').prop('checked'),
        promptOnly: $('#wi_re_promptonly').prop('checked'),
      };
    }

    function regexFormChanged(o, form) {
      const sameArr = (a, b) => {
        const x = Array.isArray(a) ? a.slice().sort() : [];
        const y = Array.isArray(b) ? b.slice().sort() : [];
        return x.length === y.length && x.every((v, i) => v === y[i]);
      };
      return (o.scriptName || '') !== form.scriptName ||
        (o.findRegex || '') !== form.findRegex ||
        (o.replaceString || '') !== form.replaceString ||
        !sameArr(o.placement, form.placement) ||
        (o.minDepth ?? null) !== form.minDepth ||
        (o.maxDepth ?? null) !== form.maxDepth ||
        !!o.disabled !== form.disabled ||
        !!o.runOnEdit !== form.runOnEdit ||
        !!o.markdownOnly !== form.markdownOnly ||
        !!o.promptOnly !== form.promptOnly;
    }

    async function autoSaveRegex() {
      if (reState.selectedIdx < 0) return;
      const item = reState.list[reState.selectedIdx];
      if (!item) return;
      const o = item.data;
      const form = readRegexForm();
      if (!regexFormChanged(o, form)) return;
      Object.assign(o, form);
      await saveRegexToSource(item._source);
      applyRegexFilter();
    }

    async function saveRegexToSource(src) {
      try {
        const TH = window.TavernHelper;
        if (!TH || typeof TH.replaceTavernRegexes !== 'function') {
          err('TavernHelper.replaceTavernRegexes 不可用');
          return;
        }
        const internalList = reState.sourceLists[src] || [];
        const tavernList = internalList.map(internalToTavernRegex);

        let option;
        if (src === 'global') {
          option = { type: 'global' };
        } else if (src === 'preset') {
          option = { type: 'preset', name: 'in_use' };
        } else if (src === 'character') {
          option = { type: 'character', name: 'current' };
        } else {
          return;
        }

        await TH.replaceTavernRegexes(tavernList, option);
        log('✅ 正则已写回 (' + src + ')');
      } catch (e) {
        err('保存正则失败 (' + src + ')', e);
      }
    }
    
    let _reTimer = null;
    function scheduleRegexAutoSave() {
      if (_reTimer) clearTimeout(_reTimer);
      _reTimer = setTimeout(() => { _reTimer = null; autoSaveRegex(); }, 600);
    }
    function flushRegexAutoSave() {
      if (_reTimer) {
        clearTimeout(_reTimer);
        _reTimer = null;
        return autoSaveRegex();
      }
      return Promise.resolve();
    }

    $('#wi_re_search').on('input', function () {
      reState.filter = $(this).val() || '';
      applyRegexFilter();
    });

    $('#wi_re_new').on('click', async () => {
      await flushRegexAutoSave();
      const src = reState.selectedSource || 'global';
      const o = makeEmptyRegex();
      reState.sourceLists[src].push(o);

      loadRegexIntoStateKeepCollapse(src);

      const newIdx = reState.list.findIndex(it => it._source === src && it.data === o);
      if (newIdx >= 0) {
        reState.selectedIdx = newIdx;
        reState.selectedSource = src;
        fillRegexForm(o);
      }
      await saveRegexToSource(src);
      applyRegexFilter();
      $('#wi_re_name').focus();
    });

    $('#wi_re_refresh').on('click', async () => {
      await flushRegexAutoSave();
      loadRegexIntoState();
      clearRegexForm();
      applyRegexFilter();
    });

    $('#wi_re_dup').on('click', async () => {
      if (reState.selectedIdx < 0) { alert('请先选择一条正则'); return; }
      await flushRegexAutoSave();
      const item = reState.list[reState.selectedIdx];
      const src = item._source;
      const srcList = reState.sourceLists[src];
      const srcIdx = item._sourceIdx;
      const copy = JSON.parse(JSON.stringify(item.data));
      copy.id = uuid();
      copy.scriptName = (item.data.scriptName || '正则') + ' 副本';
      srcList.splice(srcIdx + 1, 0, copy);

      await saveRegexToSource(src);
      loadRegexIntoStateKeepCollapse(src);
      const newIdx = reState.list.findIndex(it => it._source === src && it.data === copy);
      if (newIdx >= 0) {
        reState.selectedIdx = newIdx;
        reState.selectedSource = src;
        fillRegexForm(copy);
      }
      applyRegexFilter();
    });

    $('#wi_re_del').on('click', async () => {
      if (reState.selectedIdx < 0) { alert('请先选择一条正则'); return; }
      const item = reState.list[reState.selectedIdx];
      const o = item.data;
      if (!confirm(`确定删除正则「${o.scriptName || '无名称'}」？`)) return;
      const src = item._source;
      reState.sourceLists[src].splice(item._sourceIdx, 1);
      reState.selectedIdx = -1;
      reState.selectedSource = null;
      await saveRegexToSource(src);
      loadRegexIntoStateKeepCollapse(src);
      applyRegexFilter();
      clearRegexForm();
    });

    $('#wi_re_sync').on('click', async () => {
      await flushRegexAutoSave();
      const src = reState.selectedSource;
      if (!src) {
        await saveRegexToSource('global');
        await saveRegexToSource('preset');
        await saveRegexToSource('character');
      } else {
        await saveRegexToSource(src);
      }
      // 官方 API 已经会重新载入聊天，无需手动刷页
    });
    
    $('#wi_re_find').on('input', function () {
      const v = isValidRegex($(this).val());
      $('#wi_re_find_status').text(v.msg).css('color', v.ok ? '#6ac06a' : '#e07070');
      scheduleRegexAutoSave();
    }).on('blur', flushRegexAutoSave);

    $('#wi_re_name, #wi_re_replace, #wi_re_mindepth, #wi_re_maxdepth')
      .on('input', scheduleRegexAutoSave)
      .on('blur', flushRegexAutoSave);

    $('#wi_re_placement').on('change', '.wi-re-place', scheduleRegexAutoSave);
    $('#wi_re_enabled, #wi_re_runonedit, #wi_re_markdownonly, #wi_re_promptonly')
      .on('change', scheduleRegexAutoSave);

    loadRegexIntoState();
    clearRegexForm();

    $(`.wi-tab[data-tab="regex"]`).on('click', () => {
      if (reState.selectedIdx < 0) {
        loadRegexIntoState();
      }
    });

    // ============ 主题 Tab ============
    let thState = {
      allThemes: [],         // [{ name }]  从 #themes 读
      groups: {},            // { 分组名: [主题名, ...] }
      groupOrder: [],        // 分组顺序
      collapsed: {},         // { 分组名: true/false }
      ungrouped: '未分组',    // 默认分组名
      filter: '',            // 搜索关键词
    };

    // CSS 编辑模式状态
    let thEdit = {
      active: false,
      themeName: '',
      originalCss: '',       // 进入编辑时的 CSS（用于"放弃"和"撤销"）
      currentCss: '',        // 当前 textarea 内容（实时生效）
      cssTag: null,          // 我们注入的临时 <style> 标签
    };

    // 从 localStorage 读分组配置
    function loadThemeGroups() {
      try {
        const raw = localStorage.getItem('wi_theme_groups');
        if (raw) {
          const data = JSON.parse(raw);
          thState.groups = data.groups || {};
          thState.groupOrder = data.groupOrder || [];
          thState.collapsed = data.collapsed || {};
        }
      } catch (e) { err('读取主题分组失败', e); }
    }

    // 存分组配置
    function saveThemeGroups() {
      try {
        localStorage.setItem('wi_theme_groups', JSON.stringify({
          groups: thState.groups,
          groupOrder: thState.groupOrder,
          collapsed: thState.collapsed,
        }));
      } catch (e) { err('保存主题分组失败', e); }
    }

    // 读所有主题名（从 #themes 下拉框）
    function readAllThemeNames() {
      const sel = __wiRootDoc.querySelector('#themes');
      if (!sel) return [];
      return Array.from(sel.options).map(o => o.value).filter(Boolean);
    }

    // 拿当前应用的主题
    function getCurrentTheme() {
      const sel = __wiRootDoc.querySelector('#themes');
      return sel ? sel.value : '';
    }

    // 应用主题
    function applyThemeByName(name) {
      const sel = __wiRootDoc.querySelector('#themes');
      if (!sel) return;
      sel.value = name;
      // ★ 必须用原生 dispatchEvent，才能触发酒馆/败白用 addEventListener 绑的 change handler
      //   （jQuery.trigger('change') 只触发 jQuery handler，原生 handler 不响）
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[WI编辑器] 应用主题（原生事件）:', name);
    }

    // 确保所有主题都在某个分组里
    function normalizeThemeGroups() {
      // 收集所有分组里的主题
      const inGroups = new Set();
      Object.values(thState.groups).forEach(arr => arr.forEach(n => inGroups.add(n)));

      // 不在任何分组的主题，塞到"未分组"
      if (!thState.groups[thState.ungrouped]) {
        thState.groups[thState.ungrouped] = [];
      }
      thState.allThemes.forEach(({ name }) => {
        if (!inGroups.has(name)) {
          if (!thState.groups[thState.ungrouped].includes(name)) {
            thState.groups[thState.ungrouped].push(name);
          }
        }
      });

      // 清理已不存在的主题
      const allNames = new Set(thState.allThemes.map(t => t.name));
      Object.keys(thState.groups).forEach(g => {
        thState.groups[g] = thState.groups[g].filter(n => allNames.has(n));
      });

      // 确保分组顺序里有所有分组
      Object.keys(thState.groups).forEach(g => {
        if (!thState.groupOrder.includes(g)) thState.groupOrder.push(g);
      });
      thState.groupOrder = thState.groupOrder.filter(g => thState.groups[g]);
    }

    // 读主题列表
    function loadThemeList() {
      thState.allThemes = readAllThemeNames().map(name => ({ name }));
      normalizeThemeGroups();
      renderThemeList();
      const $c = $('#wi_th_count');
      if ($c.length) $c.text(`${thState.allThemes.length} 个主题`);
    }

    // 渲染主题列表
    function renderThemeList() {
      const $list = $('#wi_th_list').empty();
      const cur = getCurrentTheme();

      if (thState.allThemes.length === 0) {
        $list.append('<div style="color:#888;text-align:center;padding:40px;font-size:13px">没有读取到主题。请确认酒馆设置里有主题列表。</div>');
        return;
      }

      // 搜索过滤
      const filterRaw = (thState.filter || '').trim().toLowerCase();
      const matchFilter = (name) => {
        if (!filterRaw) return true;
        return (name || '').toLowerCase().includes(filterRaw);
      };
      // 搜索时，把匹配到的主题名高亮
      const highlightName = (name) => {
        const safe = escapeHtml(name);
        if (!filterRaw) return safe;
        // 高亮匹配部分
        const lower = name.toLowerCase();
        const idx = lower.indexOf(filterRaw);
        if (idx < 0) return safe;
        const before = escapeHtml(name.slice(0, idx));
        const match = escapeHtml(name.slice(idx, idx + filterRaw.length));
        const after = escapeHtml(name.slice(idx + filterRaw.length));
        return `${before}<mark style="background:#ffcc00;color:#000;padding:0 1px;border-radius:2px">${match}</mark>${after}`;
      };

      let totalShown = 0;

      thState.groupOrder.forEach(gname => {
        const allInGroup = thState.groups[gname] || [];
        // 搜索时，过滤组内主题
        const themesInGroup = filterRaw ? allInGroup.filter(matchFilter) : allInGroup;
        // 空分组也显示标题，方便接收拖拽；但"未分组"没内容时也隐藏
        if (themesInGroup.length === 0 && gname === thState.ungrouped) return;
        // 搜索时，跳过没匹配的分组
        if (filterRaw && themesInGroup.length === 0) return;

        totalShown += themesInGroup.length;

        const collapsed = thState.collapsed[gname] === true;

        // 分组标题
        const $header = $(`<div class="wi-th-group-header" data-group="${escapeHtml(gname)}" style="padding:8px 10px;cursor:pointer;background:#2a2a30;border-bottom:1px solid #444;display:flex;align-items:center;gap:6px;user-select:none;margin-top:8px;border-radius:4px">
          <span style="color:#888;font-size:10px;width:10px;display:inline-block">${collapsed ? '▶' : '▼'}</span>
          <span style="font-size:12px;color:#ccc;font-weight:600">${escapeHtml(gname)}</span>
          <span style="font-size:10px;color:#666">(${themesInGroup.length})</span>
          <span style="flex:1"></span>
          <span class="wi-th-group-menu" data-group="${escapeHtml(gname)}" style="font-size:12px;color:#888;cursor:pointer;padding:0 4px" title="分组菜单">⋯</span>
        </div>`);
        $header.on('click', (ev) => {
          // 点菜单图标不折叠
          if ($(ev.target).hasClass('wi-th-group-menu')) return;
          thState.collapsed[gname] = !collapsed;
          saveThemeGroups();
          renderThemeList();
        });
        $header.find('.wi-th-group-menu').on('click', (ev) => {
          ev.stopPropagation();
          openThemeGroupMenu(ev, gname);
        });
        // ====== 分组标题接收拖拽 ======
        let __expandTimer = null;
        $header.on('dragover', function (ev) {
          const st = window.__wiDragState;
          if (!st) return;
          if (st.fromGroup === gname) return; // 同组不处理
          ev.preventDefault();
          ev.stopPropagation();
          ev.originalEvent.dataTransfer.dropEffect = 'move';
          $(this).css({ background: 'var(--wi-selected)', borderColor: 'var(--wi-accent)' });
          // 下面还有原有的逻辑，保持

          // 折叠状态下，悬停 600ms 自动展开
          if (thState.collapsed[gname] === true && !__expandTimer) {
            __expandTimer = setTimeout(() => {
              thState.collapsed[gname] = false;
              saveThemeGroups();
              renderThemeList();
              __expandTimer = null;
            }, 600);
          }
        });

        $header.on('dragleave', function () {
          $(this).css({ background: 'var(--wi-bg-3)', borderColor: '' });
          if (__expandTimer) {
            clearTimeout(__expandTimer);
            __expandTimer = null;
          }
        });

        $header.on('dragleave', function () {
          $(this).css({ background: 'var(--wi-bg-3)', borderColor: '' });
          if (__expandTimer) {
            clearTimeout(__expandTimer);
            __expandTimer = null;
          }
        });

        $header.on('drop', function (ev) {
          const st = window.__wiDragState;
          if (!st) return;
          if (st.fromGroup === gname) return;
          ev.preventDefault();
          ev.stopPropagation();

          $(this).css({ background: 'var(--wi-bg-3)', borderColor: '' });

          // 从原分组移除
          if (thState.groups[st.fromGroup]) {
            thState.groups[st.fromGroup] = thState.groups[st.fromGroup].filter(n => n !== st.name);
          }
          // 追加到目标分组
          if (!thState.groups[gname]) thState.groups[gname] = [];
          thState.groups[gname].push(st.name);

          saveThemeGroups();
          renderThemeList();
        });
        $list.append($header);

        if (collapsed) return;

        // 主题卡片
        themesInGroup.forEach(name => {
          const isCurrent = name === cur;
          const $card = $(`<div class="wi-th-card" data-name="${escapeHtml(name)}" style="padding:10px 12px;margin:4px 0;background:${isCurrent ? '#2d4a2d' : '#232326'};border:1px solid ${isCurrent ? '#4a7a4a' : '#333'};border-radius:4px;cursor:pointer;display:flex;align-items:center;gap:8px">
            <span style="font-size:13px;color:${isCurrent ? '#cfc' : '#ddd'};flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(name)}</span>
            ${isCurrent ? '<span style="font-size:10px;color:#6ac06a">✓ 当前</span>' : ''}
            <span class="wi-th-card-menu" data-name="${escapeHtml(name)}" style="font-size:12px;color:#888;cursor:pointer;padding:0 4px">⋯</span>
          </div>`);

          // ====== 拖拽（最简版）======
          $card.attr('draggable', 'true');
          $card.attr('data-card-group', gname);

          $card.on('dragstart', function (ev) {
            ev.stopPropagation();
            ev.originalEvent.dataTransfer.effectAllowed = 'move';
            ev.originalEvent.dataTransfer.setData('text/plain', name);
            $(this).css('opacity', 0.4);
            window.__wiDragState = { name, fromGroup: gname };
          });

          $card.on('dragend', function (ev) {
            $(this).css('opacity', 1);
            $('.wi-th-card.wi-th-drag-above, .wi-th-card.wi-th-drag-below').removeClass('wi-th-drag-above wi-th-drag-below');
            $('.wi-th-group-header').css({ background: '' });
            window.__wiDragState = null;
          });

          // 拖动悬停在本组另一张卡上时，显示横线
          $card.on('dragover', function (ev) {
            const st = window.__wiDragState;
            if (!st) return;
            if (st.name === name) return;
            // 允许跨组：如果来自别的分组，也显示横线
            ev.preventDefault();
            ev.stopPropagation();
            ev.originalEvent.dataTransfer.dropEffect = 'move';
            const rect = this.getBoundingClientRect();
            const y = ev.originalEvent.clientY;
            const isLowerHalf = (y - rect.top) > (rect.height / 2);
            // ★ 用 class 而不是内联样式，避免叠加/覆盖原样式
            $('.wi-th-card.wi-th-drag-above, .wi-th-card.wi-th-drag-below').removeClass('wi-th-drag-above wi-th-drag-below');
            $(this).addClass(isLowerHalf ? 'wi-th-drag-below' : 'wi-th-drag-above');
            return false;
          });

          $card.on('dragleave', function () {
            $(this).removeClass('wi-th-drag-above wi-th-drag-below');
          });

          $card.on('drop', async function (ev) {
            const st = window.__wiDragState;
            if (!st) return;
            if (st.name === name) return;
            ev.preventDefault();
            ev.stopPropagation();

            const rect = this.getBoundingClientRect();
            const y = ev.originalEvent.clientY;
            const isLowerHalf = (y - rect.top) > (rect.height / 2);

            // 计算目标分组里的插入位置（在移除原分组前先记录）
            const targetArr = thState.groups[gname];
            let targetIdx = targetArr.indexOf(name);
            if (targetIdx < 0) return;
            if (isLowerHalf) targetIdx += 1;

            // 从原分组移除
            if (thState.groups[st.fromGroup]) {
              thState.groups[st.fromGroup] = thState.groups[st.fromGroup].filter(n => n !== st.name);
            }

            // 目标分组重新查一次位置
            const finalArr = thState.groups[gname];
            if (!finalArr) return;
            // 目标分组里可能已经包含 st.name？不会，上面已经移除了。
            // 重新计算 targetIdx：如果目标项在组里
            let finalIdx = finalArr.indexOf(name);
            if (finalIdx < 0) {
              // 目标项不在了（可能被别的地方删了），直接追加
              finalArr.push(st.name);
            } else {
              if (isLowerHalf) finalIdx += 1;
              finalArr.splice(finalIdx, 0, st.name);
            }

            $('.wi-th-card.wi-th-drag-above, .wi-th-card.wi-th-drag-below').removeClass('wi-th-drag-above wi-th-drag-below');
            saveThemeGroups();
            renderThemeList();
          });

          $card.on('click', (ev) => {
            if ($(ev.target).hasClass('wi-th-card-menu')) return;
            applyThemeByName(name);
            // 稍等刷新列表（等 change 事件跑完）
            setTimeout(renderThemeList, 300);
          });

          $card.find('.wi-th-card-menu').on('click', (ev) => {
            ev.stopPropagation();
            openThemeCardMenu(ev, name);
          });

          $list.append($card);
        });
      });

      const $c = $('#wi_th_count');
      if ($c.length) {
        if (filterRaw) {
          $c.text(`匹配 ${totalShown} / ${thState.allThemes.length} 个`);
        } else {
          $c.text(`${thState.allThemes.length} 个主题`);
        }
      }
    }

    // ============ 悬浮小菜单 ============
    let __wiMiniMenuEl = null;
    function closeMiniMenu() {
      if (__wiMiniMenuEl && __wiMiniMenuEl.parentNode) {
        __wiMiniMenuEl.parentNode.removeChild(__wiMiniMenuEl);
      }
      __wiMiniMenuEl = null;
    }
    function showMiniMenu(ev, items) {
      try { ev.preventDefault(); } catch (e) {}
      try { ev.stopPropagation(); } catch (e) {}

      // jQuery 事件的 clientX 可能在 originalEvent 里
      const rawEv = ev.originalEvent || ev;
      let evX = Number(rawEv.clientX);
      let evY = Number(rawEv.clientY);
      // 兜底：如果拿不到坐标（比如 trigger 出来的事件），用鼠标当前位置或者屏幕中央
      if (!isFinite(evX) || evX < 0 || evX > window.innerWidth) evX = Math.round(window.innerWidth / 2);
      if (!isFinite(evY) || evY < 0 || evY > window.innerHeight) evY = Math.round(window.innerHeight / 2);

      closeMiniMenu();

      const menu = __wiRootDoc.createElement('div');
      menu.className = 'wi-mini-menu';
      menu.style.cssText = `
        position: fixed;
        z-index: 2147483647;
        background: #2a2a30;
        border: 1px solid #4a4a52;
        border-radius: 6px;
        padding: 4px 0;
        min-width: 160px;
        box-shadow: 0 4px 16px rgba(0,0,0,.5);
        font-size: 12px;
        color: #ddd;
        user-select: none;
      `;

      items.forEach(item => {
        if (item.divider) {
          const d = __wiRootDoc.createElement('div');
          d.style.cssText = 'height:1px;background:#3a3a42;margin:4px 0;';
          menu.appendChild(d);
          return;
        }
        const row = __wiRootDoc.createElement('div');
        row.style.cssText = 'padding:6px 12px;cursor:pointer;white-space:nowrap;';
        row.textContent = item.label;
        if (item.danger) row.style.color = '#e07070';
        row.addEventListener('mouseenter', () => {
          row.style.background = item.danger ? '#4a2020' : '#3a3a45';
        });
        row.addEventListener('mouseleave', () => {
          row.style.background = 'transparent';
        });
        row.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          closeMiniMenu();
          try { item.action(); } catch (err) { err('菜单动作出错', err); }
        });
        menu.appendChild(row);
      });

      __wiRootDoc.body.appendChild(menu);
      __wiMiniMenuEl = menu;

      // 定位：贴到触发元素（⋯ 按钮）旁边
      const menuRect = menu.getBoundingClientRect();
      let x, y;

      // 拿到触发元素（jQuery 事件对象上有 currentTarget，也可能是 ev.target）
      const triggerEl = ev.currentTarget || (rawEv && rawEv.target) || null;

      if (triggerEl && triggerEl.getBoundingClientRect) {
        const trigRect = triggerEl.getBoundingClientRect();
        // 默认：菜单放在触发元素右下
        x = trigRect.right + 4;
        y = trigRect.top;
        // 右边放不下 → 放到左边
        if (x + menuRect.width > window.innerWidth - 8) {
          x = trigRect.left - menuRect.width - 4;
        }
        // 下边放不下 → 上移
        if (y + menuRect.height > window.innerHeight - 8) {
          y = trigRect.bottom - menuRect.height;
        }
      } else {
        // 拿不到触发元素时，退回到鼠标位置 / 屏幕中央
        x = evX;
        y = evY;
        if (x + menuRect.width > window.innerWidth - 8) x = window.innerWidth - menuRect.width - 8;
        if (y + menuRect.height > window.innerHeight - 8) y = y - menuRect.height;
      }

      if (x < 8) x = 8;
      if (y < 8) y = 8;
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';

      // 点外部关闭
      setTimeout(() => {
        const handler = (e) => {
          if (!__wiMiniMenuEl) {
            __wiRootDoc.removeEventListener('click', handler, true);
            return;
          }
          if (!__wiMiniMenuEl.contains(e.target)) {
            closeMiniMenu();
            __wiRootDoc.removeEventListener('click', handler, true);
          }
        };
        __wiRootDoc.addEventListener('click', handler, true);
      }, 0);
    }
    window.__wiShowMiniMenu = showMiniMenu;

    // 分组菜单

    function openThemeGroupMenu(ev, gname) {
      const items = [
        {
          label: '✏️ 重命名分组',
          action: () => {
            const newName = prompt('新分组名：', gname);
            if (!newName || newName === gname) return;
            if (thState.groups[newName]) { alert('已存在同名分组'); return; }
            thState.groups[newName] = thState.groups[gname];
            delete thState.groups[gname];
            thState.groupOrder = thState.groupOrder.map(g => g === gname ? newName : g);
            if (thState.collapsed[gname] !== undefined) {
              thState.collapsed[newName] = thState.collapsed[gname];
              delete thState.collapsed[gname];
            }
            saveThemeGroups();
            renderThemeList();
          },
        },
        { divider: true },
        {
          label: '🗑️ 删除分组',
          danger: true,
          action: () => {
            if (gname === thState.ungrouped) { alert('不能删除"未分组"'); return; }
            if (!confirm(`确定删除分组「${gname}」？\n\n分组里的主题会移到「${thState.ungrouped}」。`)) return;
            const moved = thState.groups[gname] || [];
            delete thState.groups[gname];
            if (!thState.groups[thState.ungrouped]) thState.groups[thState.ungrouped] = [];
            moved.forEach(n => {
              if (!thState.groups[thState.ungrouped].includes(n)) {
                thState.groups[thState.ungrouped].push(n);
              }
            });
            thState.groupOrder = thState.groupOrder.filter(g => g !== gname);
            delete thState.collapsed[gname];
            saveThemeGroups();
            renderThemeList();
          },
        },
      ];
      showMiniMenu(ev, items);
    }

    // 主题卡片菜单
    function openThemeCardMenu(ev, name) {
      // ★ 关键：在 showMiniMenu 调用前（异步前）抓取触发元素
      const triggerEl = ev.currentTarget || ev.target;
      const items = [
        {
          label: '✏️ 编辑 CSS',
          action: () => {
            // 如果已经有编辑在进行，先询问
            if (thEdit.active && thEdit.themeName !== name) {
              if (!confirm(`当前正在编辑「${thEdit.themeName}」的 CSS。\n\n是否放弃当前编辑，切换到「${name}」？`)) return;
              exitThemeEditMode(true);
            }
            enterThemeEditMode(name);
          },
        },
        {
          label: '📁 移到其它分组',
          action: () => openMoveToGroupDialog(name, triggerEl),
        },
        {
          label: '➡️ 从面板移除',
          action: () => {
            if (!confirm(`确定从 WI 面板移除「${name}」？\n\n这只从面板列表里去掉，不会删除酒馆主题。`)) return;
            Object.keys(thState.groups).forEach(g => {
              thState.groups[g] = thState.groups[g].filter(n => n !== name);
            });
            saveThemeGroups();
            renderThemeList();
          },
        },
        { divider: true },
        {
          label: '🗑️ 彻底删除',
          danger: true,
          action: () => deleteThemeFromTavern(name),
        },
      ];
      showMiniMenu(ev, items);
    }

    // 移到一个分组（悬浮子菜单）
    function openMoveToGroupDialog(name, triggerEl) {
      // 收集所有分组名 + 允许新建
      const groups = thState.groupOrder.slice();
      const items = groups.map(g => ({
        label: (g === thState.ungrouped ? '📥 ' : '📁 ') + g,
        action: () => {
          Object.keys(thState.groups).forEach(k => {
            thState.groups[k] = thState.groups[k].filter(n => n !== name);
          });
          if (!thState.groups[g]) {
            thState.groups[g] = [];
            thState.groupOrder.push(g);
          }
          thState.groups[g].push(name);
          saveThemeGroups();
          renderThemeList();
        },
      }));
      items.push({ divider: true });
      items.push({
        label: '＋ 新建分组…',
        action: () => {
          const newGroup = prompt('新分组名：', '');
          if (!newGroup) return;
          Object.keys(thState.groups).forEach(k => {
            thState.groups[k] = thState.groups[k].filter(n => n !== name);
          });
          if (!thState.groups[newGroup]) {
            thState.groups[newGroup] = [];
            thState.groupOrder.push(newGroup);
          }
          thState.groups[newGroup].push(name);
          saveThemeGroups();
          renderThemeList();
        },
      });

      // ★ 用 triggerEl 定位（跟原菜单一样的位置）
      const fakeEv = {
        preventDefault: () => {},
        stopPropagation: () => {},
        currentTarget: triggerEl || null,
        target: triggerEl || null,
        clientX: triggerEl ? 0 : Math.max(20, window.innerWidth / 2 - 80),
        clientY: triggerEl ? 0 : Math.max(20, window.innerHeight / 2 - 80),
      };
      showMiniMenu(fakeEv, items);
    }

    // 从酒馆彻底删除一个主题
    async function deleteThemeFromTavern(name) {
      if (!confirm(`⚠️ 确定要彻底删除主题「${name}」？\n\n这会调用酒馆 API 从后端删除，无法撤销。`)) return;

      const ctx = SillyTavern.getContext();
      const headers = ctx.getRequestHeaders ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' };

      try {
        const r = await fetch('/api/themes/delete', {
          method: 'POST',
          headers,
          body: JSON.stringify({ name }),
        });

        if (!r.ok) {
          alert(`❌ 删除失败：HTTP ${r.status}`);
          return;
        }

        // 1. 从 #themes 下拉框移除 option
        const sel = __wiRootDoc.querySelector('#themes');
        if (sel) {
          const opt = Array.from(sel.options).find(o => o.value === name);
          if (opt) opt.remove();
        }

        // 2. 从 WI 分组里移除
        Object.keys(thState.groups).forEach(g => {
          thState.groups[g] = thState.groups[g].filter(n => n !== name);
        });
        saveThemeGroups();

        // 3. 如果删的是当前主题，切到第一个可用的
        const curSel = __wiRootDoc.querySelector('#themes');
        if (curSel && curSel.value === name) {
          const firstOpt = curSel.options[0];
          if (firstOpt) {
            applyThemeByName(firstOpt.value);
          }
        }

        // 4. 刷新 WI 列表
        loadThemeList();

        console.log('[WI编辑器] 已删除主题:', name);
      } catch (e) {
        err('删除主题失败', e);
        alert('❌ 删除失败：' + e.message);
      }
    }

    // ============ 脚本 Tab ============
    let scState = {
      list: [],
      filtered: [],
      selectedIdx: -1,
      filter: '',
      activeChar: null,
      selectedIds: new Set(),      // ★ 多选：存选中脚本的 id
    };

    async function loadCharSelect() {
      const ctx = SillyTavern.getContext();
      const $sel = $('#wi_sc_char_select').empty();
      const currentIdx = Number(ctx.characterId);
      ctx.characters.forEach((c, i) => {
        if (!c) return;
        const label = `${c.name || '(无名)'} (${c.avatar || i})`;
        $sel.append($('<option>').val(String(i)).text(label).css({ background: '#ffffff', color: '#2c3440' }));
      });
      // 默认选中当前对话的角色卡
      if (currentIdx >= 0 && ctx.characters[currentIdx]) {
        $sel.val(String(currentIdx));
        scState.activeChar = String(currentIdx);
      } else if (ctx.characters.length > 0) {
        $sel.val('0');
        scState.activeChar = '0';
      }
    }

    async function loadScriptList() {
      try {
        if (!scState.activeChar) {
          await loadCharSelect();
        }
        const ctx = SillyTavern.getContext();
        const idx = Number(scState.activeChar);
        const c = ctx.characters[idx];
        if (!c) {
          console.warn('[WI编辑器] 角色卡 index 无效:', scState.activeChar);
          scState.list = [];
          applyScriptFilter();
          return;
        }
        // ★ 当前卡：用内存数据（快）。非当前卡：用 getCharacter 从磁盘读完整卡
        const curIdx2 = Number(ctx.characterId);
        const curC2 = ctx.characters[curIdx2];
        const isCurrent = curC2 && curC2.avatar === c.avatar;

        let trees = [];
        if (isCurrent) {
          const th = c.data?.extensions?.tavern_helper || {};
          trees = th.scripts || th.script_trees || [];
        } else {
          // 非当前卡 → 从磁盘读完整卡
          try {
            const fullChar = await TavernHelper.getCharacter(c.avatar);
            const th = fullChar?.extensions?.tavern_helper || {};
            trees = th.scripts || th.script_trees || [];
          } catch (e) {
            console.warn('[WI编辑器] 从磁盘读取脚本树失败:', e);
            trees = [];
          }
        }
        // 记住原始树，供后续新建/删除/重排使用
        scState._rawTree = trees;
        const flat = [];
        function walk(nodes, parentPath) {
          if (!Array.isArray(nodes)) return;
          nodes.forEach(node => {
            if (node.type === 'script') {
              flat.push({
                ...node,
                _path: parentPath ? parentPath + ' / ' + node.name : node.name,
              });
            } else if (node.type === 'folder' && Array.isArray(node.children)) {
              walk(node.children, parentPath ? parentPath + ' / ' + node.name : node.name);
            }
          });
        }
        walk(trees, '');
        scState.list = flat;
        scState.selectedIdx = -1;
        applyScriptFilter();
      } catch (e) {
        err('加载脚本列表失败', e);
        // 把具体错误显示到 count 上，方便排查
        $('#wi_sc_count').text('错误：' + (e?.message || String(e))).css('color', '#e07070');
        // 同时尝试写入 list 头部
        const $list = $('#wi_sc_list').empty();
        $list.append(`<div style="color:#e07070;padding:12px;font-size:11px;font-family:monospace;white-space:pre-wrap;word-break:break-all">${escapeHtml(String(e?.stack || e?.message || e), 2000)}</div>`);
      }
    }

    function applyScriptFilter() {
      const f = (scState.filter || '').trim().toLowerCase();
      if (!f) {
        scState.filtered = scState.list.map((_, i) => i);
      } else {
        scState.filtered = scState.list
          .map((o, i) => ({ o, i }))
          .filter(({ o }) => (o.name || '').toLowerCase().includes(f))
          .map(({ i }) => i);
      }
      renderScriptList();
    }

    function renderScriptList() {
      const $list = $('#wi_sc_list').empty();
      updateScMultiCount();
      const f = (scState.filter || '').trim().toLowerCase();

      if (scState.filtered.length === 0) {
        $list.append('<div style="color:#888;text-align:center;padding:20px;font-size:12px">还没有脚本，点"＋ 新建脚本"</div>');
        $('#wi_sc_count').text('0 个');
        return;
      }

      scState.filtered.forEach(i => {
        const o = scState.list[i];
        const isSel = i === scState.selectedIdx;
        const enabled = o.enabled !== false;
        const isChecked = o.id && scState.selectedIds.has(o.id);
        const dotColor = enabled ? '#58b600' : '#555';
        const dotShadow = enabled ? '0 0 6px rgba(88,182,0,.6)' : 'none';

        let titleHtml = o.name || '【无名称】';
        if (f) {
          const re = new RegExp(f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
          titleHtml = titleHtml.replace(re, m => `<mark style="background:#ffcc00;color:#000">${m}</mark>`);
        }

        const bg = isSel ? '#3a3a44' : (isChecked ? 'rgba(74,158,255,0.1)' : '');
        const $item = $(`<div style="padding:8px 10px;cursor:pointer;border-bottom:1px solid #333;background:${bg};display:flex;align-items:center;gap:8px">
          <input type="checkbox" class="wi-sc-multi" data-idx="${i}" ${isChecked ? 'checked' : ''} style="cursor:pointer;flex-shrink:0" title="多选">
          <input type="checkbox" class="wi-sc-toggle" data-idx="${i}" ${enabled ? 'checked' : ''} style="cursor:pointer;flex-shrink:0" title="启用/禁用">
          <span style="flex-shrink:0;width:8px;height:8px;border-radius:50%;background:${dotColor};box-shadow:${dotShadow}"></span>
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;color:${enabled ? '#ddd' : '#777'};white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${titleHtml}</div>
            <div style="font-size:10px;color:#888;margin-top:2px">${(o.content || '').length} 字节</div>
          </div>
        </div>`);

        // 多选框
        $item.find('.wi-sc-multi').on('click', (ev) => {
          ev.stopPropagation();
          const checked = $(ev.target).is(':checked');
          if (!o.id) return;
          if (checked) scState.selectedIds.add(o.id);
          else scState.selectedIds.delete(o.id);
          $item.css('background', checked ? 'rgba(74,158,255,0.1)' : (isSel ? '#3a3a44' : ''));
          updateScMultiCount();
        });

        // 启用/禁用
        $item.find('.wi-sc-toggle').on('click', async (ev) => {
          ev.stopPropagation();
          const checked = $(ev.target).is(':checked');
          o.enabled = checked;
          try {
            await saveScriptTree(scState.list);
            renderScriptList();
          } catch (e) {
            alert('切换启用失败：' + e.message);
            $(ev.target).prop('checked', !checked);
          }
        });

        $item.on('click', (ev) => {
          if (ev.target.tagName === 'INPUT') return;
          scState.selectedIdx = i;
          fillScriptForm(o);
          renderScriptList();
        });

        $list.append($item);
      });

      $('#wi_sc_count').text(`${scState.filtered.length} / ${scState.list.length} 个`);
    }

    // CodeMirror 实例（懒创建）
    let __wiScEditor = null;
    async function ensureScEditor() {
      if (__wiScEditor) return __wiScEditor;
      // 等 CodeMirror 就绪
      if (window.__wiCodeMirrorReady) {
        try { await window.__wiCodeMirrorReady; } catch (e) {}
      }
      const w = (window.top && window.top !== window) ? window.top : window;
      const CM = w.CodeMirror;
      if (typeof CM !== 'function') {
        console.warn('[WI编辑器] CodeMirror 不可用，退回 textarea');
        $('#wi_sc_code').css('display', '').css('width', '100%').css('height', '320px');
        return null;
      }
      const wrapEl = __wiRootDoc.getElementById('wi_sc_code_wrap');
      if (!wrapEl) return null;
      // 移除 fallback textarea（保留引用）
      __wiScEditor = CM(wrapEl, {
        value: '',
        mode: 'javascript',
        lineNumbers: true,
        matchBrackets: true,
        autoCloseBrackets: true,
        indentUnit: 2,
        tabSize: 2,
        lineWrapping: false,
        styleActiveLine: true,
      });
      // 主题适配
      const editorEl = __wiScEditor.getWrapperElement();
      editorEl.style.fontSize = '11px';
      editorEl.style.fontFamily = 'monospace';
      editorEl.style.height = '320px';
      editorEl.style.background = 'var(--wi-bg-2)';
      editorEl.style.color = 'var(--wi-fg)';
      // CodeMirror 内部元素颜色
      const styleId = 'wi_cm_theme_override';
      if (!__wiRootDoc.getElementById(styleId)) {
        const st = __wiRootDoc.createElement('style');
        st.id = styleId;
        st.textContent = `
          #wi_sc_code_wrap .CodeMirror { background: var(--wi-bg-2); color: var(--wi-fg); }
          #wi_sc_code_wrap .CodeMirror-gutters { background: var(--wi-bg-3); border-right: 1px solid var(--wi-border); }
          #wi_sc_code_wrap .CodeMirror-linenumber { color: var(--wi-fg-dim); }
          #wi_sc_code_wrap .CodeMirror-cursor { border-left: 1px solid var(--wi-fg); }
          #wi_sc_code_wrap .CodeMirror-selected { background: var(--wi-selected); }
          #wi_sc_code_wrap .CodeMirror-activeline-background { background: var(--wi-hover); }
          #wi_sc_code_wrap .cm-keyword { color: var(--wi-accent); font-weight: 600; }
          #wi_sc_code_wrap .cm-string { color: #6a9955; }
          #wi_sc_code_wrap .cm-comment { color: var(--wi-fg-dim); font-style: italic; }
          #wi_sc_code_wrap .cm-number { color: #b5cea8; }
          #wi_sc_code_wrap .cm-def { color: #569cd6; }
        `;
        __wiRootDoc.head.appendChild(st);
      }
      console.log('[WI编辑器] CodeMirror 编辑器已创建');
      return __wiScEditor;
    }

    function fillScriptForm(o) {
      $('#wi_sc_empty').hide();
      $('#wi_sc_editor').show();
      $('#wi_sc_name').val(o.name || '');
      $('#wi_sc_info').val(o.info || '');
      const code = o.content || '';
      $('#wi_sc_code_len').text(`(${code.length} 字节)`);
      $('#wi_sc_meta').text(`id: ${o.id || '(无)'}  ·  类型: ${o.type || 'script'}`);
      // 异步初始化 CodeMirror 并设置内容
      ensureScEditor().then(editor => {
        if (editor) {
          editor.setValue(code);
          // 让编辑器刷新布局（因为可能刚显示出来）
          setTimeout(() => editor.refresh(), 50);
        } else {
          // fallback 到 textarea
          $('#wi_sc_code').val(code);
        }
      });
    }

    // 从编辑器读内容
    function readScCode() {
      if (__wiScEditor) return __wiScEditor.getValue();
      return $('#wi_sc_code').val() || '';
    }

    function clearScriptForm() {
      $('#wi_sc_empty').show();
      $('#wi_sc_editor').hide();
    }

    // ★ 统一落盘入口：用官方 replaceScriptTrees（对当前角色卡）
    //   注意：replaceScriptTrees 只对"当前正在对话的角色卡"生效（type: 'character' 的语义）
    //   所以如果 scState.activeChar 不是当前卡，需要先切过去或提示用户
    // ★ 统一落盘入口（方案 C · 双路径）：
    //   - 当前对话的角色卡：用 replaceScriptTrees（官方 API，无需切卡）
    //   - 非当前卡：用 replaceCharacter(avatar, 完整卡)（落盘，但不会触发酒馆助手热重载）
    async function saveTavernHelperScripts(newTree) {
      const ctx = SillyTavern.getContext();
      const idx = Number(scState.activeChar);
      const c = ctx.characters[idx];
      if (!c) throw new Error('角色卡 index 无效: ' + scState.activeChar);

      const curIdx = Number(ctx.characterId);
      const curC = ctx.characters[curIdx];
      const isCurrent = curC && curC.avatar === c.avatar;

      if (isCurrent) {
        // 路径 A：当前卡 → 官方 API
        TavernHelper.replaceScriptTrees(newTree, { type: 'character' });
        // ★ 同步内存，否则 loadScriptList 从 c.data.extensions 读到旧数据
        if (!c.data) c.data = {};
        if (!c.data.extensions) c.data.extensions = {};
        if (!c.data.extensions.tavern_helper) c.data.extensions.tavern_helper = {};
        c.data.extensions.tavern_helper.scripts = newTree;
        scState._rawTree = newTree;
        console.log('[WI编辑器] 脚本树已落盘（replaceScriptTrees · 当前卡）');
      } else {
        // 路径 B：非当前卡 → 读完整卡、改 scripts、replaceCharacter 写回
        const fullChar = await TavernHelper.getCharacter(c.avatar);
        if (!fullChar.extensions) fullChar.extensions = {};
        if (!fullChar.extensions.tavern_helper) fullChar.extensions.tavern_helper = {};
        fullChar.extensions.tavern_helper.scripts = newTree;
        await TavernHelper.replaceCharacter(c.avatar, fullChar);
        // 同步内存
        if (!c.data) c.data = {};
        c.data.extensions = fullChar.extensions;
        scState._rawTree = newTree;
        console.log('[WI编辑器] 脚本树已落盘（replaceCharacter · 非当前卡）:', c.name || c.avatar);
      }
    }

    async function saveScriptTree(flatList) {
      if (!scState.activeChar) throw new Error('请先选择一个角色卡');
      const ctx = SillyTavern.getContext();
      const idx = Number(scState.activeChar);
      const c = ctx.characters[idx];
      if (!c) throw new Error('角色卡 index 无效: ' + scState.activeChar);

      // 拿到原始树（含 folder）
      const originalTree = scState._rawTree || [];
      const byId = {};
      flatList.forEach(s => { if (s.id) byId[s.id] = s; });

      // 用 flat 列表里的最新数据覆盖原始树里对应的节点
      function walk(nodes) {
        if (!Array.isArray(nodes)) return nodes;
        return nodes.map(node => {
          if (node.type === 'script' && byId[node.id]) {
            return { ...node, ...byId[node.id] };
          }
          if (node.type === 'folder' && Array.isArray(node.children)) {
            return { ...node, children: walk(node.children) };
          }
          return node;
        });
      }
      const newTree = walk(originalTree);

      // ★ 落盘（读完整角色卡 → replaceCharacter）
      await saveTavernHelperScripts(newTree);
    }

    async function newScript() {
      if (!scState.activeChar) throw new Error('请先选择一个角色卡');
      const ctx = SillyTavern.getContext();
      const idx = Number(scState.activeChar);
      const c = ctx.characters[idx];
      if (!c) throw new Error('角色卡 index 无效');
      const curLabel = c.name || c.avatar || idx;
      const name = prompt(`在「${curLabel}」下新建脚本，名称：`, '新脚本');
      if (name === null) return;

      const trees = scState._rawTree || [];

      const newScriptNode = {
        type: 'script',
        enabled: true,
        name: name || '新脚本',
        id: (crypto && typeof crypto.randomUUID === 'function') ? crypto.randomUUID() : 's_' + Date.now(),
        content: '// 在这里写脚本代码\n',
        info: '',
        button: { enabled: true, buttons: [] },
        data: {},
        export_with: { data: true, button: true },
      };

      trees.push(newScriptNode);
      scState._rawTree = trees;

      // ★ 落盘
      await saveTavernHelperScripts(trees);
      console.log('[WI编辑器] 已新建脚本:', name);

      await loadScriptList();
      if (window.toastr) {
        window.toastr.info('已新建。如需酒馆助手面板同步，请点「🔄 重载脚本」');
      }

      const newIdx = scState.list.findIndex(s => s.id === newScriptNode.id);
      if (newIdx >= 0) {
        scState.selectedIdx = newIdx;
        fillScriptForm(scState.list[newIdx]);
        renderScriptList();
      }
    }

    async function deleteScript() {
      if (!scState.activeChar) throw new Error('请先选择一个角色卡');
      if (scState.selectedIdx < 0) return;
      const o = scState.list[scState.selectedIdx];
      if (!confirm(`确定删除脚本「${o.name || '无名称'}」？`)) return;

      const ctx = SillyTavern.getContext();
      const idx = Number(scState.activeChar);
      const c = ctx.characters[idx];
      if (!c) throw new Error('角色卡 index 无效');
      const trees = scState._rawTree || [];

      function walk(nodes) {
        if (!Array.isArray(nodes)) return nodes;
        return nodes
          .filter(node => !(node.type === 'script' && node.id === o.id))
          .map(node => {
            if (node.type === 'folder' && Array.isArray(node.children)) {
              return { ...node, children: walk(node.children) };
            }
            return node;
          });
      }

      const newTrees = walk(trees);
      scState._rawTree = newTrees;

      // ★ 落盘
      await saveTavernHelperScripts(newTrees);
      console.log('[WI编辑器] 已删除脚本:', o.name);

      scState.selectedIdx = -1;
      await loadScriptList();
      clearScriptForm();
      if (window.toastr) {
        window.toastr.info('已删除。建议 F5 刷新页面，清理脚本残留的界面状态');
      } else {
        alert('已删除。建议刷新页面（F5）清理残留。');
      }
    }

    $('#wi_sc_char_select').on('change', async function () {
      scState.activeChar = $(this).val();
      scState.selectedIdx = -1;
      clearScriptForm();
      await loadScriptList();
    });

    // ★ 一键跳到当前对话的角色卡
    $('#wi_sc_current').on('click', async () => {
      const ctx = SillyTavern.getContext();
      const curIdx = Number(ctx.characterId);
      if (!(curIdx >= 0) || !ctx.characters[curIdx]) {
        if (window.toastr) window.toastr.warning('当前没有打开的角色卡');
        return;
      }
      // 确保下拉框里有这个 index（角色卡列表可能变过）
      const $sel = $('#wi_sc_char_select');
      if (!$sel.find(`option[value="${curIdx}"]`).length) {
        await loadCharSelect();
      }
      $sel.val(String(curIdx));
      scState.activeChar = String(curIdx);
      scState.selectedIdx = -1;
      clearScriptForm();
      await loadScriptList();
      if (window.toastr) {
        window.toastr.success('已跳到：' + (ctx.characters[curIdx].name || ctx.characters[curIdx].avatar));
      }
    });

    $('#wi_sc_search').on('input', function () {
      scState.filter = $(this).val() || '';
      applyScriptFilter();
    });

    $('#wi_sc_refresh').on('click', loadScriptList);
    $('#wi_sc_new').on('click', newScript);
    $('#wi_sc_del').on('click', deleteScript);

    // ============ 多选操作 ============
    function updateScMultiCount() {
      const n = scState.selectedIds.size;
      const $c = $('#wi_sc_sel_count');
      if ($c.length) $c.text(n);
    }

    $('#wi_sc_sel_all').on('click', () => {
      scState.selectedIds.clear();
      scState.list.forEach(o => { if (o.id) scState.selectedIds.add(o.id); });
      renderScriptList();
      updateScMultiCount();
    });

    $('#wi_sc_sel_none').on('click', () => {
      scState.selectedIds.clear();
      renderScriptList();
      updateScMultiCount();
    });

    $('#wi_sc_sel_invert').on('click', () => {
      const newSet = new Set();
      scState.list.forEach(o => {
        if (o.id && !scState.selectedIds.has(o.id)) newSet.add(o.id);
      });
      scState.selectedIds = newSet;
      renderScriptList();
      updateScMultiCount();
    });

    // 复制 / 移动 的公共弹窗
    function openTransferDialog(mode) {  // 'copy' | 'move'
      if (scState.selectedIds.size === 0) {
        alert('请先勾选要操作的脚本');
        return;
      }

      const ctx = SillyTavern.getContext();
      const srcIdx = Number(scState.activeChar);
      const srcChar = ctx.characters[srcIdx];
      if (!srcChar) { alert('源角色卡无效'); return; }
      const srcAvatar = srcChar.avatar;

      // 收集其他角色卡
      const others = ctx.characters
        .map((c, i) => ({ c, i }))
        .filter(({ c, i }) => c && c.avatar && c.avatar !== srcAvatar);

      if (others.length === 0) {
        alert('没有其他角色卡可作为目标');
        return;
      }

      const actionLabel = mode === 'copy' ? '复制' : '移动';
      const optionsHtml = others.map(({ c, i }) =>
        `<option value="${i}">${escapeHtml(c.name || '(无名)')} (${escapeHtml(c.avatar)})</option>`
      ).join('');

      showModal(`
        <div style="font-size:13px;font-weight:700;color:var(--wi-fg);margin-bottom:6px">📦 ${actionLabel}脚本</div>
        <div style="font-size:11px;color:var(--wi-fg-dim);margin-bottom:8px;line-height:1.6">
          源角色卡：<b>${escapeHtml(srcChar.name || srcAvatar)}</b><br>
          将 <b>${scState.selectedIds.size}</b> 个脚本${actionLabel}到：
        </div>
        <select id="wi_sc_transfer_target" style="${INPUT_CSS}">${optionsHtml}</select>
        <div style="font-size:11px;color:var(--wi-fg-dim);margin-top:8px;line-height:1.6">
          · 脚本 ID 会重新生成，避免冲突<br>
          · 目标卡已有同名脚本时，会自动加后缀 <code>(2)</code> <code>(3)</code>
        </div>
        <div id="wi_sc_transfer_status" style="font-size:11px;color:var(--wi-fg-dim);margin-top:8px"></div>
        <div style="margin-top:12px;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">
          <button id="wi_sc_transfer_ok" style="${BTN_PRIMARY_CSS}">✅ 确认${actionLabel}</button>
          <button data-wi-close style="${BTN_CSS}">取消</button>
        </div>
      `, ($m) => {
        $m.find('#wi_sc_transfer_ok').on('click', async () => {
          const targetIdx = Number($m.find('#wi_sc_transfer_target').val());
          const targetChar = ctx.characters[targetIdx];
          if (!targetChar) {
            $m.find('#wi_sc_transfer_status').text('❌ 目标角色卡无效').css('color', '#e07070');
            return;
          }
          $m.find('#wi_sc_transfer_ok').prop('disabled', true).text('处理中…');
          try {
            await doTransferScripts(mode, targetChar, srcChar);
            $m.closest('#wi_modal_mask').remove();
          } catch (e) {
            console.error('[WI编辑器] transfer 失败:', e);
            $m.find('#wi_sc_transfer_status').text('❌ ' + e.message).css('color', '#e07070');
            $m.find('#wi_sc_transfer_ok').prop('disabled', false).text('✅ 确认');
          }
        });
      });
    }

    async function doTransferScripts(mode, targetChar, srcChar) {
      const selectedIds = new Set(scState.selectedIds);
      if (selectedIds.size === 0) return;

      // 1. 从源卡读完整树
      const srcFull = await TavernHelper.getCharacter(srcChar.avatar);
      const srcTrees = srcFull?.extensions?.tavern_helper?.scripts || [];

      // 2. 找出选中的顶层 script（忽略 folder）
      const picked = srcTrees.filter(n => n.type === 'script' && n.id && selectedIds.has(n.id));
      if (picked.length === 0) {
        alert('没有匹配的脚本可操作');
        return;
      }

      // 3. 读目标卡完整树
      const tgtFull = await TavernHelper.getCharacter(targetChar.avatar);
      if (!tgtFull.extensions) tgtFull.extensions = {};
      if (!tgtFull.extensions.tavern_helper) tgtFull.extensions.tavern_helper = {};
      const tgtTrees = Array.isArray(tgtFull.extensions.tavern_helper.scripts)
        ? tgtFull.extensions.tavern_helper.scripts.slice()
        : [];

      // 4. 复制选中的脚本 + 重新生成 ID + 处理同名
      const genId = () => (crypto && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);

      const existingNames = new Set(tgtTrees.filter(n => n.type === 'script').map(n => n.name));
      const uniqueName = (base) => {
        if (!existingNames.has(base)) { existingNames.add(base); return base; }
        let i = 2;
        while (existingNames.has(`${base} (${i})`)) i++;
        const n = `${base} (${i})`;
        existingNames.add(n);
        return n;
      };

      const toAdd = picked.map(p => {
        const copy = JSON.parse(JSON.stringify(p));
        copy.id = genId();
        copy.name = uniqueName(copy.name || '未命名');
        return copy;
      });

      // 5. 写目标卡
      tgtFull.extensions.tavern_helper.scripts = tgtTrees.concat(toAdd);
      await TavernHelper.replaceCharacter(targetChar.avatar, tgtFull);
      // 同步目标卡内存（如果存在）
      if (!targetChar.data) targetChar.data = {};
      targetChar.data.extensions = tgtFull.extensions;

      // 6. 如果是"移动"，从源卡删除
      if (mode === 'move') {
        const newSrcTrees = srcTrees.filter(n => !(n.type === 'script' && n.id && selectedIds.has(n.id)));
        await saveTavernHelperScripts(newSrcTrees);
        scState.selectedIds.clear();
        await loadScriptList();
      } else {
        // 复制：源卡不动，但清空多选（避免重复操作）
        scState.selectedIds.clear();
        renderScriptList();
        updateScMultiCount();
      }

      if (window.toastr) {
        window.toastr.success(
          `已${mode === 'copy' ? '复制' : '移动'} ${toAdd.length} 个脚本到「${targetChar.name || targetChar.avatar}」` +
          (targetChar.avatar !== SillyTavern.getContext().characters[Number(SillyTavern.getContext().characterId)]?.avatar
            ? '（切到该卡可见）' : '')
        );
      } else {
        alert(`已${mode === 'copy' ? '复制' : '移动'} ${toAdd.length} 个脚本`);
      }
    }

    $('#wi_sc_copy_to').on('click', () => openTransferDialog('copy'));
    $('#wi_sc_move_to').on('click', () => openTransferDialog('move'));

    // ============ 脚本导出 ============
    async function exportScriptTree() {
      if (!scState.activeChar) {
        alert('请先选择一个角色卡');
        return;
      }
      const ctx = SillyTavern.getContext();
      const idx = Number(scState.activeChar);
      const c = ctx.characters[idx];
      if (!c) { alert('角色卡 index 无效'); return; }
      const trees = scState._rawTree || c.data?.extensions?.tavern_helper?.scripts || [];
      if (!Array.isArray(trees) || trees.length === 0) {
        if (!confirm('当前角色卡没有脚本，仍要导出空 JSON？')) return;
      }

      const data = {
        version: 1,
        type: 'wi_script_export',
        exportTime: new Date().toISOString(),
        sourceChar: c.name || c.avatar || String(idx),
        tree: trees || [],
      };
      const json = JSON.stringify(data, null, 2);

      showModal(`
        <div style="font-size:13px;font-weight:700;color:var(--wi-fg);margin-bottom:6px">📤 导出脚本</div>
        <div style="font-size:11px;color:var(--wi-fg-dim);margin-bottom:8px;line-height:1.6">
          来源角色卡：<b>${escapeHtml(c.name || c.avatar || String(idx))}</b><br>
          包含 <b>${(trees || []).length}</b> 个顶层节点（脚本 + 文件夹）<br>
          保存它以后可以导入到其他角色卡，或用于备份。
        </div>
        <textarea id="wi_sc_exp_area" readonly style="width:100%;height:320px;background:var(--wi-bg-2);color:var(--wi-fg-2);border:1px solid var(--wi-border);border-radius:6px;padding:8px;box-sizing:border-box;font-family:monospace;font-size:11px;resize:vertical">${escapeHtml(json, 999999)}</textarea>
        <div style="margin-top:8px;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">
          <button id="wi_sc_exp_download" style="${BTN_PRIMARY_CSS}">💾 下载为 .json 文件</button>
          <button id="wi_sc_exp_copy" style="${BTN_CSS}">📋 复制到剪贴板</button>
          <button data-wi-close style="${BTN_CSS}">关闭</button>
        </div>
      `, ($m) => {
        $m.find('#wi_sc_exp_download').on('click', () => {
          const ts = new Date().toISOString().slice(0, 10);
          const fname = `wi_scripts_${safeFilename(c.name || c.avatar || String(idx))}_${ts}.json`;
          if (downloadJson(fname, data)) {
            alert(`已下载：${fname}`);
          } else {
            alert('下载失败，请用"复制到剪贴板"');
          }
        });
        $m.find('#wi_sc_exp_copy').on('click', async () => {
          const ta = $m.find('#wi_sc_exp_area')[0];
          try {
            await navigator.clipboard.writeText(ta.value);
            alert('已复制到剪贴板');
          } catch (e) {
            ta.select();
            document.execCommand('copy');
            alert('已复制到剪贴板');
          }
        });
      });
    }

    $('#wi_sc_export').on('click', exportScriptTree);

    // ============ 脚本导入 ============
    function openScriptImportDialog() {
      if (!scState.activeChar) {
        alert('请先选择一个角色卡');
        return;
      }
      const _ctx0 = SillyTavern.getContext();
      const _idx0 = Number(scState.activeChar);
      const _c0 = _ctx0.characters[_idx0];
      const _label0 = _c0 ? (_c0.name || _c0.avatar || String(_idx0)) : String(_idx0);
      showModal(`
        <div style="font-size:13px;font-weight:700;color:var(--wi-fg);margin-bottom:6px">📥 导入脚本</div>
        <div style="font-size:11px;color:var(--wi-fg-dim);margin-bottom:8px;line-height:1.6">
          目标角色卡：<b>${escapeHtml(_label0)}</b><br>
          粘贴之前导出的 JSON，或选择一个 .json 文件。<br>
          <span style="color:var(--wi-accent)">导入采用「追加」模式，不会覆盖现有脚本。</span>
        </div>
        <div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">
          <button id="wi_sc_imp_file" style="${BTN_PRIMARY_CSS}">📁 选择 JSON 文件</button>
        </div>
        <div id="wi_sc_imp_filename" style="font-size:11px;color:var(--wi-fg-dim);margin-bottom:6px">未选择文件</div>
        <textarea id="wi_sc_imp_area" style="display:none"></textarea>
        <div id="wi_sc_imp_status" style="font-size:11px;color:var(--wi-fg-dim);margin-top:6px"></div>
        <div style="margin-top:8px;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">
          <button id="wi_sc_imp_save" style="${BTN_PRIMARY_CSS}">📥 追加导入</button>
          <button data-wi-close style="${BTN_CSS}">取消</button>
        </div>
      `, ($m) => {
        $m.find('#wi_sc_imp_file').on('click', async () => {
          const picked = await pickJsonFile();
          if (!picked) return;
          $m.find('#wi_sc_imp_area').val(picked.text);
          $m.find('#wi_sc_imp_filename').text(`已选择：${picked.name}（${picked.text.length} 字符）`).css('color', 'var(--wi-accent)');
        });

        $m.find('#wi_sc_imp_save').on('click', async () => {
          const raw = $m.find('#wi_sc_imp_area').val() || '';
          if (!raw.trim()) {
            $m.find('#wi_sc_imp_status').text('❌ 请先选择 JSON 文件').css('color', '#e07070');
            return;
          }
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (e) {
            $m.find('#wi_sc_imp_status').text('❌ JSON 解析失败：' + e.message).css('color', '#e07070');
            return;
          }
          // 兼容两种格式：
          // 1. { version, type: 'wi_script_export', tree: [...] }  —— 本脚本导出格式
          // 2. [...]                                                 —— 直接的数组
          let importTree;
          if (Array.isArray(parsed)) {
            importTree = parsed;
          } else if (parsed && Array.isArray(parsed.tree)) {
            importTree = parsed.tree;
          } else {
            $m.find('#wi_sc_imp_status').text('❌ 格式不对：期望数组，或含 tree 字段的对象').css('color', '#e07070');
            return;
          }

          if (importTree.length === 0) {
            $m.find('#wi_sc_imp_status').text('❌ 空的脚本树').css('color', '#e07070');
            return;
          }

          $m.find('#wi_sc_imp_save').prop('disabled', true).text('导入中…');

          try {
            // 1. 读现有的树
            const _ctx = SillyTavern.getContext();
            const _idx = Number(scState.activeChar);
            const _c = _ctx.characters[_idx];
            if (!_c) throw new Error('角色卡 index 无效');
            const existingTrees = scState._rawTree || _c.data?.extensions?.tavern_helper?.scripts || [];

            // 2. 收集现有所有 ID（递归）
            const existingIds = new Set();
            const collectIds = (nodes) => {
              if (!Array.isArray(nodes)) return;
              nodes.forEach(n => {
                if (n && n.id) existingIds.add(n.id);
                if (n && n.type === 'folder' && Array.isArray(n.children)) {
                  collectIds(n.children);
                }
              });
            };
            collectIds(existingTrees);

            // 3. 深拷贝导入的树，同时处理 ID 冲突
            let regeneratedCount = 0;
            const genId = () => {
              if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
              return 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
            };
            const processNode = (node) => {
              if (!node || typeof node !== 'object') return null;
              const copy = JSON.parse(JSON.stringify(node));
              // ★ 补全 Script 必需字段（缺 export_with 等会导致写入后不生效）
              if (copy.type === 'script') {
                if (!copy.button || typeof copy.button !== 'object') {
                  copy.button = { enabled: false, buttons: [] };
                } else if (!Array.isArray(copy.button.buttons)) {
                  copy.button.buttons = [];
                }
                if (!copy.data || typeof copy.data !== 'object') copy.data = {};
                if (!copy.info) copy.info = '';
                if (!copy.export_with || typeof copy.export_with !== 'object') {
                  copy.export_with = { data: true, button: true };
                } else {
                  if (typeof copy.export_with.data !== 'boolean') copy.export_with.data = true;
                  if (typeof copy.export_with.button !== 'boolean') copy.export_with.button = true;
                }
                if (typeof copy.enabled !== 'boolean') copy.enabled = true;
                if (typeof copy.content !== 'string') copy.content = '';
                if (typeof copy.name !== 'string') copy.name = '未命名脚本';
              } else if (copy.type === 'folder') {
                if (typeof copy.enabled !== 'boolean') copy.enabled = true;
                if (typeof copy.name !== 'string') copy.name = '未命名文件夹';
                if (typeof copy.icon !== 'string') copy.icon = '';
                if (typeof copy.color !== 'string') copy.color = '';
              }
              // ID 冲突处理
              if (copy.id && existingIds.has(copy.id)) {
                copy.id = genId();
                existingIds.add(copy.id);
                regeneratedCount++;
              } else if (copy.id) {
                existingIds.add(copy.id);
              } else if (copy.type === 'script' || copy.type === 'folder') {
                copy.id = genId();
                existingIds.add(copy.id);
              }
              // 递归处理 children
              if (copy.type === 'folder' && Array.isArray(copy.children)) {
                copy.children = copy.children.map(processNode).filter(Boolean);
              }
              return copy;
            };
            const processedTree = importTree.map(processNode).filter(Boolean);
            console.log('[WI编辑器·导入] processedTree 长度 =', processedTree.length);
            console.log('[WI编辑器·导入] processedTree 名字 =', processedTree.map(n => n.name));
            console.log('[WI编辑器·导入] existingTrees 长度 =', existingTrees.length);
            console.log('[WI编辑器·导入] existingTrees 名字 =', existingTrees.map(n => n.name));

            // 4. 追加到现有的树
            const newTrees = existingTrees.concat(processedTree);
            console.log('[WI编辑器·导入] newTrees 长度 =', newTrees.length);
            console.log('[WI编辑器·导入] newTrees 名字 =', newTrees.map(n => n.name));

            // 5. 落盘（用统一入口，支持当前卡/非当前卡）
            scState._rawTree = newTrees;
            await saveTavernHelperScripts(newTrees);

            // 6. 统计
            let scriptCount = 0;
            let folderCount = 0;
            const countNodes = (nodes) => {
              if (!Array.isArray(nodes)) return;
              nodes.forEach(n => {
                if (n.type === 'script') scriptCount++;
                else if (n.type === 'folder') {
                  folderCount++;
                  countNodes(n.children);
                }
              });
            };
            countNodes(processedTree);

            // 7. 刷新列表
            await loadScriptList();

            // 8. 如果是当前卡，让酒馆助手重载脚本运行时（复用「重载」逻辑）
            const curIdxNow = Number(_ctx.characterId);
            const curCNow = _ctx.characters[curIdxNow];
            if (curCNow && _c.avatar === curCNow.avatar) {
              try {
                TavernHelper.replaceScriptTrees(scState._rawTree || [], { type: 'character' });
              } catch (e) {
                console.warn('[WI编辑器] 导入后重载脚本失败:', e);
              }
            }

            $m.find('#wi_sc_imp_status').text(
              `✅ 导入完成：新增 ${scriptCount} 个脚本、${folderCount} 个文件夹${regeneratedCount > 0 ? `，${regeneratedCount} 个 ID 冲突已自动重新生成` : ''}。`
            ).css('color', '#6ac06a');

            setTimeout(() => { $m.closest('#wi_modal_mask').remove(); }, 1500);
          } catch (e) {
            console.error('[WI编辑器] 导入脚本失败:', e);
            $m.find('#wi_sc_imp_status').text('❌ 导入失败：' + e.message).css('color', '#e07070');
            $m.find('#wi_sc_imp_save').prop('disabled', false).text('📥 追加导入');
          }
        });
      });
    }

    $('#wi_sc_import').on('click', openScriptImportDialog);

    $('#wi_sc_format').on('click', async () => {
      const code = readScCode();
      if (!code.trim()) {
        if (window.toastr) window.toastr.info('代码为空');
        return;
      }
      // 等 js-beautify 就绪
      if (window.__wiBeautifyReady) {
        try { await window.__wiBeautifyReady; } catch (e) {}
      }
      const w = (window.top && window.top !== window) ? window.top : window;
      if (typeof w.js_beautify !== 'function') {
        alert('格式化工具未就绪，请重载脚本或刷新页面');
        return;
      }
      let formatted;
      try {
        formatted = w.js_beautify(code, {
          indent_size: 2,
          indent_char: ' ',
          preserve_newlines: true,
          max_preserve_newlines: 2,
          end_with_newline: true,
          brace_style: 'collapse,preserve-inline',
          space_in_empty_paren: false,
          keep_array_indentation: false,
        });
      } catch (e) {
        console.error('[WI编辑器] 格式化失败:', e);
        alert('格式化失败：' + e.message);
        return;
      }
      // 写回编辑器
      if (__wiScEditor) {
        __wiScEditor.setValue(formatted);
        setTimeout(() => __wiScEditor.refresh(), 30);
      } else {
        $('#wi_sc_code').val(formatted);
      }
      const n = formatted.length;
      $('#wi_sc_code_len').text(`(${n} 字节)`);
      if (window.toastr) window.toastr.success('已格式化');
    });

    $('#wi_sc_save_code').on('click', async () => {
      if (scState.selectedIdx < 0) {
        alert('请先选择一个脚本');
        return;
      }
      const o = scState.list[scState.selectedIdx];
      if (!o) return;

      const newCode = readScCode();
      const newName = $('#wi_sc_name').val();
      const newInfo = $('#wi_sc_info').val();

      const changed = o.content !== newCode || o.name !== newName || o.info !== newInfo;
      if (!changed) {
        if (window.toastr) window.toastr.info('内容没有变化');
        return;
      }

      o.content = newCode;
      o.name = newName;
      o.info = newInfo;

      try {
        await saveScriptTree(scState.list);
        renderScriptList();
        $('#wi_sc_code_len').text(`(${newCode.length} 字节)`);
        if (window.toastr) window.toastr.success('已保存');
      } catch (e) {
        console.error('[WI编辑器] 保存脚本失败:', e);
        alert('保存失败：' + e.message);
      }
    });


    $('#wi_sc_open_tavern').on('click', () => {
      // 尝试找到酒馆的扩展菜单按钮
      const root = __wiRootDoc;
      const candidates = [
        '#extensionsMenuButton',
        '#extensions_menu_button',
        '#extensions-menu-button',
        '.extensionsMenuButton',
        '#extensions_button',
      ];
      let btn = null;
      for (const sel of candidates) {
        const el = root.querySelector(sel);
        if (el) { btn = el; break; }
      }
      // 兜底：按 title 找
      if (!btn) {
        const all = root.querySelectorAll('button, a, div[role="button"]');
        for (const el of all) {
          const t = (el.title || el.getAttribute('aria-label') || '').toLowerCase();
          if (t.includes('扩展') || t.includes('extension') || t.includes('magic wand')) {
            btn = el;
            break;
          }
        }
      }
      if (btn) {
        btn.click();
        if (window.toastr) {
          window.toastr.info('已在扩展菜单里，请手动点「酒馆助手」');
        }
      } else {
        alert('请手动点击酒馆顶部的扩展图标（🧩 或魔法棒），找到「JS-Slash-Runner」');
      }
    });

    let _scTimer = null;
    function scheduleScSave() {
      if (_scTimer) clearTimeout(_scTimer);
      _scTimer = setTimeout(async () => {
        _scTimer = null;
        if (scState.selectedIdx < 0) return;
        const o = scState.list[scState.selectedIdx];
        if (!o) return;
        const newName = $('#wi_sc_name').val();
        const newInfo = $('#wi_sc_info').val();
        if (o.name === newName && o.info === newInfo) return;
        o.name = newName;
        o.info = newInfo;
        try {
          await saveScriptTree(scState.list);
          renderScriptList();
        } catch (e) {
          alert('保存失败：' + e.message);
        }
      }, 600);
    }

    $('#wi_sc_name, #wi_sc_info')
      .on('input', scheduleScSave)
      .on('blur', () => { if (_scTimer) { clearTimeout(_scTimer); _scTimer = null; scheduleScSave(); } });

    $('.wi-tab[data-tab="script"]').on('click', async () => {
      // ★ 每次切到脚本 Tab，都同步到当前正在对话的角色卡
      const ctx = SillyTavern.getContext();
      const curIdx = Number(ctx.characterId);
      if (curIdx >= 0 && ctx.characters[curIdx]) {
        const curVal = String(curIdx);
        if (scState.activeChar !== curVal) {
          const $sel = $('#wi_sc_char_select');
          if (!$sel.find(`option[value="${curVal}"]`).length) {
            await loadCharSelect();
          }
          $sel.val(curVal);
          scState.activeChar = curVal;
          scState.selectedIdx = -1;
          clearScriptForm();
        }
      }
      await loadScriptList();
    });

    (async () => {
      await loadCharSelect();
      await loadScriptList();
    })();

    // ============ CSS 编辑器 ============
    // 拿当前生效的 #custom-style 元素（它在主文档里）
    function getMainCustomStyleEl() {
      return __wiRootDoc.querySelector('#custom-style');
    }

    // 拿当前 #themes 选中的主题名
    function getCurrentThemeName() {
      const sel = __wiRootDoc.querySelector('#themes');
      return sel ? sel.value : '';
    }

    // 进入 CSS 编辑模式
    async function enterThemeEditMode(name) {
      // 1. 先应用这个主题
      applyThemeByName(name);
      // 2. 等酒馆应用完
      await new Promise(r => setTimeout(r, 400));

      // 3. 读当前 CSS
      const styleEl = getMainCustomStyleEl();
      if (!styleEl) {
        alert('找不到 #custom-style 元素，无法编辑');
        return;
      }
      const css = styleEl.textContent || '';

      // 4. 记录状态
      thEdit.active = true;
      thEdit.themeName = name;
      thEdit.originalCss = css;
      thEdit.currentCss = css;

      // 5. 显示面板
      $('#wi_th_edit_name').text(name);
      $('#wi_th_edit_status').text(`${css.length} 字符`);
      $('#wi_th_edit_css').val(css);
      $('#wi_th_editor_panel').css('display', 'flex');

      // 6. 让 textarea 立刻聚焦
      setTimeout(() => $('#wi_th_edit_css').focus(), 50);
    }

    // 退出 CSS 编辑模式
    function exitThemeEditMode(restoreOriginal) {
      if (!thEdit.active) return;
      const styleEl = getMainCustomStyleEl();
      if (styleEl && restoreOriginal) {
        styleEl.textContent = thEdit.originalCss;
      }
      thEdit.active = false;
      thEdit.themeName = '';
      thEdit.originalCss = '';
      thEdit.currentCss = '';
      $('#wi_th_editor_panel').css('display', 'none');
      // 清空 textarea（下次进来会重新填）
      $('#wi_th_edit_css').val('');
    }

    // 实时把 textarea 内容写到 #custom-style
    function applyEditCssLive() {
      if (!thEdit.active) return;
      const styleEl = getMainCustomStyleEl();
      if (!styleEl) return;
      const css = $('#wi_th_edit_css').val() || '';
      thEdit.currentCss = css;
      styleEl.textContent = css;
      $('#wi_th_edit_status').text(`${css.length} 字符`);
    }

    // textarea 改动 → 实时生效
    $('#wi_th_edit_css').on('input', () => {
      applyEditCssLive();
    });

    // 撤销改动：恢复原始 CSS
    $('#wi_th_edit_revert').on('click', () => {
      if (!thEdit.active) return;
      if (!confirm('确定撤销本次所有改动，恢复到进入编辑时的状态？')) return;
      $('#wi_th_edit_css').val(thEdit.originalCss);
      thEdit.currentCss = thEdit.originalCss;
      applyEditCssLive();
    });

    // 放弃：恢复原始 CSS + 退出
    $('#wi_th_edit_discard').on('click', () => {
      if (!thEdit.active) return;
      if (!confirm('确定放弃所有改动？\n\n这会把 CSS 恢复到进入编辑时的状态。')) return;
      exitThemeEditMode(true);
    });

    // 保存逻辑
    async function saveEditTheme(newName) {
      if (!thEdit.active) return false;

      const ctx = SillyTavern.getContext();
      const headers = ctx.getRequestHeaders ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' };
      const ps = ctx.powerUserSettings;

      // 构造主题对象：当前 power_user 字段 + 新的 CSS + 主题名
      const themeObj = {
        name: newName || thEdit.themeName,
        main_text_color: ps.main_text_color,
        italics_text_color: ps.italics_text_color,
        underline_text_color: ps.underline_text_color,
        quote_text_color: ps.quote_text_color,
        blur_tint_color: ps.blur_tint_color,
        chat_tint_color: ps.chat_tint_color,
        user_mes_blur_tint_color: ps.user_mes_blur_tint_color,
        bot_mes_blur_tint_color: ps.bot_mes_blur_tint_color,
        shadow_color: ps.shadow_color,
        shadow_width: ps.shadow_width,
        border_color: ps.border_color,
        blur_strength: ps.blur_strength,
        font_scale: ps.font_scale,
        fast_ui_mode: ps.fast_ui_mode,
        waifuMode: ps.waifuMode,
        avatar_style: ps.avatar_style,
        chat_display: ps.chat_display,
        toastr_position: ps.toastr_position,
        noShadows: ps.noShadows,
        chat_width: ps.chat_width,
        timer_enabled: ps.timer_enabled,
        timestamps_enabled: ps.timestamps_enabled,
        timestamp_model_icon: ps.timestamp_model_icon,
        mesIDDisplay_enabled: ps.mesIDDisplay_enabled,
        hideChatAvatars_enabled: ps.hideChatAvatars_enabled,
        message_token_count_enabled: ps.message_token_count_enabled,
        expand_message_actions: ps.expand_message_actions,
        enableZenSliders: ps.enableZenSliders,
        enableLabMode: ps.enableLabMode,
        hotswap_enabled: ps.hotswap_enabled,
        custom_css: thEdit.currentCss,
      };

      try {
        const r = await fetch('/api/themes/save', {
          method: 'POST',
          headers,
          body: JSON.stringify(themeObj),
        });
        if (!r.ok) {
          alert(`❌ 保存失败：HTTP ${r.status}`);
          return false;
        }
        return true;
      } catch (e) {
        err('保存主题失败', e);
        alert('❌ 保存失败：' + e.message);
        return false;
      }
    }

    // 覆盖保存
    $('#wi_th_edit_save').on('click', async () => {
      if (!thEdit.active) return;
      const ok = await saveEditTheme(null);
      if (!ok) return;
      exitThemeEditMode(false);

      const name = thEdit.themeName || getCurrentThemeName();
      // 保存后需要刷新页面，酒馆才会重新读主题数据
      const reload = confirm(
        `✅ 已保存到主题「${name}」。\n\n` +
        `酒馆需要刷新页面才能让新数据完全生效。\n\n` +
        `现在刷新？`
      );
      if (reload) location.reload();
    });

    // 另存为
    $('#wi_th_edit_saveas').on('click', async () => {
      if (!thEdit.active) return;
      const newName = prompt('新主题名称：', thEdit.themeName + ' 副本');
      if (!newName || !newName.trim()) return;
      const trimmed = newName.trim();
      if (trimmed === thEdit.themeName) {
        alert('新名称不能和原名相同，请用"覆盖保存"。');
        return;
      }
      const ok = await saveEditTheme(trimmed);
      if (!ok) return;
      // 加 option 到 #themes
      addThemeOption(trimmed);
      exitThemeEditMode(false);

      const reload = confirm(
        `✅ 已另存为「${trimmed}」。\n\n` +
        `酒馆需要刷新页面才能让新主题完全生效。\n\n` +
        `现在刷新？`
      );
      if (reload) location.reload();
    });

    // ============ 导出分组配置 ============
    $('#wi_th_export_groups').on('click', () => {
      const data = {
        version: 1,
        exportTime: new Date().toISOString(),
        groups: thState.groups,
        groupOrder: thState.groupOrder,
        collapsed: thState.collapsed,
      };
      const json = JSON.stringify(data, null, 2);

      showModal(`
        <div style="font-size:13px;font-weight:700;color:#eee;margin-bottom:6px">📤 导出分组配置</div>
        <div style="font-size:11px;color:#888;margin-bottom:8px;line-height:1.6">
          下面的 JSON 包含你的所有分组、每个分组里的主题名、折叠状态。<br>
          保存它以后就能在新浏览器/新设备上恢复同样的分组。
        </div>
        <textarea id="wi_th_exp_groups_area" readonly style="width:100%;height:280px;background:#161618;color:#bbb;border:1px solid #444;border-radius:4px;padding:8px;box-sizing:border-box;font-family:monospace;font-size:11px;resize:vertical">${json.replace(/</g, '&lt;')}</textarea>
        <div style="margin-top:8px;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">
          <button id="wi_th_exp_groups_download" style="${BTN_PRIMARY_CSS}">💾 下载为 .json 文件</button>
          <button id="wi_th_exp_groups_copy" style="${BTN_CSS}">📋 复制到剪贴板</button>
          <button data-wi-close style="${BTN_CSS}">关闭</button>
        </div>
      `, ($m) => {
        $m.find('#wi_th_exp_groups_download').on('click', () => {
          const ts = new Date().toISOString().slice(0, 10);
          const fname = `wi_theme_groups_${ts}.json`;
          if (downloadJson(fname, data)) {
            alert(`已下载：${fname}`);
          } else {
            alert('下载失败，请用"复制到剪贴板"');
          }
        });

        $m.find('#wi_th_exp_groups_copy').on('click', async () => {
          const ta = $m.find('#wi_th_exp_groups_area')[0];
          try {
            await navigator.clipboard.writeText(ta.value);
            alert('已复制到剪贴板');
          } catch (e) {
            ta.select();
            document.execCommand('copy');
            alert('已复制到剪贴板');
          }
        });
      });
    });

    // ============ 导入分组配置 ============
    $('#wi_th_import_groups').on('click', () => {
      showModal(`
        <div style="font-size:13px;font-weight:700;color:#eee;margin-bottom:6px">📥 导入分组配置</div>
        <div style="font-size:11px;color:#888;margin-bottom:8px;line-height:1.6">
          粘贴之前导出的 JSON，或选择一个 .json 文件。
        </div>
        <div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">
          <button id="wi_th_imp_groups_file" style="${BTN_CSS}">📁 选择 JSON 文件</button>
        </div>
        <textarea id="wi_th_imp_groups_area" placeholder='{ "version": 1, "groups": {...}, "groupOrder": [...] }' style="width:100%;height:220px;background:#161618;color:#bbb;border:1px solid #444;border-radius:4px;padding:8px;box-sizing:border-box;font-family:monospace;font-size:11px;resize:vertical"></textarea>
        <div id="wi_th_imp_groups_status" style="font-size:11px;color:#888;margin-top:6px"></div>
        <div style="margin-top:8px;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">
          <button id="wi_th_imp_groups_merge" style="${BTN_PRIMARY_CSS}">🔗 合并到现有分组</button>
          <button id="wi_th_imp_groups_replace" style="${BTN_DANGER_CSS}">♻️ 替换全部分组</button>
          <button data-wi-close style="${BTN_CSS}">取消</button>
        </div>
      `, ($m) => {
        $m.find('#wi_th_imp_groups_file').on('click', async () => {
          const picked = await pickJsonFile();
          if (!picked) return;
          $m.find('#wi_th_imp_groups_area').val(picked.text);
          $m.find('#wi_th_imp_groups_status').text(`📄 已读取：${picked.name}（${picked.text.length} 字符）`).css('color', '#8cf');
        });

        const parseImported = () => {
          const raw = $m.find('#wi_th_imp_groups_area').val() || '';
          if (!raw.trim()) {
            $m.find('#wi_th_imp_groups_status').text('❌ 请粘贴或选择 JSON').css('color', '#f88');
            return null;
          }
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (e) {
            $m.find('#wi_th_imp_groups_status').text('❌ JSON 解析失败：' + e.message).css('color', '#f88');
            return null;
          }
          if (!parsed || typeof parsed !== 'object' || !parsed.groups) {
            $m.find('#wi_th_imp_groups_status').text('❌ 格式不对（缺少 groups 字段）').css('color', '#f88');
            return null;
          }
          return parsed;
        };

        $m.find('#wi_th_imp_groups_merge').on('click', () => {
          const parsed = parseImported();
          if (!parsed) return;
          const inGroups = parsed.groups || {};
          const inOrder = Array.isArray(parsed.groupOrder) ? parsed.groupOrder : Object.keys(inGroups);

          let addedGroups = 0;
          let addedThemes = 0;

          inOrder.forEach(gname => {
            const themes = Array.isArray(inGroups[gname]) ? inGroups[gname] : [];
            if (!thState.groups[gname]) {
              thState.groups[gname] = [];
              thState.groupOrder.push(gname);
              addedGroups++;
            }
            themes.forEach(n => {
              // 检查是否已经在这个分组里
              const already = Object.values(thState.groups).some(arr => arr.includes(n));
              if (!already) {
                thState.groups[gname].push(n);
                addedThemes++;
              }
            });
          });

          // 合并 collapsed
          if (parsed.collapsed && typeof parsed.collapsed === 'object') {
            Object.assign(thState.collapsed, parsed.collapsed);
          }

          saveThemeGroups();
          loadThemeList();

          $m.find('#wi_th_imp_groups_status').text(
            `✅ 合并完成：新增 ${addedGroups} 个分组、${addedThemes} 个主题。`
          ).css('color', '#6ac06a');

          setTimeout(() => { $m.closest('#wi_modal_mask').remove(); }, 1200);
        });

        $m.find('#wi_th_imp_groups_replace').on('click', () => {
          const parsed = parseImported();
          if (!parsed) return;
          if (!confirm('⚠️ 这会清空你当前所有分组配置，用导入的替换。\n\n确定？')) return;

          thState.groups = parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {};
          thState.groupOrder = Array.isArray(parsed.groupOrder)
            ? parsed.groupOrder.slice()
            : Object.keys(thState.groups);
          thState.collapsed = parsed.collapsed && typeof parsed.collapsed === 'object' ? parsed.collapsed : {};

          // 确保"未分组"存在
          if (!thState.groups[thState.ungrouped]) thState.groups[thState.ungrouped] = [];
          if (!thState.groupOrder.includes(thState.ungrouped)) {
            thState.groupOrder.push(thState.ungrouped);
          }

          saveThemeGroups();
          // 归一化：把不在任何分组的主题塞到"未分组"
          loadThemeList();

          $m.find('#wi_th_imp_groups_status').text('✅ 替换完成。').css('color', '#6ac06a');
          setTimeout(() => { $m.closest('#wi_modal_mask').remove(); }, 1000);
        });
      });
    });

    // ============ 主题 Tab 绑定 ============
    $('#wi_th_refresh').on('click', loadThemeList);
    $('#wi_th_search').on('input', function () {
      thState.filter = $(this).val() || '';
      renderThemeList();
    });

    $('#wi_th_new_group').on('click', () => {
      const name = prompt('新分组名：', '');
      if (!name) return;
      if (thState.groups[name]) { alert('已存在同名分组'); return; }
      thState.groups[name] = [];
      thState.groupOrder.push(name);
      saveThemeGroups();
      renderThemeList();
    });

    $('#wi_th_import').on('click', () => {
      openThemeImportDialog();
    });

    function openThemeImportDialog() {
      showModal(`
        <div style="font-size:13px;font-weight:700;color:#eee;margin-bottom:6px">📥 导入主题</div>
        <div style="font-size:11px;color:#888;margin-bottom:8px;line-height:1.6">
          粘贴主题 JSON（可以是 <b>单个主题对象</b> 或 <b>主题数组</b>）。<br>
          <span style="color:#e0c060">导入会调用酒馆 API 保存，导入后主题会出现在酒馆原生主题列表里。</span>
        </div>
        <div style="margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap">
          <button id="wi_th_imp_file" style="${BTN_CSS}">📁 选择 JSON 文件</button>
        </div>
        <textarea id="wi_th_imp_json" placeholder='[{ "name": "...", ... }] 或 { "name": "...", ... }' style="width:100%;height:240px;background:#161618;color:#bbb;border:1px solid #444;border-radius:4px;padding:8px;box-sizing:border-box;font-family:monospace;font-size:11px;resize:vertical"></textarea>
        <div id="wi_th_imp_status" style="font-size:11px;color:#888;margin-top:6px"></div>
        <div style="margin-top:8px;display:flex;gap:6px;justify-content:flex-end;flex-wrap:wrap">
          <button id="wi_th_imp_save" style="${BTN_PRIMARY_CSS}">📥 导入</button>
          <button id="wi_th_imp_cancel" data-wi-close style="${BTN_CSS}">取消</button>
        </div>
      `, ($m) => {
        $m.find('#wi_th_imp_file').on('click', async () => {
          const picked = await pickJsonFile();
          if (!picked) return;
          $m.find('#wi_th_imp_json').val(picked.text);
          $m.find('#wi_th_imp_status').text(`📄 已读取：${picked.name}（${picked.text.length} 字符）`).css('color', '#8cf');
        });

        $m.find('#wi_th_imp_save').on('click', async () => {
          const raw = $m.find('#wi_th_imp_json').val() || '';
          if (!raw.trim()) {
            $m.find('#wi_th_imp_status').text('❌ 请粘贴 JSON').css('color', '#f88');
            return;
          }

          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch (e) {
            $m.find('#wi_th_imp_status').text('❌ JSON 解析失败：' + e.message).css('color', '#f88');
            return;
          }

          // 统一成数组
          const themes = Array.isArray(parsed) ? parsed : [parsed];
          if (themes.length === 0) {
            $m.find('#wi_th_imp_status').text('❌ 空数组').css('color', '#f88');
            return;
          }

          // 校验每个主题
          const valid = [];
          const invalid = [];
          themes.forEach((t, i) => {
            if (!t || typeof t !== 'object') {
              invalid.push(`[${i}] 不是对象`);
              return;
            }
            if (!t.name || typeof t.name !== 'string') {
              invalid.push(`[${i}] 缺少 name 字段`);
              return;
            }
            valid.push(t);
          });

          if (valid.length === 0) {
            $m.find('#wi_th_imp_status').text('❌ 没有合法主题。' + invalid.join('；')).css('color', '#f88');
            return;
          }

          $m.find('#wi_th_imp_status').text(`正在导入 ${valid.length} 个主题…`).css('color', '#8cf');
          $m.find('#wi_th_imp_save').prop('disabled', true).text('导入中…');

          const ctx = SillyTavern.getContext();
          const headers = ctx.getRequestHeaders ? ctx.getRequestHeaders() : { 'Content-Type': 'application/json' };

          let okCount = 0;
          const failed = [];

          for (const theme of valid) {
            try {
              const r = await fetch('/api/themes/save', {
                method: 'POST',
                headers,
                body: JSON.stringify(theme),
              });
              if (r.ok) {
                okCount++;
                // 手动加到 #themes 下拉框
                addThemeOption(theme.name);
              } else {
                failed.push(`${theme.name}: HTTP ${r.status}`);
              }
            } catch (e) {
              failed.push(`${theme.name}: ${e.message}`);
            }
          }

          // 刷新 WI 主题列表
          loadThemeList();

          // 结果
          let msg = `✅ 成功导入 ${okCount} / ${valid.length} 个主题。`;
          if (failed.length > 0) {
            msg += `\n\n失败：\n${failed.join('\n')}`;
          }
          $m.find('#wi_th_imp_status').text(msg).css('color', okCount > 0 ? '#6ac06a' : '#f88');
          $m.find('#wi_th_imp_save').prop('disabled', false).text('📥 导入');

          if (okCount > 0) {
            setTimeout(() => {
              $m.closest('#wi_modal_mask').remove();
              const reload = confirm(
                `✅ 成功导入 ${okCount} 个主题。\n\n` +
                `酒馆需要刷新页面才能应用新导入的主题（因为主题数据在酒馆内存里缓存了）。\n\n` +
                `现在刷新？`
              );
              if (reload) {
                location.reload();
              }
            }, 1500);
          }
        });
      });
    }

    // 往 #themes 下拉框添加一个 option（如果不存在）
    function addThemeOption(name) {
      const sel = __wiRootDoc.querySelector('#themes');
      if (!sel) return;
      const exists = Array.from(sel.options).some(o => o.value === name);
      if (exists) return;
      const jq = window.jQuery || (window.top && window.top.jQuery);
      if (jq) {
        const $opt = jq('<option>').val(name).text(name);
        jq(sel).append($opt);
      } else {
        const opt = __wiRootDoc.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      }
    }

    // 切到主题 Tab 时自动刷新
    $('.wi-tab[data-tab="theme"]').on('click', () => {
      try {
        loadThemeGroups();
        // 恢复搜索框显示的内容
        $('#wi_th_search').val(thState.filter || '');
        loadThemeList();
      } catch (e) { err('主题 Tab 刷新失败', e); }
    });

    // 初始化（脚本加载时读一次）
    loadThemeGroups();
    loadThemeList();

    // ============ 世界书功能绑定 ============
    $('#wi_close').click(() => $(`#${PANEL_ID}`).hide());
    $('#wi_fullscreen').click(toggleFullscreen);
    $('#wi_theme_btn').click(function (ev) {
      ev.preventDefault();
      ev.stopPropagation();

      // ★ 如果菜单已经开着，点按钮就关掉它
      const _existing = __wiRootDoc.querySelectorAll('.wi-theme-menu');
      if (_existing.length > 0) {
        _existing.forEach(el => el.remove());
        return;
      }

      const btn = this;
      const rect = btn.getBoundingClientRect();

      const menu = __wiRootDoc.createElement('div');
      menu.className = 'wi-theme-menu';
      menu.style.cssText = `
        position: fixed;
        z-index: 2147483647;
        background: var(--wi-bg);
        border: 1px solid var(--wi-border-strong);
        border-radius: 8px;
        padding: 4px 0;
        min-width: 140px;
        box-shadow: 0 8px 24px var(--wi-shadow);
        font-size: 12px;
        color: var(--wi-fg);
        user-select: none;
      `;

      Object.entries(WI_THEMES).forEach(([key, t]) => {
        const row = __wiRootDoc.createElement('div');
        const isActive = key === __wiTheme;
        row.style.cssText = `padding:8px 14px;cursor:pointer;white-space:nowrap;color:${isActive ? 'var(--wi-accent)' : 'var(--wi-fg)'};font-weight:${isActive ? '600' : '400'};`;
        row.textContent = (isActive ? '✓ ' : '  ') + t.name;
        row.addEventListener('mouseenter', () => {
          row.style.background = 'var(--wi-hover)';
        });
        row.addEventListener('mouseleave', () => {
          row.style.background = 'transparent';
        });
        row.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          applyWiTheme(key);
          menu.remove();
          // 提示一下
          if (window.toastr) {
            window.toastr.success('已切换到：' + t.name);
          } else {
            console.log('[WI编辑器] 已切换到：' + t.name);
          }
        });
        menu.appendChild(row);
      });

      __wiRootDoc.body.appendChild(menu);

      // 定位（用顶层 window，脚本可能在无布局的 iframe 里）
      const _win = (window.top && window.top.innerHeight) ? window.top : window;
      let x = rect.right - menu.offsetWidth;
      let y = rect.bottom + 4;
      if (x < 8) x = 8;
      if (x + menu.offsetWidth > _win.innerWidth - 8) {
        x = _win.innerWidth - menu.offsetWidth - 8;
      }
      if (y + menu.offsetHeight > _win.innerHeight - 8) {
        y = rect.top - menu.offsetHeight - 4;
      }
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';

      // 点外部关闭
      setTimeout(() => {
      const handler = (e) => {
        // 点 🎨 按钮本身，交给按钮的 click handler 处理（切换开关），这里不管
        if (e.target === btn || btn.contains(e.target)) return;
        if (!menu.contains(e.target)) {
          menu.remove();
          __wiRootDoc.removeEventListener('click', handler, true);
        }
      };
        __wiRootDoc.addEventListener('click', handler, true);
      }, 0);
    });
    $('#wi_refresh').click(loadBookList);
    $('#wi_undo').click(undo);
    $('#wi_export_btn').click(exportSelected);
    $('#wi_import_btn').click(importJson);
    $('#wi_batch_export').click(exportSelected);

    $('#wi_batch_toggle').click(() => {
      state.batchMode = !state.batchMode;
      const $bar = $('#wi_batch_bar');
      if (state.batchMode) {
        $bar.css('display', 'flex');
        $('#wi_batch_toggle').text('退出批量');
      } else {
        $bar.hide();
        $('#wi_batch_toggle').text('☑ 批量');
        state.selectedUids.clear();
      }
      renderEntryList();
    });

    $('#wi_batch_select_all').click(() => {
      state.selectedUids.clear();
      state.entries.forEach(e => {
        if (e.uid !== undefined) state.selectedUids.add(e.uid);
      });
      renderEntryList();
      updateBatchCount();
    });

    $('#wi_batch_select_none').click(() => {
      state.selectedUids.clear();
      renderEntryList();
      updateBatchCount();
    });

    $('#wi_batch_select_invert').click(() => {
      const newSet = new Set();
      state.entries.forEach(e => {
        if (e.uid !== undefined && !state.selectedUids.has(e.uid)) newSet.add(e.uid);
      });
      state.selectedUids = newSet;
      renderEntryList();
      updateBatchCount();
    });

    $('#wi_batch_enable').click(() => batchSetEnabled(true));
    $('#wi_batch_disable').click(() => batchSetEnabled(false));
    $('#wi_wb_group_toggle').click(() => {
      state.groupView = !state.groupView;
      if (state.groupView) {
        $('#wi_wb_group_toggle').text('📋 列表');
        $('#wi_wb_group_toggle').attr('title', '切换回列表视图');
      } else {
        $('#wi_wb_group_toggle').text('📁 分组');
        $('#wi_wb_group_toggle').attr('title', '切换分组视图');
      }
      renderEntryList();
    });

    $('#wi_search_toggle').click(() => {
      const $bar = $('#wi_search_bar');
      if ($bar.is(':visible')) $bar.hide();
      else $bar.css('display', 'flex');
    });

    $('#wi_search_input').on('input', () => {
      state.searchTerm = $('#wi_search_input').val();
      state.searchRegex = $('#wi_search_regex').is(':checked');
      rebuildMatches();
      renderEntryList();
      renderAllPreviews();
    });

    $('#wi_search_regex').on('change', () => {
      state.searchRegex = $('#wi_search_regex').is(':checked');
      rebuildMatches();
      renderEntryList();
      renderAllPreviews();
    });

    $('#wi_search_next').click(() => gotoMatch(state.matchCursor + 1));
    $('#wi_search_prev').click(() => gotoMatch(state.matchCursor - 1));

    $('#wi_search_input').on('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) gotoMatch(state.matchCursor - 1);
        else gotoMatch(state.matchCursor + 1);
      }
    });

    $('#wi_search_clear').click(() => {
      $('#wi_search_input').val('');
      state.searchTerm = '';
      state.matchList = [];
      state.matchCursor = -1;
      updateMatchCounter();
      renderEntryList();
      renderAllPreviews();
    });

    $('#wi_replace_one').click(doReplaceOne);
    $('#wi_replace_btn').click(doReplaceAll);

    $('#wi_follow_char').on('change', function () {
      state.followChar = $(this).prop('checked');
      loadBookList();
    });
    $('#wi_book_select').on('change', async function () {
      await flushAutoSave();
      state.activeBook = $(this).val();
      // ★ 同步伪输入框的显示文字
      $('#wi_book_select_label').text(state.activeBook || '(未选)').attr('title', state.activeBook || '');
      await loadEntries();
      renderEntryList();
      clearForm();
    });

    // ★ 点击伪输入框 → 打开可搜索下拉
    $('#wi_book_select_btn').on('click', async (ev) => {
      // 先确保 select 已填好
      if (!state.books || state.books.length === 0) {
        await loadBookList();
      }
      const items = (state.books || []).map(b => ({ value: b, label: b }));
      // ★ 直接从 DOM 拿元素，避免 ev.currentTarget 在 await 后变 null
      const triggerEl = __wiRootDoc.getElementById('wi_book_select_btn');
      openSearchableDropdown(null, {
        items,
        placeholder: '搜索世界书…',
        triggerEl,   // ★ 新增：直接传元素
        onPick: (val) => {
          const $sel = $('#wi_book_select');
          if ($sel.val() !== val) {
            $sel.val(val).trigger('change');
          }
        },
      });
    });
    $('#wi_new_entry').click(newEntry);
    $('#wi_del_entry').click(deleteEntry);

    $posSel.on('change', updateDepthState);

    $('#wi_name, #wi_content, #wi_keys, #wi_depth, #wi_order').on('input', () => {
      scheduleAutoSave();
    }).on('blur', () => {
      flushAutoSave();
    });

    $('#wi_pos, #wi_strategy, #wi_enabled, #wi_prevent_outgoing, #wi_prevent_incoming').on('change', () => {
      scheduleAutoSave();
    });

    $('#wi_content').on('input', () => { renderContentPreview(); });
    $('#wi_keys').on('input', () => { renderKeysPreview(); });

    // ★ 设置 Tab：显示长条开关
    (function bindSettingsTab() {
      const cb = __wiRootDoc.getElementById('wi_set_show_floating');
      if (cb) {
        cb.checked = loadWiSettings().showFloatingBtn;
        cb.addEventListener('change', () => {
          const s = loadWiSettings();
          s.showFloatingBtn = cb.checked;
          saveWiSettings(s);
          applyWiSettings();
        });
      }

      const extCb = __wiRootDoc.getElementById('wi_set_show_ext_entry');
      if (extCb) {
        const s0 = loadWiSettings();
        extCb.checked = s0.showExtEntry !== false;
        extCb.addEventListener('change', () => {
          const s = loadWiSettings();
          s.showExtEntry = extCb.checked;
          saveWiSettings(s);
          if (extCb.checked) {
            const drawer = __wiRootDoc.getElementById('wi_ext_drawer');
            if (!drawer) injectIntoExtensionsPanel();
          } else {
            const drawer = __wiRootDoc.getElementById('wi_ext_drawer');
            if (drawer) drawer.remove();
          }
        });
      }

      const resetBtn = __wiRootDoc.getElementById('wi_set_reset_layout');
      if (resetBtn) {
        resetBtn.addEventListener('click', () => {
          localStorage.removeItem('wi_panel_layout');
          const $p = $(`#${PANEL_ID}`);
          $p.css({
            left: 'auto', top: 'auto',
            right: '16px', bottom: '52px',
            width: '780px', height: '82vh',
          });
          if (window.toastr) window.toastr.success('已恢复默认布局');
        });
      }
    })();

    $('#wi_follow_char').prop('checked', state.followChar);

    ensureMeasureEl();
    updateUndoBtn();
    loadBookList();

    // ★ 面板已建好，此时应用 WI 主题变量到面板元素上
    applyWiTheme(__wiTheme);
    // ★ 应用持久化的设置（显示/隐藏长条）
    applyWiSettings();
    // ★ 恢复面板位置 + 绑定拖动
    applyPanelPosition();
    bindPanelDrag();
    bindPanelResize();

    // ★ 注册清理函数，供"新实例接管"时调用
    __wiInstanceInfo.kill = function __wiKillSelf() {
      try {
        console.log('[PsychoWI] 正在清理实例 v' + WI_VERSION);
        // 1. 移除注入的 DOM
        const sels = [
          '#wi_live_editor_btn',
          '#wi_live_editor_panel',
          '.wi-search-dropdown',
          '.wi-theme-menu',
          '.wi-mini-menu',
          '#wi_modal_mask',
          '#wi_theme_override_css',
          '#wi_gr_drag_css',
          '#wi_cm_theme_override',
          '#wi_measure',
          '#wi_ext_drawer',
        ];
        sels.forEach(sel => {
          try { __wiRootDoc.querySelectorAll(sel).forEach(el => el.remove()); } catch (e) {}
        });
        // 2. 清定时器
        try { clearInterval(window.__wiGroupPollTimer); } catch (e) {}
        try { clearInterval(window.__wiModalCleanupTimer); } catch (e) {}
        try { clearTimeout(_autoSaveTimer); } catch (e) {}
        try { clearTimeout(_chTimer); } catch (e) {}
        try { clearTimeout(_chGrTimer); } catch (e) {}
        try { clearTimeout(_reTimer); } catch (e) {}
        try { clearTimeout(_scTimer); } catch (e) {}
        // 3. 清 window 标记（让新实例的"防重复"逻辑能生效）
        delete window.__wiClosePatched;
        delete window.__wiSwipeEventBound;
        delete window.__wiCharListEventsBound;
        delete window.__wiShowMiniMenu;
        delete window.__wiCloseModal;
        delete window.__wiWbDragUid;
        delete window.__wiDragState;
        // 4. 从注册表移除自己
        try {
          __wiTopWin.__wiInstances = (__wiTopWin.__wiInstances || []).filter(i => i !== __wiInstanceInfo);
        } catch (e) {}
        console.log('[PsychoWI] 实例 v' + WI_VERSION + ' 已清理');
      } catch (e) {
        console.error('[PsychoWI] 清理实例失败', e);
      }
    };
  }   // ← ★ 加这个，闭合 buildUI

  function updateDepthState() {
    const posNum = Number($('#wi_pos').val());
    const isAtDepth = posNum === 4;
    $('#wi_depth').prop('disabled', !isAtDepth).css({
      opacity: isAtDepth ? 1 : 0.5,
      cursor: isAtDepth ? 'text' : 'not-allowed'
    });
    $('#wi_depth_hint').text(isAtDepth ? '' : '（仅 @D 时生效）');
  }

  function updateBatchCount() {
    $('#wi_batch_count').text(state.selectedUids.size);
    $('#wi_batch_total').text(state.entries.length);
  }

  function charCountColor(n) {
    if (n < 500) return '#6ac06a';
    if (n < 2000) return '#e0c060';
    return '#e07070';
  }

  async function batchSetEnabled(enabled) {
    if (state.selectedUids.size === 0) {
      alert('没有选中任何条目');
      return;
    }
    const label = enabled ? '启用' : '禁用';
    if (!confirm(`将 ${label} ${state.selectedUids.size} 条条目？`)) return;

    pushHistory();

    let count = 0;
    state.entries.forEach(e => {
      if (e.uid !== undefined && state.selectedUids.has(e.uid)) {
        e.enabled = enabled;
        count++;
      }
    });
    renderEntryList();

    await safeSaveWb(state.activeBook, state.entries);
    updateBatchCount();
  }

  // ★ 面板拖动
  function bindPanelDrag() {
    const $panel = $(`#${PANEL_ID}`);
    if (!$panel.length) return;
    const $bar = $panel.find('#wi_tab_bar');
    if (!$bar.length) return;

    let dragging = false;
    let startX = 0, startY = 0;
    let startLeft = 0, startTop = 0;

    $bar.on('mousedown', function (ev) {
      // 只处理左键
      if (ev.button !== 0) return;
      // 点在 Tab / 按钮 / 输入框上，不拖动
      const $t = $(ev.target);
      if ($t.closest('.wi-tab, button, input, select, a, label').length) return;
      // 全屏时不拖
      if (state.isFullscreen) return;

      ev.preventDefault();

      const rect = $panel[0].getBoundingClientRect();
      startX = ev.clientX;
      startY = ev.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      dragging = true;

      // ★ 缓存不变的值，避免拖动时反复触发 reflow
      cachedW = rect.width;
      cachedH = rect.height;
      cachedVW = (window.top && window.top.innerWidth) ? window.top.innerWidth : window.innerWidth;
      cachedVH = (window.top && window.top.innerHeight) ? window.top.innerHeight : window.innerHeight;

      // 确保面板用的是 left/top 定位
      $panel.css({
        right: 'auto',
        bottom: 'auto',
        left: startLeft + 'px',
        top: startTop + 'px',
        willChange: 'left, top',
      });

      $bar.css('cursor', 'grabbing');
      $('body').css('user-select', 'none');
    });

    // ★ 触屏拖动
    $bar.on('touchstart', function (ev) {
      if (state.isFullscreen) return;
      const $t = $(ev.target);
      if ($t.closest('.wi-tab, button, input, select, a, label').length) return;
      const touch = ev.originalEvent.touches[0];
      if (!touch) return;

      const rect = $panel[0].getBoundingClientRect();
      startX = touch.clientX;
      startY = touch.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      dragging = true;

      cachedW = rect.width;
      cachedH = rect.height;
      cachedVW = (window.top && window.top.innerWidth) ? window.top.innerWidth : window.innerWidth;
      cachedVH = (window.top && window.top.innerHeight) ? window.top.innerHeight : window.innerHeight;

      $panel.css({
        right: 'auto',
        bottom: 'auto',
        left: startLeft + 'px',
        top: startTop + 'px',
        willChange: 'left, top',
      });
    });

    // 拖动时缓存的量（避免每次 mousemove 触发 reflow）
    let cachedW = 0, cachedH = 0, cachedVW = 0, cachedVH = 0;

    $(__wiRootDoc).on('mousemove', function (ev) {
      if (!dragging) return;
      ev.preventDefault();

      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      // 边界限制
      newLeft = Math.max(80 - cachedW, Math.min(cachedVW - 80, newLeft));
      newTop = Math.max(0, Math.min(cachedVH - 40, newTop));

      // 用 transform 代替 left/top？暂时还是用 left/top，但加 will-change
      $panel[0].style.left = newLeft + 'px';
      $panel[0].style.top = newTop + 'px';
    });

    // ★ 触屏拖动（move）
    $(__wiRootDoc).on('touchmove', function (ev) {
      if (!dragging) return;
      const touch = ev.originalEvent.touches[0];
      if (!touch) return;
      ev.preventDefault();   // 阻止页面滚动

      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      let newLeft = startLeft + dx;
      let newTop = startTop + dy;

      newLeft = Math.max(80 - cachedW, Math.min(cachedVW - 80, newLeft));
      newTop = Math.max(0, Math.min(cachedVH - 40, newTop));

      $panel[0].style.left = newLeft + 'px';
      $panel[0].style.top = newTop + 'px';
    });

    $(__wiRootDoc).on('mouseup', function () {
      if (!dragging) return;
      dragging = false;
      $bar.css('cursor', 'grab');
      $('body').css('user-select', '');
      $panel.css('willChange', '');

      // 保存位置
      const rect = $panel[0].getBoundingClientRect();
      const layout = loadPanelLayout() || {};
      layout.left = Math.round(rect.left);
      layout.top = Math.round(rect.top);
      savePanelLayout(layout);
    });

    // ★ 触屏拖动（end）
    $(__wiRootDoc).on('touchend touchcancel', function () {
      if (!dragging) return;
      dragging = false;
      $panel.css('willChange', '');

      const rect = $panel[0].getBoundingClientRect();
      const layout = loadPanelLayout() || {};
      layout.left = Math.round(rect.left);
      layout.top = Math.round(rect.top);
      savePanelLayout(layout);
    });
  }

  // ★ 面板缩放（边缘拉伸）
  function bindPanelResize() {
    const $panel = $(`#${PANEL_ID}`);
    if (!$panel.length) return;

    // 用 DOM 直接加手柄（避免 HTML 太长）
    const panelEl = $panel[0];
    if (panelEl.querySelector('.wi-resize-edge')) return; // 已加过

    // 右边缘
    const edgeR = __wiRootDoc.createElement('div');
    edgeR.className = 'wi-resize-edge wi-resize-right';
    edgeR.style.cssText = 'position:absolute;top:0;right:0;width:6px;height:100%;cursor:ew-resize;z-index:10;';
    panelEl.appendChild(edgeR);

    // 下边缘
    const edgeB = __wiRootDoc.createElement('div');
    edgeB.className = 'wi-resize-edge wi-resize-bottom';
    edgeB.style.cssText = 'position:absolute;left:0;bottom:0;height:6px;width:100%;cursor:ns-resize;z-index:10;';
    panelEl.appendChild(edgeB);

    // 右下角
    const corner = __wiRootDoc.createElement('div');
    corner.className = 'wi-resize-edge wi-resize-corner';
    corner.style.cssText = 'position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;z-index:11;';
    panelEl.appendChild(corner);

    let resizing = null; // 'right' | 'bottom' | 'corner'
    let startX = 0, startY = 0, startW = 0, startH = 0, startL = 0, startT = 0;
    let vw = 0, vh = 0;

    function beginResize(mode, ev) {
      if (state.isFullscreen) return;
      ev.preventDefault();
      ev.stopPropagation();

      const rect = panelEl.getBoundingClientRect();
      resizing = mode;
      startX = ev.clientX;
      startY = ev.clientY;
      startW = rect.width;
      startH = rect.height;
      startL = rect.left;
      startT = rect.top;
      vw = (window.top && window.top.innerWidth) ? window.top.innerWidth : window.innerWidth;
      vh = (window.top && window.top.innerHeight) ? window.top.innerHeight : window.innerHeight;

      $panel.css({
        right: 'auto',
        bottom: 'auto',
        left: startL + 'px',
        top: startT + 'px',
        willChange: 'width, height',
      });
      $('body').css('user-select', 'none');
    }

    function beginResizeTouch(mode, ev) {
      if (state.isFullscreen) return;
      ev.preventDefault();
      ev.stopPropagation();

      const touch = ev.touches[0];
      if (!touch) return;

      const rect = panelEl.getBoundingClientRect();
      resizing = mode;
      startX = touch.clientX;
      startY = touch.clientY;
      startW = rect.width;
      startH = rect.height;
      startL = rect.left;
      startT = rect.top;
      vw = (window.top && window.top.innerWidth) ? window.top.innerWidth : window.innerWidth;
      vh = (window.top && window.top.innerHeight) ? window.top.innerHeight : window.innerHeight;

      $panel.css({
        right: 'auto',
        bottom: 'auto',
        left: startL + 'px',
        top: startT + 'px',
        willChange: 'width, height',
      });
    }

    edgeR.addEventListener('mousedown', (ev) => beginResize('right', ev));
    edgeB.addEventListener('mousedown', (ev) => beginResize('bottom', ev));
    corner.addEventListener('mousedown', (ev) => beginResize('corner', ev));
    // ★ 触屏
    edgeR.addEventListener('touchstart', (ev) => beginResizeTouch('right', ev), { passive: false });
    edgeB.addEventListener('touchstart', (ev) => beginResizeTouch('bottom', ev), { passive: false });
    corner.addEventListener('touchstart', (ev) => beginResizeTouch('corner', ev), { passive: false });

    const MIN_W = 500, MIN_H = 400;
    const MAX_W = () => vw - 40;
    const MAX_H = () => vh - 40;

    $(__wiRootDoc).on('mousemove', function (ev) {
      if (!resizing) return;
      ev.preventDefault();

      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      if (resizing === 'right' || resizing === 'corner') {
        let newW = startW + dx;
        newW = Math.max(MIN_W, Math.min(MAX_W(), newW));
        panelEl.style.width = newW + 'px';
      }
      if (resizing === 'bottom' || resizing === 'corner') {
        let newH = startH + dy;
        newH = Math.max(MIN_H, Math.min(MAX_H(), newH));
        panelEl.style.height = newH + 'px';
      }
    });

    // ★ 触屏缩放
    $(__wiRootDoc).on('touchmove', function (ev) {
      if (!resizing) return;
      const touch = ev.originalEvent.touches[0];
      if (!touch) return;
      ev.preventDefault();

      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (resizing === 'right' || resizing === 'corner') {
        let newW = startW + dx;
        newW = Math.max(MIN_W, Math.min(MAX_W(), newW));
        panelEl.style.width = newW + 'px';
      }
      if (resizing === 'bottom' || resizing === 'corner') {
        let newH = startH + dy;
        newH = Math.max(MIN_H, Math.min(MAX_H(), newH));
        panelEl.style.height = newH + 'px';
      }
    });

    $(__wiRootDoc).on('mouseup', function () {
      if (!resizing) return;
      resizing = null;
      $('body').css('user-select', '');
      $panel.css('willChange', '');

      const rect = panelEl.getBoundingClientRect();
      const layout = loadPanelLayout() || {};
      layout.width = Math.round(rect.width);
      layout.height = Math.round(rect.height);
      layout.left = Math.round(rect.left);
      layout.top = Math.round(rect.top);
      savePanelLayout(layout);
    });

    // ★ 触屏缩放结束
    $(__wiRootDoc).on('touchend touchcancel', function () {
      if (!resizing) return;
      resizing = null;
      $panel.css('willChange', '');

      const rect = panelEl.getBoundingClientRect();
      const layout = loadPanelLayout() || {};
      layout.width = Math.round(rect.width);
      layout.height = Math.round(rect.height);
      layout.left = Math.round(rect.left);
      layout.top = Math.round(rect.top);
      savePanelLayout(layout);
    });
  }

  function toggleFullscreen() {
    const $p = $(`#${PANEL_ID}`);
    if (!$p.length) return;

    state.isFullscreen = !state.isFullscreen;

    if (state.isFullscreen) {
      $p.data('wi_prev_style', {
        position: $p[0].style.position,
        left: $p[0].style.left,
        top: $p[0].style.top,
        right: $p[0].style.right,
        bottom: $p[0].style.bottom,
        width: $p[0].style.width,
        height: $p[0].style.height,
        borderRadius: $p[0].style.borderRadius,
      });
      $p.css({
        position: 'fixed',
        top: 0, left: 0, right: 0, bottom: 0,
        width: '100vw', height: '100vh',
        borderRadius: 0,
        zIndex: 999999,
      });
      $('#wi_list').css('width', '500px');
    } else {
      const prev = $p.data('wi_prev_style') || {};
      $p.css({
        position: 'fixed',
        top: prev.top || 'auto',
        left: prev.left || 'auto',
        right: prev.right || '16px',
        bottom: prev.bottom || '52px',
        width: prev.width || '780px',
        height: prev.height || '82vh',
        borderRadius: prev.borderRadius || '8px',
        zIndex: 9998,
      });
      $('#wi_list').css('width', '260px');
    }
  }

  function togglePanel() {
    const $p = $(`#${PANEL_ID}`);
    if ($p.is(':visible')) {
      $p.hide();
    } else {
      $p.css('display', 'flex');
      if (!state.activeBook) {
        loadBookList();
      } else {
        renderEntryList();
        renderAllPreviews();
        updateMatchCounter();
      }
    }
  }

  async function loadBookList() {
    const $sel = $('#wi_book_select').empty();
    state.books = [];
    if (state.followChar) {
      const charWb = await safeGetCharWbNames('current');
      if (charWb?.primary) state.books.push(charWb.primary);
      if (Array.isArray(charWb?.additional)) state.books.push(...charWb.additional);
    }
    const globalList = await getWorldbookNames();
    for (const b of globalList) {
      if (!state.books.includes(b)) state.books.push(b);
    }
    state.books.forEach(b => $sel.append($('<option>').val(b).text(b)));
    if (state.books.length > 0) {
      state.activeBook = state.books[0];
      $sel.val(state.activeBook);
      // ★ 同步伪输入框的显示文字
      $('#wi_book_select_label').text(state.activeBook || '(未选)').attr('title', state.activeBook || '');
      await loadEntries();
      renderEntryList();
    } else {
      $('#wi_book_select_label').text('(无世界书)').attr('title', '');
    }
  }

  async function loadEntries() {
    if (!state.activeBook) return;

    let orderedUids = null;
    try {
      const ctx = SillyTavern.getContext();
      if (ctx && typeof ctx.loadWorldInfo === 'function') {
        const native = await ctx.loadWorldInfo(state.activeBook);
        if (native && native.entries) {
          const list = Object.values(native.entries);
          list.sort((a, b) => {
            const da = Number(a.displayIndex ?? 9999);
            const db = Number(b.displayIndex ?? 9999);
            return da - db;
          });
          orderedUids = list.map(e => e.uid);
        }
      }
    } catch (e) {
      err('读取 displayIndex 失败', e);
    }

    state.entries = await safeGetWb(state.activeBook);

    if (orderedUids && orderedUids.length) {
      const byUid = {};
      state.entries.forEach(e => { byUid[e.uid] = e; });
      const reordered = [];
      orderedUids.forEach(uid => {
        if (byUid[uid]) reordered.push(byUid[uid]);
      });
      state.entries.forEach(e => {
        if (!reordered.includes(e)) reordered.push(e);
      });
      state.entries = reordered;
    }

    state.selectedIdx = -1;
    state.matchList = [];
    state.selectedUids.clear();
    state.matchCursor = -1;
    clearForm();
    parseWbGroupsFromEntries(state.entries);
    updateMatchCounter();
    updateBatchCount();
  }

  function findMatchesInStr(s, term, useRegex) {
    if (!s || !term) return [];
    const out = [];
    if (useRegex) {
      let re;
      try { re = new RegExp(term, 'gi'); }
      catch (e) { return []; }
      let m;
      while ((m = re.exec(s)) !== null) {
        out.push({ start: m.index, end: m.index + m[0].length });
        if (m[0].length === 0) re.lastIndex++;
      }
    } else {
      const lowerS = s.toLowerCase();
      const lowerTerm = term.toLowerCase();
      let idx = 0;
      while (true) {
        const pos = lowerS.indexOf(lowerTerm, idx);
        if (pos < 0) break;
        out.push({ start: pos, end: pos + term.length });
        idx = pos + term.length;
      }
    }
    return out;
  }

  function rebuildMatches() {
    const term = state.searchTerm || '';
    const useRegex = state.searchRegex;
    state.matchList = [];
    state.matchCursor = -1;
    if (!term) { updateMatchCounter(); return; }

    state.entries.forEach((e, entryIdx) => {
      const fields = [
        { field: 'keys',    value: (e.strategy?.keys || []).join(', ') },
        { field: 'content', value: e.content || '' },
      ];
      for (const f of fields) {
        const ms = findMatchesInStr(f.value, term, useRegex);
        for (const m of ms) {
          state.matchList.push({
            entryIdx,
            field: f.field,
            start: m.start,
            end: m.end,
            text: f.value.slice(m.start, m.end),
          });
        }
      }
    });
    updateMatchCounter();
  }

  function updateMatchCounter() {
    const total = state.matchList.length;
    const cur = state.matchCursor >= 0 ? state.matchCursor + 1 : 0;
    $('#wi_match_counter').text(`${cur} / ${total}`);
  }

  function gotoMatch(n) {
    if (state.matchList.length === 0) return;
    if (n < 0) n = state.matchList.length - 1;
    if (n >= state.matchList.length) n = 0;
    state.matchCursor = n;

    const m = state.matchList[n];
    state.selectedIdx = m.entryIdx;
    fillFormByEntry(state.entries[m.entryIdx]);
    updateMatchCounter();
    renderEntryList();
    renderAllPreviews();
    focusFieldMatch(m);
    scrollPreviewToCurrentMatch(m.field);
    setTimeout(() => { scrollPreviewToCurrentMatch(m.field); }, 100);
  }

  function scrollTextareaToPos($ta, fullText, pos) {
    const ta = $ta[0];
    if (!ta) return;
    ensureMeasureEl();
    const $m = $('#wi_measure');
    $m.css({
      width: ta.clientWidth + 'px',
      fontFamily: $(ta).css('font-family'),
      fontSize: $(ta).css('font-size'),
      lineHeight: $(ta).css('line-height'),
      padding: $(ta).css('padding'),
      boxSizing: 'border-box',
    });
    const before = fullText.slice(0, pos);
    const targetChar = fullText.slice(pos, pos + 1) || ' ';
    $m.empty()
      .append(document.createTextNode(before))
      .append($('<span>').text(targetChar));
    const $span = $m.find('span').last();
    const y = $span[0].offsetTop;
    ta.scrollTop = Math.max(0, y - ta.clientHeight / 2 + LINE_HEIGHT / 2);
  }

  function focusFieldMatch(m) {
    let $el, rawVal;
    if (m.field === 'keys') { $el = $('#wi_keys'); rawVal = $el.val(); }
    else { $el = $('#wi_content'); rawVal = $el.val(); }

    let start = m.start, end = m.end;
    if (m.field === 'keys') {
      const lower = rawVal.toLowerCase();
      const t = state.searchTerm.toLowerCase();
      const pos = lower.indexOf(t);
      if (pos >= 0) { start = pos; end = pos + state.searchTerm.length; }
    }

    const savedScroll = $el.is('textarea') ? $el[0].scrollTop : 0;

    try {
      $el[0].focus({ preventScroll: true });
      $el[0].setSelectionRange(start, end);
      if ($el.is('textarea')) {
        $el[0].scrollTop = savedScroll;
      }
    } catch (e) {
      try { $el[0].focus(); $el[0].setSelectionRange(start, end); } catch (e2) {}
    }
  }

  function buildHighlightedFragment(str, term, useRegex, currentMatch, matchField) {
    const frag = document.createDocumentFragment();
    if (!term) {
      frag.appendChild(document.createTextNode(str));
      return { frag };
    }
    const matches = findMatchesInStr(str, term, useRegex);
    if (matches.length === 0) {
      frag.appendChild(document.createTextNode(str));
      return { frag };
    }

    let last = 0;
    matches.forEach((mm) => {
      if (mm.start > last) frag.appendChild(document.createTextNode(str.slice(last, mm.start)));

      const isCurrent = currentMatch &&
                        currentMatch.field === matchField &&
                        currentMatch.start === mm.start &&
                        currentMatch.end === mm.end;

      const mark = document.createElement('mark');
      if (isCurrent) {
        mark.style.cssText = 'background:#ff8800;color:#000;padding:0 1px;border-radius:2px;font-weight:bold';
        mark.id = 'wi_current_mark_' + matchField;
      } else {
        mark.style.cssText = 'background:#ffcc00;color:#000;padding:0 1px;border-radius:2px';
      }
      mark.textContent = str.slice(mm.start, mm.end);
      frag.appendChild(mark);
      last = mm.end;
    });
    if (last < str.length) frag.appendChild(document.createTextNode(str.slice(last)));
    return { frag };
  }

  function renderPreviewGeneric($prev, str, matchField) {
    const term = state.searchTerm || '';
    const useRegex = state.searchRegex;
    const cur = state.matchCursor >= 0 ? state.matchList[state.matchCursor] : null;

    if (!term || !str) {
      $prev.hide().empty();
      return;
    }
    const { frag } = buildHighlightedFragment(str, term, useRegex, cur, matchField);
    $prev.empty().append(frag);
    $prev.css({ display: 'block', lineHeight: LINE_HEIGHT + 'px' });
  }

  function renderContentPreview() {
    renderPreviewGeneric($('#wi_content_preview'), $('#wi_content').val() || '', 'content');
  }
  function renderKeysPreview() {
    renderPreviewGeneric($('#wi_keys_preview'), $('#wi_keys').val() || '', 'keys');
  }
  function renderAllPreviews() {
    renderKeysPreview();
    renderContentPreview();
  }

  function scrollPreviewToCurrentMatch(field) {
    const map = { content: '#wi_content_preview', keys: '#wi_keys_preview' };
    const $prev = $(map[field]);
    if (!$prev.length || !$prev.is(':visible')) return;

    let markEl = document.getElementById('wi_current_mark_' + field);
    if (!markEl) {
      const allMarks = $prev[0].querySelectorAll('mark');
      for (const m of allMarks) {
        if (m.style.background === 'rgb(255, 136, 0)' || m.style.background.includes('255, 136, 0')) {
          markEl = m;
          break;
        }
      }
    }
    if (!markEl) return;

    const prevContainer = $prev[0];
    if (prevContainer.scrollHeight <= prevContainer.clientHeight) return;

    try {
      const markRect = markEl.getBoundingClientRect();
      const prevRect = prevContainer.getBoundingClientRect();
      const relativeTop = markRect.top - prevRect.top + prevContainer.scrollTop;
      const target = Math.max(0, relativeTop - prevContainer.clientHeight / 2 + markRect.height / 2);
      prevContainer.scrollTop = target;
    } catch (e) {}
  }

  function renderEntryList() {
    const $list = $('#wi_list').empty();
    const term = state.searchTerm || '';

    // ★ 分组视图
    if (state.groupView) {
      renderWbGroupList($list);
      return;
    }

    const hitEntryIdxSet = new Set(state.matchList.map(m => m.entryIdx));
    const totalCount = state.entries.length;
    const curMatch = state.matchCursor >= 0 ? state.matchList[state.matchCursor] : null;
    const isSearching = !!term;

    state.entries.forEach((e, idx) => {
      const title = readTitle(e) || `【无标题#${idx}】`;
      const enabled = readEnabled(e);
      const isSelected = idx === state.selectedIdx;
      const isCurrentMatchEntry = curMatch && curMatch.entryIdx === idx;

      if (term && !hitEntryIdxSet.has(idx)) return;

      const posNum = readPosNum(e);
      const posLabel = posNum === 4 ? '@D' : ['↑C','↓C','↑A','↓A'][posNum];
      const keysLen = (e.strategy?.keys || []).length;
      const charLen = (e.content || '').length;
      const ccColor = charCountColor(charLen);

      const strategyType = e.strategy?.type || 'constant';
      let dotColor, dotShadow;
      if (!enabled) { dotColor = '#555'; dotShadow = 'none'; }
      else if (strategyType === 'constant') { dotColor = '#4a9eff'; dotShadow = '0 0 6px rgba(74,158,255,.6)'; }
      else { dotColor = '#58b600'; dotShadow = '0 0 6px rgba(88,182,0,.6)'; }

      const isChecked = e.uid !== undefined && state.selectedUids.has(e.uid);
      const bg = isCurrentMatchEntry ? 'var(--wi-selected)' : (isChecked ? 'var(--wi-hover)' : (isSelected ? 'var(--wi-selected)' : 'transparent'));
      const leftBar = isCurrentMatchEntry ? 'box-shadow:inset 3px 0 0 #ffcc00;' : '';

      const $item = $(`<div class="wi-list-item" data-idx="${idx}" data-uid="${e.uid ?? ''}" style="padding:8px 10px;cursor:pointer;border-bottom:1px solid var(--wi-border);display:flex;align-items:flex-start;gap:6px;background:${bg};${leftBar}"></div>`);

      if (state.batchMode) {
        const $cb = $('<input type="checkbox">').css({
          flexShrink: 0,
          marginTop: '4px',
          cursor: 'pointer',
        }).prop('checked', isChecked);
        $cb.on('click', (ev) => {
          ev.stopPropagation();
          if (e.uid === undefined) return;
          if ($cb.is(':checked')) state.selectedUids.add(e.uid);
          else state.selectedUids.delete(e.uid);
          $item.css('background', $cb.is(':checked') ? 'var(--wi-hover)' : (isSelected ? 'var(--wi-selected)' : 'transparent'));
          updateBatchCount();
        });
        $item.append($cb);
      }

      const $handle = $('<span title="拖拽排序">☰</span>').css({
        flexShrink: 0,
        cursor: isSearching ? 'not-allowed' : 'grab',
        color: isSearching ? 'var(--wi-fg-dim)' : 'var(--wi-fg-dim)',
        fontSize: '13px',
        paddingTop: '2px',
        userSelect: 'none',
      });

      const $dot = $(`<span style="flex-shrink:0;display:inline-block;width:10px;height:10px;border-radius:50%;background:${dotColor};box-shadow:${dotShadow};margin-top:4px"></span>`);
      const $textWrap = $(`<div style="flex:1;min-width:0"></div>`);

      const $title = $('<div>').css({
        fontSize: '12px',
        color: enabled ? 'var(--wi-fg)' : 'var(--wi-fg-dim)',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }).text(title);
      $textWrap.append($title);

      $textWrap.append(`<div style="font-size:10px;color:var(--wi-fg-dim);margin-top:3px">${posLabel} · k:${keysLen} · o:${readInsertOrder(e)} · d:${readDepthVal(e)} · <span style="color:${ccColor}">${charLen}字</span></div>`);

      $item.append($handle).append($dot).append($textWrap);

      $item.click(async () => {
        await flushAutoSave();
        state.selectedIdx = idx;
        fillFormByEntry(e);
        renderEntryList();
        renderAllPreviews();
      });

      if (!isSearching && !state.batchMode) {
        $item.attr('draggable', 'true');

        $item.on('dragstart', function (ev) {
          state.dragSrcIdx = idx;
          $(this).css('opacity', 0.4);
          if (ev.originalEvent && ev.originalEvent.dataTransfer) {
            ev.originalEvent.dataTransfer.effectAllowed = 'move';
            try { ev.originalEvent.dataTransfer.setData('text/plain', String(idx)); } catch (e) {}
          }
        });

        $item.on('dragend', function () {
          $(this).css('opacity', 1);
          $('.wi-list-item').css({ borderTop: '', borderBottom: '1px solid #333' });
          state.dragSrcIdx = -1;
        });

        $item.on('dragover', function (ev) {
          if (state.dragSrcIdx < 0 || state.dragSrcIdx === idx) return;
          ev.preventDefault();
          if (ev.originalEvent && ev.originalEvent.dataTransfer) {
            ev.originalEvent.dataTransfer.dropEffect = 'move';
          }
          const rect = this.getBoundingClientRect();
          const mouseY = ev.originalEvent ? ev.originalEvent.clientY : 0;
          const isLowerHalf = (mouseY - rect.top) > (rect.height / 2);
          if (isLowerHalf) {
            $(this).css({ borderTop: '', borderBottom: '2px solid #4a9eff' });
          } else {
            $(this).css({ borderTop: '2px solid #4a9eff', borderBottom: '' });
          }
          return false;
        });

        $item.on('dragleave', function () {
          $(this).css({ borderTop: '', borderBottom: '1px solid #333' });
        });

        $item.on('drop', function (ev) {
          if (state.dragSrcIdx < 0) return;
          ev.preventDefault();
          const fromIdx = state.dragSrcIdx;
          const targetIdx = idx;
          if (fromIdx === targetIdx) return;
          const rect = this.getBoundingClientRect();
          const mouseY = ev.originalEvent ? ev.originalEvent.clientY : 0;
          const isLowerHalf = (mouseY - rect.top) > (rect.height / 2);
          let insertIdx = isLowerHalf ? targetIdx + 1 : targetIdx;
          if (fromIdx < insertIdx) insertIdx -= 1;
          reorderEntries(fromIdx, insertIdx);
          return false;
        });
      }

      if (isCurrentMatchEntry) {
        setTimeout(() => {
          $item[0].scrollIntoView({ block: 'nearest' });
        }, 0);
      }

      $list.append($item);
    });

    if (term) {
      $('#wi_search_status').text(`命中 ${hitEntryIdxSet.size} 条 · 共 ${state.matchList.length} 处匹配（总计 ${totalCount} 条）`);
    } else {
      $('#wi_search_status').text(`共 ${totalCount} 条 · 拖拽 ☰ 手柄调整顺序`);
    }

    updateBatchCount();
  }

  async function reorderEntries(fromIdx, toIdx) {
    if (fromIdx === toIdx) return;
    if (fromIdx < 0 || fromIdx >= state.entries.length) return;
    if (toIdx < 0 || toIdx >= state.entries.length) return;
    if (!state.activeBook) return;

    const ctx = SillyTavern.getContext();
    if (!ctx || typeof ctx.loadWorldInfo !== 'function' || typeof ctx.saveWorldInfo !== 'function') {
      alert('酒馆原生 API 不可用，无法保存排序');
      return;
    }

    pushHistory();

    const arr = state.entries;
    const [moved] = arr.splice(fromIdx, 1);
    arr.splice(toIdx, 0, moved);

    const prevSelectedUid = state.selectedIdx >= 0 ? state.entries[state.selectedIdx]?.uid : null;

    renderEntryList();
    renderAllPreviews();
    updateMatchCounter();

    try {
      const native = await ctx.loadWorldInfo(state.activeBook);
      if (!native || !native.entries) {
        alert('读取世界书失败，排序未保存');
        await loadEntries();
        renderEntryList();
        return;
      }

      const nativeByUid = {};
      for (const key in native.entries) {
        const e = native.entries[key];
        nativeByUid[e.uid] = e;
      }

      arr.forEach((e, i) => {
        const uid = e.uid;
        if (nativeByUid[uid]) {
          nativeByUid[uid].displayIndex = i + 1;
        }
      });

      const newEntries = {};
      arr.forEach((e) => {
        const uid = e.uid;
        if (nativeByUid[uid]) {
          newEntries[uid] = nativeByUid[uid];
        }
      });

      await ctx.saveWorldInfo(state.activeBook, { entries: newEntries });

      if (typeof ctx.reloadWorldInfoEditor === 'function') {
        ctx.reloadWorldInfoEditor(state.activeBook, true);
      }

      if (prevSelectedUid !== null) {
        const newIdx = state.entries.findIndex(e => e.uid === prevSelectedUid);
        if (newIdx >= 0) {
          state.selectedIdx = newIdx;
          fillFormByEntry(state.entries[newIdx]);
        }
      }
      renderEntryList();

    } catch (e) {
      console.error('[WI编辑器] 写回失败', e);
      alert('排序写回失败，正在恢复');
      await loadEntries();
      renderEntryList();
      renderAllPreviews();
      updateMatchCounter();
    }
  }

  function fillFormByEntry(entry) {
    $('#wi_name').val(readTitle(entry));
    $('#wi_content').val(readContent(entry));
    $('#wi_keys').val(readKeysStr(entry));
    $('#wi_pos').val(readPosNum(entry));
    $('#wi_depth').val(readDepthVal(entry));
    $('#wi_order').val(readInsertOrder(entry));
    $('#wi_strategy').val(entry.strategy?.type || 'constant');
    $('#wi_enabled').prop('checked', readEnabled(entry));
    // 递归设置
    $('#wi_prevent_outgoing').prop('checked', !!entry.recursion?.prevent_outgoing);
    $('#wi_prevent_incoming').prop('checked', !!entry.recursion?.prevent_incoming);
    updateDepthState();
  }

  function clearForm() {
    $('#wi_name').val('');
    $('#wi_content').val('');
    $('#wi_strategy').val('constant');
    $('#wi_keys').val('');
    $('#wi_pos').val(0);
    $('#wi_depth').val(4);
    $('#wi_order').val(50);
    $('#wi_enabled').prop('checked', true);
    $('#wi_prevent_outgoing').prop('checked', false);
    $('#wi_prevent_incoming').prop('checked', false);
    updateDepthState();
    renderAllPreviews();
  }

  function getFormData() {
    return {
      name: $('#wi_name').val(),
      content: $('#wi_content').val(),
      strategyType: $('#wi_strategy').val(),
      keys: $('#wi_keys').val(),
      posNum: Number($('#wi_pos').val()),
      depth: Number($('#wi_depth').val()),
      order: Number($('#wi_order').val()),
      enabled: $('#wi_enabled').prop('checked'),
      preventOutgoing: $('#wi_prevent_outgoing').prop('checked'),
      preventIncoming: $('#wi_prevent_incoming').prop('checked'),
    };
  }

  let _autoSaveTimer = null;
  async function autoSaveCurrentEntry() {
    if (state.selectedIdx < 0) return;
    const e = state.entries[state.selectedIdx];
    if (!e) return;
    if (!state.activeBook) return;

    const formData = getFormData();
    const hasChanged =
      readTitle(e) !== formData.name ||
      readContent(e) !== formData.content ||
      readKeysStr(e) !== formData.keys ||
      readPosNum(e) !== formData.posNum ||
      readDepthVal(e) !== formData.depth ||
      readInsertOrder(e) !== formData.order ||
      readEnabled(e) !== formData.enabled ||
      (e.strategy?.type || 'constant') !== formData.strategyType ||
      !!e.recursion?.prevent_outgoing !== !!formData.preventOutgoing ||
      !!e.recursion?.prevent_incoming !== !!formData.preventIncoming;

    if (!hasChanged) return;

    pushHistory();
    fillEntry(e, formData);
    await safeSaveWb(state.activeBook, state.entries);
    renderEntryList();
  }

  function scheduleAutoSave() {
    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(() => {
      autoSaveCurrentEntry();
    }, 600);
  }

  function flushAutoSave() {
    if (_autoSaveTimer) {
      clearTimeout(_autoSaveTimer);
      _autoSaveTimer = null;
    }
    return autoSaveCurrentEntry();
  }

  function commitFormToEntry() {
    if (state.selectedIdx < 0) return;
    const e = state.entries[state.selectedIdx];
    if (!e) return;
    fillEntry(e, getFormData());
  }

  async function saveCurrentEntry() {
    if (state.selectedIdx < 0) return alert('请先选择条目');
    pushHistory();
    const entry = state.entries[state.selectedIdx];
    fillEntry(entry, getFormData());
    await safeSaveWb(state.activeBook, state.entries);
    rebuildMatches();
    renderEntryList();
    renderAllPreviews();
    alert('已保存');
  }

  async function newEntry() {
    pushHistory();
    const form = getFormData();
    const posItem = POSITION_MAP.find(x => x.num === form.posNum) || POSITION_MAP[1];
    const newE = {
      uid: Date.now(),
      name: form.name || '新条目',
      content: form.content || '',
      enabled: form.enabled,
      strategy: {
        type: form.strategyType || 'constant',
        keys: form.keys.split(',').map(s => s.trim()).filter(Boolean),
        keys_secondary: { logic: 'and_any', keys: [] },
        scan_depth: 'same_as_global'
      },
      position: {
        type: posItem.str,
        role: 'system',
        depth: form.depth,
        order: form.order
      },
      probability: 100,
      recursion: {
        prevent_incoming: !!form.preventIncoming,
        prevent_outgoing: !!form.preventOutgoing,
        delay_until: null
      },
      effect: { sticky: null, cooldown: null, delay: null },
      addMemo: true,
      group: '',
      groupOverride: false,
      groupWeight: 100,
      useGroupScoring: false,
      automationId: '',
      ignoreBudget: false,
      outletName: '',
      triggers: [],
      characterFilter: { isExclude: false, names: [], tags: [] }
    };
    state.entries.push(newE);
    await safeSaveWb(state.activeBook, state.entries);
    state.selectedIdx = state.entries.length - 1;
    fillFormByEntry(newE);
    rebuildMatches();
    renderEntryList();
    renderAllPreviews();
    alert('新建完成');
  }

  function replaceNthMatch(str, term, replaceWith, n, useRegex) {
    const source = useRegex ? term : term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let re;
    try { re = new RegExp(source, 'gi'); }
    catch (e) { return { result: str, replaced: false }; }

    let count = -1;
    let replaced = false;
    const result = str.replace(re, (match) => {
      count++;
      if (count === n) { replaced = true; return replaceWith; }
      return match;
    });
    return { result, replaced };
  }

  async function doReplaceOne() {
    if (state.matchList.length === 0) { alert('没有可替换的匹配'); return; }
    if (state.matchCursor < 0) { alert('请先用 ▲/▼ 定位到某个匹配'); return; }

    const m = state.matchList[state.matchCursor];
    const e = state.entries[m.entryIdx];
    if (!e) return;

    const replaceWith = $('#wi_replace_input').val() || '';
    const useRegex = state.searchRegex;
    const term = state.searchTerm;

    if (m.entryIdx === state.selectedIdx) {
      commitFormToEntry();
    }

    pushHistory();

    let fieldValue;
    if (m.field === 'keys') fieldValue = (e.strategy?.keys || []).join(', ');
    else fieldValue = e.content || '';

    const fieldMatches = findMatchesInStr(fieldValue, term, useRegex);
    let nth = fieldMatches.findIndex(fm => fm.start === m.start && fm.end === m.end);
    if (nth < 0) nth = 0;

    if (m.field === 'keys') {
      const joined = (e.strategy?.keys || []).join(', ');
      const { result } = replaceNthMatch(joined, term, replaceWith, nth, useRegex);
      e.strategy.keys = result.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      const { result } = replaceNthMatch(e.content || '', term, replaceWith, nth, useRegex);
      e.content = result;
    }

    await safeSaveWb(state.activeBook, state.entries);

    const oldCursor = state.matchCursor;
    rebuildMatches();
    if (state.matchList.length === 0) state.matchCursor = -1;
    else state.matchCursor = Math.min(oldCursor, state.matchList.length - 1);

    fillFormByEntry(e);
    updateMatchCounter();
    renderEntryList();
    renderAllPreviews();

    if (state.matchCursor >= 0) {
      const nm = state.matchList[state.matchCursor];
      state.selectedIdx = nm.entryIdx;
      focusFieldMatch(nm);
      setTimeout(() => scrollPreviewToCurrentMatch(nm.field), 50);
    }
  }

  async function doReplaceAll() {
    const term = $('#wi_search_input').val() || '';
    const replaceWith = $('#wi_replace_input').val() || '';
    const useRegex = $('#wi_search_regex').is(':checked');

    if (!term) { alert('请先在搜索框输入要查找的内容'); return; }

    commitFormToEntry();

    let regex = null;
    if (useRegex) {
      try { regex = new RegExp(term, 'gi'); }
      catch (e) { alert('正则表达式无效：' + e.message); return; }
    }

    const calcReplace = (s) => {
      if (!s) return { result: s, count: 0 };
      if (useRegex && regex) {
        const matches = s.match(regex);
        const count = matches ? matches.length : 0;
        return { result: s.replace(regex, replaceWith), count };
      } else {
        const lowerS = s.toLowerCase();
        const lowerTerm = term.toLowerCase();
        let count = 0, idx = 0, result = '';
        while (true) {
          const pos = lowerS.indexOf(lowerTerm, idx);
          if (pos < 0) { result += s.slice(idx); break; }
          result += s.slice(idx, pos) + replaceWith;
          idx = pos + term.length;
          count++;
        }
        return { result, count };
      }
    };

    let totalReplacements = 0;
    let affectedEntries = 0;
    const plan = [];

    state.entries.forEach((e, idx) => {
      const item = { entryIdx: idx };
      let changed = false;

      const keys = e.strategy?.keys || [];
      const newKeys = [];
      let keysChanged = false;
      for (const k of keys) {
        const r = calcReplace(k);
        if (r.count > 0) { totalReplacements += r.count; keysChanged = true; }
        newKeys.push(r.result);
      }
      if (keysChanged) { item.keys = newKeys; changed = true; }

      const rContent = calcReplace(e.content || '');
      if (rContent.count > 0) { item.content = rContent.result; totalReplacements += rContent.count; changed = true; }

      if (changed) { affectedEntries++; plan.push(item); }
    });

    if (totalReplacements === 0) { alert('没有找到匹配的内容'); return; }

    const ok = confirm(`将在 ${affectedEntries} 条条目中替换 ${totalReplacements} 处。\n\n确定执行？`);
    if (!ok) return;

    pushHistory();

    for (const item of plan) {
      const e = state.entries[item.entryIdx];
      if (item.keys !== undefined) {
        if (!e.strategy) e.strategy = {};
        e.strategy.keys = item.keys;
      }
      if (item.content !== undefined) e.content = item.content;
    }

    await safeSaveWb(state.activeBook, state.entries);

    rebuildMatches();
    renderEntryList();
    if (state.selectedIdx >= 0 && state.entries[state.selectedIdx]) {
      fillFormByEntry(state.entries[state.selectedIdx]);
    }
    updateMatchCounter();
    renderAllPreviews();
    alert(`替换完成：${affectedEntries} 条条目，共 ${totalReplacements} 处`);
  }

  async function deleteEntry() {
    if (state.selectedIdx < 0) return;
    if (!confirm('确定删除此条目？')) return;

    pushHistory();

    state.entries.splice(state.selectedIdx, 1);
    state.selectedIdx = -1;
    clearForm();
    await safeSaveWb(state.activeBook, state.entries);
    rebuildMatches();
    renderEntryList();
    renderAllPreviews();
    alert('已删除');
  }

  buildUI();
})();
