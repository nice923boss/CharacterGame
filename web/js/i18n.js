// UI language (zh / en). New stories are written in the UI language; a loaded story keeps its own language.
// Static text in index.html carries data-i18n (textContent) or data-i18n-ph (placeholder) keys.

const DICT = {
  zh: {
    'app.title': '千枝物語', 'app.subtitle': '每一次選擇，都長出新的枝枒', 'app.credit': '製作者：黃政文',
    'menu.continue': '繼續遊戲', 'menu.new': '新的故事', 'menu.load': '讀取存檔', 'menu.stories': '管理故事', 'menu.settings': '設定',
    'health.checking': '檢查連線中…', 'health.comfy': '繪圖伺服器：{state}', 'health.on': '已連線',
    'health.off': '未連線（無法產生圖片）', 'health.down': '遊戲伺服器未回應', 'health.models': '文字模型（依序備援）：{list}',
    'model.ultra': '輝達 ultra', 'model.qwen': '本機 qwen', 'model.super': '輝達 super',
    'common.back': '返回', 'common.close': '關閉', 'common.ok': '確定', 'common.cancel': '取消', 'common.send': '送出',
    'common.delete': '刪除', 'common.sep': '、', 'common.colon': '：',
    'setup.title': '新的故事', 'setup.world': '世界', 'setup.preset': '預設世界', 'setup.custom': '自訂（清空）',
    'setup.era': '年代', 'setup.place': '地點', 'setup.genre': '類型', 'setup.tone': '基調', 'setup.extra': '補充設定',
    'setup.goal': '結局目標（選填，達成或確定失敗時故事結束；空白則不會結束）',
    'setup.ph.era': '例：1930 年代，蒸汽機與煤氣燈並存', 'setup.ph.place': '例：終年起霧的港口城市',
    'setup.ph.genre': '懸疑冒險', 'setup.ph.tone': '神祕、帶點溫情', 'setup.ph.goal': '例：查出鐘錶停擺的真相，讓霧港恢復運轉',
    'setup.hero': '主角（你）', 'setup.name': '名字', 'setup.profile': '簡介', 'setup.chars': '角色', 'setup.add': '＋ 新增角色',
    'setup.lang': '故事語言：繁體中文（在標題畫面切換）',
    'setup.hint': '外觀寫得越具體，立繪越穩定。白色衣服或白髮也沒問題。', 'setup.start': '開始故事',
    'setup.remove': '移除', 'setup.charN': '角色 {n}',
    'char.name': '名字', 'char.appearance': '外觀（年齡、髮型髮色、瞳色、服裝顏色、配件）', 'char.personality': '個性',
    'char.speech': '說話方式', 'char.relationship': '與主角的關係',
    'setup.needWorld': '請至少填寫年代與地點', 'setup.needChar': '至少需要 1 位角色',
    'setup.building': '正在建立世界', 'setup.buildingSub': 'AI 正在把你的設定轉成美術描述，通常 10 到 30 秒',
    'setup.done': '世界建立完成（{s} 秒）', 'setup.presetFail': '讀取預設世界失敗：{msg}',
    'phase.setup_art': '正在把設定轉成美術描述', 'phase.repair_json': '補齊選項中',
    'game.save': '存檔', 'game.load': '讀檔', 'game.tree': '節點樹', 'game.settings': '設定', 'game.title': '標題',
    'game.freePh': '或自己寫下你的行動或台詞（{n} 字內）',
    'game.toTitle': '回到標題畫面？進度已自動存在最新一輪。', 'game.toTitleOk': '回到標題',
    'game.writing': 'AI 撰寫中（{s} 秒）', 'game.reset': '回應中斷，重新生成這一輪',
    'game.replayed': '這條路走過了，直接重播已有的劇情', 'game.cancelled': '已取消，回到送出前', 'game.taken': '（已走過）',
    'game.loading': '讀取中',
    'chip.sceneError': '場景圖生成失敗，暫用前一張', 'chip.sceneRunning': '場景繪製中',
    'chip.sceneQueued': '場景排隊中（前面 {n} 張）', 'chip.sprites': '立繪準備中 {ready} / {all}（缺的表情先用平靜）',
    'ending.good': '好結局', 'ending.bad': '壞結局', 'ending.hint': '可以從節點樹回到任一輪，改走別的結局。',
    'ending.toTitle': '回到標題',
    'slots.save': '存檔', 'slots.load': '讀取存檔', 'slots.empty': '空', 'slots.del': '刪',
    'slots.delAsk': '刪除第 {n} 格存檔？（遊戲本身與節點樹不受影響）', 'slots.overwrite': '覆蓋第 {n} 格「{label}」？',
    'slots.overwriteOk': '覆蓋', 'slots.saved': '已存到第 {n} 格', 'slots.label': '{title}・{scene}・第 {turn} 輪',
    'slots.auto': '自動存檔：{title}', 'slots.autoNote': '（每輪結束自動更新）',
    'tree.title': '節點樹', 'tree.hint': '點任一節點可回到那一輪，從那裡改選；原本的分支會保留。',
    'tree.empty': '還沒有任何節點', 'tree.turn': '第 {n} 輪・{scene}', 'tree.you': '你：{text}', 'tree.opening': '（開場）',
    'tree.jump': '回到第 {n} 輪（{scene}）？\n之後可以選不同的答案，原本的分支會保留在樹上。', 'tree.jumpOk': '回到這裡',
    'settings.title': '設定', 'settings.speed': '文字速度', 'settings.bgm': '音樂音量', 'settings.sfx': '音效音量',
    'settings.weather': '顯示天氣粒子',
    'stories.title': '管理故事', 'stories.hint': '刪除故事會連同節點樹、所有分支、圖片，以及指向它的存檔一起刪除。',
    'stories.none': '還沒有任何故事。', 'stories.meta': '角色：{chars}・{nodes} 個節點', 'stories.noChars': '無',
    'stories.created': '建立於 {date}', 'stories.usedBy': '・被{used}使用', 'stories.slots': '{n} 格存檔',
    'stories.auto': '自動存檔', 'stories.open': '開啟', 'stories.lang.zh': '中文', 'stories.lang.en': '英文',
    'stories.delAsk': '永久刪除「{title}」？節點樹、所有分支與圖片都會刪除{used}，無法復原。',
    'stories.delUsed': '，{used}也會一併清除', 'stories.deleted': '已刪除「{title}」',
    'setup.mode': '生成方式', 'setup.mode.live': '邊玩邊寫', 'setup.mode.batch': '批次預先寫完整棵樹',
    'setup.b.options': '每輪選項', 'setup.b.turns': '輪數',
    'setup.b.est': '共 {nodes} 個節點，文字約 {text} 分鐘、圖片約 {img} 分鐘（同時進行）。寫完後點選項不必等待，自由輸入仍即時生成。結局目標必填。',
    'setup.b.over': '共 {nodes} 個節點，超過上限 {max}，請減少選項數或輪數',
    'batch.started': '「{title}」開始批次生成，完成時會通知你（請保持這個頁面開啟）',
    'batch.panel': '批次生成', 'batch.row': '劇情 {nodes}/{planned}・圖片 {images}/{total}',
    'batch.state.running': '寫劇情中', 'batch.state.images': '繪圖中', 'batch.state.done': '已完成',
    'batch.state.cancelled': '已停止', 'batch.state.error': '失敗',
    'batch.doneTitle': '劇情樹完成', 'batch.doneBody': '「{title}」{nodes} 個節點已寫好',
    'batch.doneAsk': '「{title}」的完整劇情樹已寫好（{nodes} 個節點）。點選項都能直接播放，只有自由輸入會即時生成。{notes}現在開始遊玩？',
    'batch.failedNote': '有 {n} 條分支沒寫成，走到那裡時會即時生成。', 'batch.imgNote': '有 {n} 張圖片沒畫成，會在遊玩時重試。',
    'batch.play': '開始遊玩', 'batch.failed': '「{title}」批次生成失敗：{msg}',
    'stories.batch': '批次：{state}・{row}', 'stories.cancelBatch': '停止批次', 'stories.resumeBatch': '繼續批次',
    'stories.batchStopped': '已停止「{title}」的批次生成', 'stories.batchResumed': '「{title}」繼續批次生成',
    'status.retry': '{model}：{reason}，第 {attempt}/{max} 次重試，{remaining} 秒後再試',
    'status.switch': '{from}{reason}，改用{to}', 'status.rpm': '請求太密集，{remaining} 秒後繼續（{model}）',
    'reason.transient': '伺服器忙碌', 'reason.connect': '連不上伺服器', 'reason.empty': '收到空白回應',
    'reason.timeout': '等太久沒有回應', 'reason.truncated': '回應中途斷線', 'reason.fatal': '請求被拒絕',
    'err.http': '伺服器回應 {status}', 'err.cancelled': '已取消', 'err.offline': '連不上遊戲伺服器，請確認伺服器還在執行',
    'err.dropped': '連線中斷，這一輪沒有完成', 'err.internal': '伺服器內部錯誤，詳情已寫入 logs/server.log',
    'err.game_not_found': '找不到這局遊戲', 'err.delete_failed': '刪除失敗，可能有檔案正被其他程式開啟，請稍後再試',
    'err.save_failed': '存檔失敗，這個節點可能已不存在', 'err.required': '請填寫{field}', 'err.too_long': '{field}最多 {limit} 字',
    'err.char_count': '角色需要 1 到 {max} 位', 'err.dup_names': '角色與主角的名字不可重複，也不可叫「{narrator}」',
    'err.setup_unusable': 'AI 沒有給出可用的美術描述，請再按一次開始', 'err.already_started': '這局已經開始了，請從節點繼續',
    'err.node_not_found': '找不到這個節點', 'err.bad_input_kind': '未知的行動類型',
    'err.batch_size': '批次樹最多 {max} 個節點，請減少選項數或輪數', 'err.batch_goal': '批次模式需要填寫結局目標',
    'err.not_batch': '這個故事不是批次模式',
    'err.branch_ended': '這條路線已經到結局了，可以從節點樹回到之前的輪次改走別的路',
    'err.no_lines': 'AI 這次沒有寫出台詞，請再送出一次', 'err.all_failed': '所有模型都暫時無法回應（{list}）',
    'field.era': '年代', 'field.place': '地點', 'field.genre': '類型', 'field.tone': '基調', 'field.extra': '補充設定',
    'field.goal': '結局目標', 'field.hero_name': '主角名字', 'field.hero_profile': '主角簡介', 'field.action': '行動',
    'field.char_name': '角色 {i} 名字', 'field.char_appearance': '角色 {i} 外觀', 'field.char_personality': '角色 {i} 個性',
    'field.char_speech': '角色 {i} 說話方式', 'field.char_relationship': '角色 {i} 與主角關係',
  },
  en: {
    'app.title': 'Thousand Branches', 'app.subtitle': 'Every choice grows a new branch', 'app.credit': 'Made by 黃政文',
    'menu.continue': 'Continue', 'menu.new': 'New Story', 'menu.load': 'Load', 'menu.stories': 'Manage Stories', 'menu.settings': 'Settings',
    'health.checking': 'Checking connection…', 'health.comfy': 'Image server: {state}', 'health.on': 'connected',
    'health.off': 'offline (no images can be drawn)', 'health.down': 'The game server is not responding',
    'health.models': 'Text models (in fallback order): {list}',
    'model.ultra': 'NVIDIA ultra', 'model.qwen': 'local qwen', 'model.super': 'NVIDIA super',
    'common.back': 'Back', 'common.close': 'Close', 'common.ok': 'OK', 'common.cancel': 'Cancel', 'common.send': 'Send',
    'common.delete': 'Delete', 'common.sep': ', ', 'common.colon': ': ',
    'setup.title': 'New Story', 'setup.world': 'World', 'setup.preset': 'Preset world', 'setup.custom': 'Custom (clear)',
    'setup.era': 'Era', 'setup.place': 'Place', 'setup.genre': 'Genre', 'setup.tone': 'Tone', 'setup.extra': 'Extra notes',
    'setup.goal': 'Ending goal (optional; the story ends when it is reached or clearly lost; leave empty for an endless story)',
    'setup.ph.era': 'e.g. the 1930s, steam engines and gas lamps', 'setup.ph.place': 'e.g. a harbor city lost in fog',
    'setup.ph.genre': 'mystery adventure', 'setup.ph.tone': 'mysterious, a little warm',
    'setup.ph.goal': 'e.g. find out why the clocks stopped and get the harbor running again',
    'setup.hero': 'Protagonist (you)', 'setup.name': 'Name', 'setup.profile': 'Profile', 'setup.chars': 'Characters',
    'setup.add': '+ Add character', 'setup.lang': 'Story language: English (change it on the title screen)',
    'setup.hint': 'The more specific the looks, the steadier the portraits. White clothes or white hair are fine.',
    'setup.start': 'Start Story', 'setup.remove': 'Remove', 'setup.charN': 'Character {n}',
    'char.name': 'Name', 'char.appearance': 'Looks (age, hair style and color, eye color, clothing colors, accessories)',
    'char.personality': 'Personality', 'char.speech': 'Way of speaking', 'char.relationship': 'Relationship to you',
    'setup.needWorld': 'Please fill in at least the era and the place', 'setup.needChar': 'At least 1 character is needed',
    'setup.building': 'Building the world', 'setup.buildingSub': 'The AI is turning your setting into art directions, usually 10 to 30 seconds',
    'setup.done': 'World ready ({s} s)', 'setup.presetFail': 'Could not load the preset worlds: {msg}',
    'phase.setup_art': 'Turning the setting into art directions', 'phase.repair_json': 'Filling in the options',
    'game.save': 'Save', 'game.load': 'Load', 'game.tree': 'Tree', 'game.settings': 'Settings', 'game.title': 'Title',
    'game.freePh': 'Or write your own action or line (up to {n} characters)',
    'game.toTitle': 'Back to the title screen? Your progress is saved automatically at the latest turn.',
    'game.toTitleOk': 'Back to title',
    'game.writing': 'AI is writing ({s} s)', 'game.reset': 'The reply broke off; writing this turn again',
    'game.replayed': 'You have been down this path; replaying the stored turn', 'game.cancelled': 'Cancelled; back to before you sent it',
    'game.taken': ' (taken before)', 'game.loading': 'Loading',
    'chip.sceneError': 'Scene image failed; showing the previous one', 'chip.sceneRunning': 'Drawing the scene',
    'chip.sceneQueued': 'Scene queued ({n} ahead)', 'chip.sprites': 'Portraits {ready} / {all} ready (calm shown until the rest arrive)',
    'ending.good': 'Good Ending', 'ending.bad': 'Bad Ending',
    'ending.hint': 'Go back to any turn from the tree and try for another ending.', 'ending.toTitle': 'Back to title',
    'slots.save': 'Save', 'slots.load': 'Load', 'slots.empty': 'Empty', 'slots.del': 'Del',
    'slots.delAsk': 'Delete save slot {n}? (The story and its tree stay.)', 'slots.overwrite': 'Overwrite slot {n} "{label}"?',
    'slots.overwriteOk': 'Overwrite', 'slots.saved': 'Saved to slot {n}', 'slots.label': '{title} · {scene} · Turn {turn}',
    'slots.auto': 'Autosave: {title}', 'slots.autoNote': ' (updated after every turn)',
    'tree.title': 'Story Tree', 'tree.hint': 'Click any node to go back to that turn and choose again; the old branch stays.',
    'tree.empty': 'No nodes yet', 'tree.turn': 'Turn {n} · {scene}', 'tree.you': 'You: {text}', 'tree.opening': '(opening)',
    'tree.jump': 'Go back to turn {n} ({scene})?\nYou can choose differently from there; the old branch stays on the tree.',
    'tree.jumpOk': 'Go there',
    'settings.title': 'Settings', 'settings.speed': 'Text speed', 'settings.bgm': 'Music volume', 'settings.sfx': 'Sound volume',
    'settings.weather': 'Show weather particles',
    'stories.title': 'Manage Stories', 'stories.hint': 'Deleting a story also deletes its tree, every branch, its images and the saves that point to it.',
    'stories.none': 'No stories yet.', 'stories.meta': 'Characters: {chars} · {nodes} nodes', 'stories.noChars': 'none',
    'stories.created': 'Created {date}', 'stories.usedBy': ' · used by {used}', 'stories.slots': '{n} save slot(s)',
    'stories.auto': 'the autosave', 'stories.open': 'Open', 'stories.lang.zh': 'Chinese', 'stories.lang.en': 'English',
    'stories.delAsk': 'Delete "{title}" for good? Its tree, every branch and all images will be deleted{used}. This cannot be undone.',
    'stories.delUsed': ', and {used} will be cleared too', 'stories.deleted': 'Deleted "{title}"',
    'setup.mode': 'Generation', 'setup.mode.live': 'Write as you play', 'setup.mode.batch': 'Batch: write the whole tree first',
    'setup.b.options': 'Options per turn', 'setup.b.turns': 'Turns',
    'setup.b.est': '{nodes} nodes in total: text about {text} min, images about {img} min (at the same time). Afterwards options play with no wait; free input is still written live. An ending goal is required.',
    'setup.b.over': '{nodes} nodes in total, over the limit of {max}; use fewer options or turns',
    'batch.started': 'Batch writing of "{title}" has started; you will be notified when it is done (keep this page open)',
    'batch.panel': 'Batch writing', 'batch.row': 'story {nodes}/{planned} · images {images}/{total}',
    'batch.state.running': 'writing', 'batch.state.images': 'drawing', 'batch.state.done': 'done',
    'batch.state.cancelled': 'stopped', 'batch.state.error': 'failed',
    'batch.doneTitle': 'Story tree ready', 'batch.doneBody': '"{title}": {nodes} nodes written',
    'batch.doneAsk': 'The whole story tree of "{title}" is written ({nodes} nodes). Every option plays at once; only free input is written live. {notes}Play now?',
    'batch.failedNote': '{n} branch(es) could not be written and will be written live when you reach them. ',
    'batch.imgNote': '{n} image(s) failed and will be retried while you play. ',
    'batch.play': 'Play', 'batch.failed': 'Batch writing of "{title}" failed: {msg}',
    'stories.batch': 'Batch: {state} · {row}', 'stories.cancelBatch': 'Stop batch', 'stories.resumeBatch': 'Resume batch',
    'stories.batchStopped': 'Stopped the batch of "{title}"', 'stories.batchResumed': 'Resumed the batch of "{title}"',
    'status.retry': '{model}: {reason}, retry {attempt}/{max} in {remaining} s',
    'status.switch': '{from}: {reason}, switching to {to}', 'status.rpm': 'Too many requests, continuing in {remaining} s ({model})',
    'reason.transient': 'server busy', 'reason.connect': 'cannot reach the server', 'reason.empty': 'empty reply',
    'reason.timeout': 'no reply for too long', 'reason.truncated': 'reply cut off', 'reason.fatal': 'request refused',
    'err.http': 'Server replied {status}', 'err.cancelled': 'Cancelled', 'err.offline': 'Cannot reach the game server; please check that it is still running',
    'err.dropped': 'The connection dropped; this turn did not finish', 'err.internal': 'Internal server error; details are in logs/server.log',
    'err.game_not_found': 'This story was not found', 'err.delete_failed': 'Delete failed; a file may be open in another program, please try again later',
    'err.save_failed': 'Save failed; this node may no longer exist', 'err.required': 'Please fill in {field}',
    'err.too_long': '{field} can be at most {limit} characters', 'err.char_count': 'You need 1 to {max} characters',
    'err.dup_names': 'Characters and the protagonist need different names, and none may be called "{narrator}"',
    'err.setup_unusable': 'The AI gave no usable art directions; please press start again',
    'err.already_started': 'This story has already started; continue from a node', 'err.node_not_found': 'This node was not found',
    'err.batch_size': 'A batch tree can have at most {max} nodes; use fewer options or turns',
    'err.batch_goal': 'Batch mode needs an ending goal', 'err.not_batch': 'This story is not in batch mode',
    'err.bad_input_kind': 'Unknown action type', 'err.branch_ended': 'This route has reached an ending; go back to an earlier turn from the tree to take another path',
    'err.no_lines': 'The AI wrote no lines this time; please send again', 'err.all_failed': 'No model can answer right now ({list})',
    'field.era': 'the era', 'field.place': 'the place', 'field.genre': 'the genre', 'field.tone': 'the tone',
    'field.extra': 'the extra notes', 'field.goal': 'the ending goal', 'field.hero_name': "the protagonist's name",
    'field.hero_profile': "the protagonist's profile", 'field.action': 'your action',
    'field.char_name': "character {i}'s name", 'field.char_appearance': "character {i}'s looks",
    'field.char_personality': "character {i}'s personality", 'field.char_speech': "character {i}'s way of speaking",
    'field.char_relationship': "character {i}'s relationship",
  },
};

