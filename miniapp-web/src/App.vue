<script setup>
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
const AdminReviewPanel = defineAsyncComponent(() => import('./components/AdminReviewPanel.vue'));
const HealthStatusPanel = defineAsyncComponent(() => import('./components/HealthStatusPanel.vue'));
const ModelStatusBar = defineAsyncComponent(() => import('./components/ModelStatusBar.vue'));
const ModelRoutingPanel = defineAsyncComponent(() => import('./components/ModelRoutingPanel.vue'));
const StickerKbPanel = defineAsyncComponent(() => import('./components/StickerKbPanel.vue'));
import { normalizeGroupIdInput } from './lib/permissions';

const API_URL = '/miniapp_api';
const tg = window.Telegram?.WebApp ?? null;

/** 静默轮询间隔：列表与「我的申请」在后台自动对齐服务端 */
const AUTO_REFRESH_INTERVAL_MS = 45_000;

const activeTab = ref('apply');
const revealStep = ref(1); // header visible immediately

let autoRefreshTimer = null;
let silentRefreshInFlight = false;

const errorMessages = {
  invalid_init_data: '登录状态失效，请回到 Telegram 后重新打开。',
  managed_allowlist_disabled: '名单审核未开启，暂无法提交。',
  invalid_chat_id: '群编号格式不对，请填数字（可只填 10 位后缀，也可填完整的 -100… 形式）。',
  chat_id_must_not_be_bot_id: '不能填机器人的数字 ID。请填群的 chat_id（在群里打开本 Mini App 可自动带上，或从群资料里查看）。',
  missing_chat_id: '没有拿到群编号，请手动填写目标群的 chat_id。',
  submitter_not_admin: '提交失败：只有群管理员或群主才能申请。',
  bot_not_in_group: 'Bot 不在目标群里，请先把机器人拉进群里再重试。',
  telegram_unavailable: '暂时无法向 Telegram 校验群成员状态，请稍后再试。',
  redis_unavailable: '服务暂时不可用，请稍后再试。',
  redis_error: '服务正在忙，请稍后再试。',
  rate_limited: '提交过于频繁，请稍后再试。',
  already_registered: '这个群已经通过审核，无需重复提交。',
  already_pending: '这个群已有待审核申请，请等待处理。',
  save_failed: '保存申请失败，请稍后再试。',
  missing_request_id: '缺少请求编号，请刷新后重试。',
  ai_failed: 'AI 审核暂时失败，请稍后再试。',
  ai_unparseable: 'AI 审核返回异常，请改为人工处理。',
  forbidden: '你没有权限执行这个操作。',
  request_failed: '请求失败，请稍后再试。',
  http_500: '服务器内部错误，请稍后再试或联系维护者。',
  http_502: '网关错误，请稍后再试。',
  http_503: '服务暂时不可用，请稍后再试。',
  unknown_action: '页面需要刷新，请关闭后重新打开。',
  invalid_provider_label: 'Provider 标签不合法，请使用字母数字和下划线/中划线。',
  missing_provider_fields: 'Provider 信息不完整，请补全 label/endpoint/model。',
  missing_provider_secret: '该 Provider 缺少密钥，请填写 API Key。',
  provider_unavailable: 'Provider 验证失败，请检查 endpoint/key/model 是否可用。',
  invalid_reply_main: '主模型未设置或不存在，请重新选择。',
  invalid_reply_backups: '备用模型包含无效项，请检查后重试。',
  invalid_allowlist_review_label: 'AI 审核模型无效，请重新选择。',
};

const state = reactive({
  loading: true,
  boot: null,
  mySubmissions: null,
  submitBusy: false,
  adminBusyKey: '',
  modelRoutingBusy: false,
  providerValidationResult: null,
  health: null,
  healthError: '',
  submitMessage: '',
  submitTone: 'info',
  adminMessage: '',
  adminTone: 'info',
  loadError: '',
});

const form = reactive({
  chatId: '',
  note: '',
});