export const LANGS = ['zh', 'en'];
// Must match LIMIT_SCALE in server/turn_service.py
export const LIMIT_SCALE = { zh: 1, en: 2 };
const KEY = 'chienzhi.lang';

function initial() {
  try { const v = localStorage.getItem(KEY); if (LANGS.includes(v)) return v; } catch { /* storage blocked */ }
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export let lang = initial();

export function t(key, params = {}) {
  const s = DICT[lang][key] ?? DICT.zh[key] ?? key;
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? params[k] : m));
}

// Player-facing text for an error code from the server (TurnError, LLMError, HTTP detail)
export function errorText(code, params = {}) {
  const p = { ...params };
  if (p.field) p.field = t(`field.${p.field}`, p);
  if (code === 'all_failed') {
    p.list = (p.errors || []).map((e) => `${t(`model.${e.model}`)}${t('common.colon')}${t(`reason.${e.reason}`)}`)
      .join(lang === 'zh' ? '；' : '; ');
  }
  return DICT[lang][`err.${code}`] ? t(`err.${code}`, p) : String(code);
}

// maxlength follows the story language: English needs about twice the characters
export function scaleMaxLength(root, storyLang) {
  root.querySelectorAll('[maxlength]').forEach((el) => {
    el.dataset.max ||= el.getAttribute('maxlength');
    el.maxLength = Number(el.dataset.max) * LIMIT_SCALE[storyLang];
  });
}

export function applyStatic() {
  document.documentElement.lang = lang === 'zh' ? 'zh-Hant' : 'en';
  document.title = t('app.title');
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  document.querySelectorAll('[data-lang]').forEach((b) => b.classList.toggle('on', b.dataset.lang === lang));
}

export function setLang(value) {
  if (!LANGS.includes(value)) return;
  lang = value;
  try { localStorage.setItem(KEY, value); } catch { /* keep in memory */ }
  applyStatic();
}