const isMaster = computed(() => Boolean(state.boot?.is_master));
const managedEnabled = computed(() => Boolean(state.boot?.managed_enabled));
const manualQueue = computed(() => state.boot?.manual_queue ?? state.boot?.pending ?? []);
const aiApproved = computed(() => state.boot?.ai_approved ?? groups.value.filter((g) => g.review_state === 'auto_approved'));
const groups = computed(() => state.boot?.groups ?? []);
const modelRouting = computed(() => state.boot?.model_routing ?? null);
const suggestedChatId = computed(() => state.boot?.suggested_chat_id ?? '');
const suggestedChatTitle = computed(() => state.boot?.suggested_chat_title ?? '');

const isDirty = computed(() => {
  const note = String(form.note ?? '').trim();
  return normalizeGroupIdInput(form.chatId) !== '' || note !== '';
});

const chatIdHint = computed(() => {
  const raw = normalizeGroupIdInput(form.chatId);
  if (raw === '') return '';
  if (!/^-?\d+$/.test(raw)) {
    return '群编号只能包含数字（首位可为负号，如 -100…）。';
  }
  const digits = raw.replace(/^-/, '');
  if (digits.length < 5) {
    return '群编号过短，请填写完整的数字 ID。';
  }
  return '';
});

const mySubmissionRows = computed(() => {
  const m = state.mySubmissions;
  if (!m || isMaster.value) return [];
  const rows = [];
  for (const p of m.pending ?? []) {
    rows.push({ kind: 'pending', item: p, ts: (p.updated_at ?? p.created_at ?? 0) });
  }
  for (const r of m.reviewed ?? []) {
    rows.push({ kind: 'reviewed', item: r, ts: (r.updated_at ?? r.created_at ?? 0) });
  }
  for (const g of m.groups ?? []) {
    rows.push({ kind: 'group', item: g, ts: (g.updated_at ?? g.approved_at ?? 0) });
  }
  rows.sort((a, b) => b.ts - a.ts);
  return rows;
});

const canSubmit = computed(() => {
  if (state.submitBusy || !managedEnabled.value) return false;
  const norm = normalizeGroupIdInput(form.chatId);
  return norm !== '' && /^-?\d+$/.test(norm);
});

function haptic(type = 'impact', style = 'light') {
  try {
    if (type === 'impact') tg?.HapticFeedback?.impactOccurred?.(style);
    else if (type === 'notification') tg?.HapticFeedback?.notificationOccurred?.(style);
    else if (type === 'selection') tg?.HapticFeedback?.selectionChanged?.();
  } catch { /* ignore */ }
}

function applyThemeColors() {
  try {
    tg?.setHeaderColor?.('secondary_bg_color');
    tg?.setBackgroundColor?.('secondary_bg_color');
  } catch { /* ignore */ }
}

function setupTelegram() {
  tg?.ready?.();
  tg?.expand?.();
  applyThemeColors();
}

function onThemeChanged() {
  applyThemeColors();
}

function applySuggestedChatFromClient() {
  if (normalizeGroupIdInput(form.chatId)) return;

  const unsafeChat = tg?.initDataUnsafe?.chat;
  if (unsafeChat != null && unsafeChat.id != null) {
    const id = Number(unsafeChat.id);
    if (Number.isFinite(id) && id < 0) {
      form.chatId = String(id);
      return;
    }
  }

  const raw = tg?.initData;
  if (typeof raw !== 'string' || raw.length === 0) return;

  try {
    const params = new URLSearchParams(raw);
    const encoded = params.get('chat');
    if (!encoded) return;
    const obj = JSON.parse(encoded);
    const id = obj?.id;
    if (id != null && Number(id) < 0) form.chatId = String(id);
  } catch { /* ignore */ }
}

function parseError(data, httpStatus = 0) {
  let code = typeof data?.error === 'string' ? data.error : '';
  if (!code && httpStatus >= 400) code = `http_${httpStatus}`;
  if (!code) code = 'request_failed';
  const decision = typeof data?.decision === 'string' ? data.decision : '';
  return {
    code,
    decision,
    http_code: Number(data?.http_code || httpStatus || 0),
    latency_ms: Number(data?.latency_ms || 0),
    detail: typeof data?.detail === 'string' ? data.detail : '',
  };
}

function mapDecision(decision) {
  if (decision === 'APPROVE') return 'AI 建议通过。';
  if (decision === 'REJECT') return 'AI 建议拒绝。';
  return decision ? `AI 返回：${decision}` : '';
}

function mapError(error) {
  if (typeof error === 'string') return errorMessages[error] ?? error;
  const code = typeof error?.code === 'string' ? error.code : 'request_failed';
  const fallback = errorMessages[code] ?? code;
  const decision = mapDecision(error?.decision ?? '');
  return decision ? `${fallback} ${decision}` : fallback;
}

async function request(action, payload = {}) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      init_data: tg?.initData ?? '',
      ...payload,
    }),
  });

  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok || !data?.ok) throw parseError(data, response.status);
  return data;
}

async function loadMySubmissions() {
  if (isMaster.value) return;
  try {
    const data = await request('my_submissions');
    state.mySubmissions = data;
  } catch {
    state.mySubmissions = { pending: [], reviewed: [], groups: [] };
  }
}

async function mergeBootstrapData(data) {
  state.boot = data;
  applySuggestedChatFromClient();
  if (!normalizeGroupIdInput(form.chatId) && data.suggested_chat_id != null && data.suggested_chat_id !== '') {
    form.chatId = String(data.suggested_chat_id);
  }
  if (data.is_master) {
    state.mySubmissions = null;
  } else if (data.my_submissions && typeof data.my_submissions === 'object') {
    state.mySubmissions = data.my_submissions;
  } else {
    await loadMySubmissions();
  }
}

async function pullBootstrapAndMerge() {
  const data = await request('bootstrap');
  await mergeBootstrapData(data);
}

async function loadHealth() {
  try {
    const response = await fetch('/miniapp_api/health');
    if (!response.ok) throw new Error('health_unavailable');
    state.health = await response.json();
    state.healthError = '';
  } catch {
    state.healthError = '无法加载运行状态';
  }
}

function canSilentAutoRefresh() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  if (state.loading || state.submitBusy || state.adminBusyKey) return false;
  if (!state.boot) return false;
  return true;
}

async function silentRefreshBootstrap() {
  if (!canSilentAutoRefresh() || silentRefreshInFlight) return;
  silentRefreshInFlight = true;
  try {
    await pullBootstrapAndMerge();
    if (isMaster.value) await loadHealth();
    cloudSet(CACHE_KEY, state.boot);
    if (state.loadError) state.loadError = '';
  } catch {
    /* 保留当前界面，不打断用户 */
  } finally {
    silentRefreshInFlight = false;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = window.setInterval(() => {
    silentRefreshBootstrap();
  }, AUTO_REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (autoRefreshTimer != null) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function onVisibilityChange() {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    silentRefreshBootstrap();
  }
}


// ===== Telegram CloudStorage Cache =====
const CACHE_KEY = 'boot_cache';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

function cloudGet(key) {
  return new Promise((resolve) => {
    try {
      tg?.CloudStorage?.getItem?.(key, (err, val) => {
        if (err || !val) return resolve(null);
        try {
          const obj = JSON.parse(val);
          if (obj._ts && Date.now() - obj._ts < CACHE_TTL_MS) {
            resolve(obj.data);
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
      // Fallback timeout in case callback never fires
      setTimeout(() => resolve(null), 200);
    } catch { resolve(null); }
  });
}

function cloudSet(key, data) {
  try {
    tg?.CloudStorage?.setItem?.(key, JSON.stringify({ _ts: Date.now(), data }));
  } catch { /* ignore */ }
}

async function loadBootstrap() {
  state.loading = true;
  state.loadError = '';

  // 1. Try cached data first for instant render
  const cached = await cloudGet(CACHE_KEY);
  if (cached) {
    await mergeBootstrapData(cached);
    state.loading = false;
    revealStep.value = 2;
    requestAnimationFrame(() => { revealStep.value = 3; });
    setTimeout(() => { revealStep.value = 4; }, 80);

    // 2. Refresh in background (silent)
    pullBootstrapAndMerge()
      .then(async () => {
        if (isMaster.value) await loadHealth();
        cloudSet(CACHE_KEY, state.boot);
      })
      .catch(() => {});
    return;
  }

  // 3. No cache: normal load
  try {
    await pullBootstrapAndMerge();
    if (isMaster.value) await loadHealth();
    cloudSet(CACHE_KEY, state.boot);
  } catch (error) {
    state.loadError = mapError(error);
  } finally {
    state.loading = false;
    revealStep.value = 2;
    requestAnimationFrame(() => { revealStep.value = 3; });
    setTimeout(() => { revealStep.value = 4; }, 80);
  }
}

async function submitApplication() {
  state.submitBusy = true;
  state.submitMessage = '';
  applySuggestedChatFromClient();

  const payload = { note: form.note };
  const norm = normalizeGroupIdInput(form.chatId);
  if (norm !== '') {
    if (!/^-?\d+$/.test(norm)) {
      state.submitTone = 'danger';
      state.submitMessage = errorMessages.invalid_chat_id;
      state.submitBusy = false;
      haptic('notification', 'error');
      return;
    }
    payload.chat_id = norm;
  }

  haptic('impact', 'medium');
  try {
    await request('submit', payload);
    form.note = '';
    state.submitTone = 'success';
    state.submitMessage = '已提交，可在后台查看。';
    haptic('notification', 'success');
    if (tg?.showPopup) {
      tg.showPopup({ title: '提交成功', message: '申请已提交，请等待审核。', buttons: [{ type: 'ok' }] });
    }
    if (!isMaster.value) {
      try {
        await pullBootstrapAndMerge();
      } catch {
        await loadMySubmissions();
      }
    }
  } catch (error) {
    state.submitTone = 'danger';
    state.submitMessage = mapError(error);
    haptic('notification', 'error');
  } finally {
    state.submitBusy = false;
    updateMainButton();
  }
}

function updateMainButton() {
  if (!tg?.MainButton) return;
  if (canSubmit.value) {
    tg.MainButton.setText(state.submitBusy ? '提交中…' : '提交申请');
    tg.MainButton.show();
    if (state.submitBusy) {
      tg.MainButton.showProgress();
      tg.MainButton.disable();
    } else {
      tg.MainButton.hideProgress();
      tg.MainButton.enable();
    }
  } else {
    tg.MainButton.hide();
  }
}

function onMainButtonClick() {
  if (canSubmit.value && !state.submitBusy) submitApplication();
}

async function runAdminAction(key, action, payload, successMessage) {
  state.adminBusyKey = key;
  state.adminMessage = '';
  haptic('impact', 'medium');
  try {
    const result = await request(action, payload);
    await pullBootstrapAndMerge();
    state.adminTone = 'success';
    state.adminMessage = successMessage + (result.decision ? ` ${mapDecision(result.decision)}` : '');
    haptic('notification', 'success');
  } catch (error) {
    state.adminTone = 'danger';
    state.adminMessage = mapError(error);
    haptic('notification', 'error');
  } finally {
    state.adminBusyKey = '';
  }
}

async function validateProvider(payload) {
  state.modelRoutingBusy = true;
  state.adminMessage = '';
  state.providerValidationResult = null;
  try {
    const res = await request('provider_validate', payload);
    const latency = Number(res.latency_ms || 0);
    state.providerValidationResult = {
      ok: true,
      httpCode: Number(res.http_code || 0),
      latencyMs: latency > 0 ? latency : 0,
      detail: '',
    };
    state.adminTone = 'success';
    state.adminMessage = `Provider 可用（HTTP ${res.http_code}，${latency}ms）`;
    haptic('notification', 'success');
  } catch (error) {
    state.providerValidationResult = {
      ok: false,
      httpCode: Number(error?.http_code || 0),
      latencyMs: Number(error?.latency_ms || 0),
      detail: String(error?.detail || mapError(error)),
    };
    state.adminTone = 'danger';
    state.adminMessage = mapError(error);
    haptic('notification', 'error');
  } finally {
    state.modelRoutingBusy = false;
  }
}


async function checkGroupPermissions(group) {
  const chatId = String(group?.chat_id ?? '');
  if (!chatId) return;
  state.adminMessage = '';
  haptic('impact', 'light');
  try {
    const data = await request('check_bot_permissions', { chat_id: chatId });
    const canSend = data.permissions?.can_send_messages;
    const statusText = data.permissions?.status || 'unknown';
    const sendText = canSend === true ? '可发消息' : (canSend === false ? '不可发消息' : '权限未知');
    state.adminTone = 'success';
    state.adminMessage = `群 ${group?.title || chatId}: ${statusText}，${sendText}`;
    haptic('notification', 'success');
  } catch (error) {
    state.adminTone = 'danger';
    state.adminMessage = mapError(error);
    haptic('notification', 'error');
  }
}

function formatTimestamp(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts * 1000));
}

function submissionLineTitle(row) {
  const it = row.item;
  if (row.kind === 'group') return it.title || String(it.chat_id ?? '');
  return it.chat_title || String(it.chat_id ?? '');
}

async function onAdminRefresh() {
  try {
    await pullBootstrapAndMerge();
    if (isMaster.value) await loadHealth();
    state.loadError = '';
  } catch (error) {
    state.adminTone = 'danger';
    state.adminMessage = mapError(error);
    haptic('notification', 'error');
  }
}

watch(() => form.chatId, (nextValue) => {
  updateMainButton();
});

watch(canSubmit, () => updateMainButton());
watch(() => state.submitBusy, () => updateMainButton());

watch(isDirty, (dirty) => {
  try {
    if (!tg) return;
    if (dirty) {
      tg.enableClosingConfirmation?.();
      tg.disableVerticalSwipes?.();
    } else {
      tg.disableClosingConfirmation?.();
      tg.enableVerticalSwipes?.();
    }
  } catch { /* ignore */ }
}, { immediate: true });

onMounted(async () => {
  setupTelegram();
  tg?.MainButton?.onClick?.(onMainButtonClick);
  tg?.onEvent?.('themeChanged', onThemeChanged);
  await nextTick();
  applySuggestedChatFromClient();
  await loadBootstrap();
  applySuggestedChatFromClient();
  setTimeout(() => applySuggestedChatFromClient(), 80);
  setTimeout(() => applySuggestedChatFromClient(), 400);
  updateMainButton();
  document.addEventListener('visibilitychange', onVisibilityChange);
  startAutoRefresh();
});

onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange);
  stopAutoRefresh();
  tg?.MainButton?.offClick?.(onMainButtonClick);
  tg?.offEvent?.('themeChanged', onThemeChanged);
  try {
    tg?.disableClosingConfirmation?.();
    tg?.enableVerticalSwipes?.();
  } catch { /* ignore */ }
});
</script>

<template>
  <div class="window-container">
    <div class="terminal-window">
      <!-- Title Bar -->
      <div class="terminal-titlebar">
        <div class="traffic-lights">
          <span class="dot dot-close"></span>
          <span class="dot dot-minimize"></span>
          <span class="dot dot-maximize"></span>
        </div>
        <div class="terminal-title">
          <span class="accent">啾咪囝</span> Admin
        </div>
        <div class="titlebar-user">
          <span :class="['badge', isMaster ? 'badge-accent' : 'badge-muted']">
            {{ isMaster ? '管理员' : '申请者' }}
          </span>
        </div>
      </div>

      <!-- Step Bar (Gloria style) -->
      <nav class="step-bar">
        <button :class="['step', { active: activeTab === 'apply' }]" @click="activeTab = 'apply'">申请</button>
        <template v-if="isMaster">
          <span class="step-arrow">›</span>
          <button :class="['step', { active: activeTab === 'review' }]" @click="activeTab = 'review'">
            审核<span v-if="manualQueue.length" class="step-badge">{{ manualQueue.length }}</span>
          </button>
          <span class="step-arrow">›</span>
          <button :class="['step', { active: activeTab === 'stickers' }]" @click="activeTab = 'stickers'">贴纸</button>
          <span class="step-arrow">›</span>
          <button :class="['step', { active: activeTab === 'settings' }]" @click="activeTab = 'settings'">设置</button>
        </template>
      </nav>

      <!-- Content -->
      <div class="window-content">
        <div class="shop-content">
        <!-- Loading -->
        <div v-if="state.loading" class="card">
          <div v-for="n in 4" :key="n" style="padding: 8px 0;">
            <span class="skeleton-bar" :style="{ width: n === 1 ? '55%' : n === 2 ? '72%' : '88%' }" />
          </div>
        </div>

        <!-- Error -->
        <div v-else-if="state.loadError" class="card">
          <div class="card-title" style="margin-bottom:8px">无法完成初始化</div>
          <span class="text-error">{{ state.loadError }}</span>
        </div>

        <template v-else>
          <!-- ===== Tab: 申请 ===== -->
          <div v-show="activeTab === 'apply'" class="tab-panel">
            <!-- Status badges -->
            <div class="status-badges">
              <span :class="['badge', managedEnabled ? 'badge-success' : 'badge-muted']">
                {{ managedEnabled ? '审核制' : '未启用' }}
              </span>
              <span v-if="isMaster && manualQueue.length" class="badge badge-error">
                {{ manualQueue.length }} 待办
              </span>
            </div>

            <!-- Submit form -->
            <div class="section-label">提交申请</div>
            <div class="card">
              <div v-if="!managedEnabled" style="padding:4px 0">
                <span class="text-hint">名单审核未开启，暂时无法提交。</span>
              </div>

              <div v-if="suggestedChatId" class="form-row">
                <span class="form-row-label">当前群</span>
                <span class="form-row-value text-accent">{{ suggestedChatId }}</span>
              </div>
              <div v-if="suggestedChatTitle" style="font-size:12px;color:var(--muted);margin-bottom:8px">{{ suggestedChatTitle }}</div>

              <div style="margin-bottom:10px">
                <label class="form-label">群号</label>
                <input v-model="form.chatId" class="form-input" type="text" inputmode="numeric" placeholder="10 位数字 / -100…" autocomplete="off" />
                <div v-if="chatIdHint" class="text-error" style="margin-top:4px;font-size:12px">{{ chatIdHint }}</div>
              </div>

              <div>
                <label class="form-label">说明</label>
                <textarea v-model="form.note" class="form-textarea" rows="3" maxlength="500" placeholder="选填"></textarea>
              </div>

              <div v-if="!chatIdHint" style="font-size:12px;color:var(--muted);margin-top:8px">填写群号后可提交申请。</div>
            </div>

            <!-- Inline submit -->
            <div v-if="!tg?.MainButton" style="margin-bottom:10px">
              <button class="btn btn-primary btn-full" :disabled="!canSubmit || state.submitBusy" @click="submitApplication">
                {{ state.submitBusy ? '提交中…' : '提交申请' }}
              </button>
            </div>

            <!-- Feedback -->
            <div v-if="state.submitMessage" :class="['banner', state.submitTone === 'success' ? 'banner-success' : 'banner-danger']">
              {{ state.submitMessage }}
            </div>

            <!-- My submissions -->
            <template v-if="!isMaster && state.mySubmissions">
              <div class="section-label">我的申请</div>
              <div v-if="!mySubmissionRows.length" class="card">
                <span class="text-hint">暂无提交记录。</span>
              </div>
              <div v-for="(row, idx) in mySubmissionRows" :key="`${row.kind}-${row.item.request_id ?? row.item.chat_id ?? idx}`" class="card">
                <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
                  <strong style="font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ submissionLineTitle(row) }}</strong>
                  <span class="text-hint" style="flex-shrink:0;font-size:12px">{{ row.item.chat_id }}</span>
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:4px">
                  <template v-if="row.kind === 'pending'"><span class="badge badge-warn">待审核</span></template>
                  <template v-else-if="row.kind === 'reviewed'"><span class="badge badge-error">已拒绝</span></template>
                  <template v-else>
                    <span class="badge badge-success">已通过</span>
                    <span :class="['badge', row.item.enabled ? 'badge-success' : 'badge-muted']">{{ row.item.enabled ? '已启用' : '未启用' }}</span>
                  </template>
                </div>
                <span class="text-hint" style="font-size:12px">{{ formatTimestamp(row.ts) }}</span>
              </div>
            </template>
          </div>

          <!-- ===== Tab: 审核 ===== -->
          <div v-show="activeTab === 'review'" class="tab-panel">
            <AdminReviewPanel
              v-if="isMaster"
              :manual-queue="manualQueue"
              :ai-approved="aiApproved"
              :groups="groups"
              :admin-busy-key="state.adminBusyKey"
              :admin-message="state.adminMessage"
              :admin-tone="state.adminTone"
              @refresh="onAdminRefresh"
              @approve="(item) => runAdminAction(`approve:${item.request_id}`, 'approve', { request_id: item.request_id, enable_now: false }, '申请已通过。')"
              @approve-enable="(item) => runAdminAction(`approve_on:${item.request_id}`, 'approve', { request_id: item.request_id, enable_now: true }, '申请已通过并立即启用。')"
              @reject="(item) => runAdminAction(`reject:${item.request_id}`, 'reject', { request_id: item.request_id }, '申请已拒绝。')"
              @ai-review="(item) => runAdminAction(`ai_review:${item.request_id}`, 'ai_review', { request_id: item.request_id }, 'AI 审核已完成。')"
              @toggle-group="(group) => runAdminAction(`toggle:${group.chat_id}`, 'set_enabled', { chat_id: group.chat_id, enabled: !group.enabled }, group.enabled ? '机器人已关闭。' : '机器人已启用。')"
              @toggle-verify="(group) => runAdminAction(`verify:${group.chat_id}`, 'verify_set_enabled', { chat_id: group.chat_id, enabled: !group.verify_enabled }, group.verify_enabled ? '入群验证已关闭。' : '入群验证已开启。')"
              @remove-group="(group) => runAdminAction(`remove:${group.chat_id}`, 'remove_group', { chat_id: group.chat_id }, '已从名单中移除该群。')"
              @check-group-permissions="checkGroupPermissions"
            />
          </div>

          <!-- ===== Tab: 贴纸 ===== -->
          <div v-show="activeTab === 'stickers'" class="tab-panel">
            <StickerKbPanel v-if="isMaster && activeTab === 'stickers'" :request="request" />
          </div>

          <!-- ===== Tab: 设置 ===== -->
          <div v-show="activeTab === 'settings'" class="tab-panel">
            <ModelRoutingPanel
              v-if="isMaster && modelRouting"
              :model-routing="modelRouting"
              :busy="state.modelRoutingBusy"
              :validation-result="state.providerValidationResult"
              @validate-provider="validateProvider"
            />
            <HealthStatusPanel v-if="isMaster" :health="state.health" :error="state.healthError" />
            <ModelStatusBar :init-data="tg?.initData ?? ''" />
          </div>
        </template>
        </div><!-- .shop-content -->
      </div>

      <!-- Footer (Gloria style) -->
      <div class="shop-footer">
        Powered by <span class="accent">&nbsp;啾咪囝</span>
      </div>
    </div>
  </div>
</template>

<style>
/* App-level overrides — theme.css provides the base */
.status-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 10px;
}

.tab-panel {
  animation: pageFadeIn var(--anim-speed, 0.35s) ease;
}
</style>
