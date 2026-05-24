<script setup>
import { computed, reactive } from 'vue';
import { buildAdminSections, summarizeReason } from '../lib/adminGroups';

const props = defineProps({
  manualQueue: { type: Array, default: () => [] },
  aiApproved: { type: Array, default: () => [] },
  groups: { type: Array, default: () => [] },
  adminBusyKey: { type: String, default: '' },
  adminMessage: { type: String, default: '' },
  adminTone: { type: String, default: 'info' },
});

const emit = defineEmits(['approve', 'approve-enable', 'reject', 'toggle-group', 'ai-review', 'refresh', 'remove-group', 'check-group-permissions', 'toggle-verify']);

const tg = window.Telegram?.WebApp ?? null;

const openSections = reactive({ manual: true, ai: false, groups: true });
const expandedReasons = reactive({});

const sections = computed(() =>
  buildAdminSections({
    manualQueue: props.manualQueue,
    aiApproved: props.aiApproved,
    groups: props.groups,
  })
);

const allEmpty = computed(
  () => props.manualQueue.length === 0 && props.aiApproved.length === 0 && props.groups.length === 0
);

function toggleSection(key) {
  openSections[key] = !openSections[key];
  try { tg?.HapticFeedback?.selectionChanged?.(); } catch { /* ignore */ }
}

function toggleReason(key) {
  expandedReasons[key] = !expandedReasons[key];
}

function reasonKey(sectionKey, item) {
  return `${sectionKey}:${item.request_id ?? item.chat_id ?? 'row'}`;
}

function formatReason(sectionKey, item) {
  const key = reasonKey(sectionKey, item);
  const reason = String(item.ai_reason ?? '').trim();
  if (!reason) return '—';
  return expandedReasons[key] ? reason : summarizeReason(reason, 56);
}

function formatConfidence(value) {
  if (typeof value !== 'number') return '—';
  return value.toFixed(2);
}

function formatTimestamp(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts * 1000));
}

function submitterUserId(item) {
  const a = item.user_id;
  const b = item.submitter_user_id;
  if (a != null && a !== '') return Number(a);
  if (b != null && b !== '') return Number(b);
  return null;
}

function submitterDisplayName(item) {
  const fn = String(item.first_name ?? item.submitter_first_name ?? '').trim();
  const ln = String(item.last_name ?? item.submitter_last_name ?? '').trim();
  if (fn && ln) return `${fn} ${ln}`;
  if (fn) return fn;
  if (ln) return ln;
  return '';
}

function formatSubmitter(item) {
  const u = item.username ?? item.submitter_username;
  if (typeof u === 'string' && u.trim() !== '') return `@${u.trim()}`;
  const name = submitterDisplayName(item);
  if (name) return name;
  const uid = submitterUserId(item);
  if (uid != null && Number.isFinite(uid) && uid !== 0) return `uid ${uid}`;
  return '暂无';
}

function decisionClass(decision) {
  if (decision === 'APPROVE') return 'status-on';
  if (decision === 'REJECT') return 'status-error';
  return '';
}

function confirmAction(message, callback) {
  if (tg?.showConfirm) {
    tg.showConfirm(message, (confirmed) => { if (confirmed) callback(); });
  } else if (window.confirm(message)) {
    callback();
  }
}

function onReject(item) {
  confirmAction('确定要拒绝这个申请吗？', () => emit('reject', item));
}

function onToggleGroup(item) {
  if (item.enabled) {
    confirmAction('确定要关闭该群的机器人吗？', () => emit('toggle-group', item));
  } else {
    emit('toggle-group', item);
  }
}

function onRemoveGroup(item) {
  confirmAction('确定要从白名单中彻底移除该群吗？此操作不可撤销。', () => emit('remove-group', item));
}

function onRefresh() {
  try { tg?.HapticFeedback?.impactOccurred?.('light'); } catch { /* ignore */ }
  emit('refresh');
}
</script>

<template>
  <div>
    <div class="admin-head">
      <div class="section-label">审核中心</div>
      <button type="button" class="btn btn-sm btn-secondary" @click="onRefresh">刷新</button>
    </div>

    <template v-if="allEmpty">
      <div class="card" style="text-align:center">
        <span class="text-hint">暂无待处理事项。</span>
      </div>
    </template>

    <template v-else>
      <template v-for="section in sections" :key="section.key">
        <!-- Section toggle -->
        <div class="card" style="padding:0">
          <button class="section-toggle" @click="toggleSection(section.key)">
            <span class="section-toggle-left">
              <span style="font-weight:600;font-size:14px">{{ section.title }}</span>
              <span v-if="section.subtitle" class="text-hint" style="font-size:12px">{{ section.subtitle }}</span>
            </span>
            <span class="section-toggle-right">
              <span class="badge badge-accent">{{ section.items.length }}</span>
              <span class="section-arrow" :class="{ open: openSections[section.key] }">›</span>
            </span>
          </button>
        </div>

        <!-- Section body -->
        <template v-if="openSections[section.key]">
          <div v-if="!section.items.length" style="padding:4px 0">
            <span class="text-hint" style="font-size:12px">暂无记录。</span>
          </div>

          <template v-for="item in section.items" :key="item.request_id || item.chat_id">
            <div class="card">
              <!-- Title -->
              <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px">
                <strong style="font-size:14px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ item.chat_title || item.title || item.chat_id }}</strong>
                <span v-if="item.chat_username" style="font-size:12px;color:var(--muted);margin-left:6px">{{ item.chat_username }}</span>
                <span class="text-hint" style="font-size:12px;flex-shrink:0">{{ formatTimestamp(item.ai_reviewed_at || item.updated_at || item.created_at) }}</span>
              </div>
              <div class="text-hint" style="font-size:12px;margin-bottom:8px">{{ item.chat_id }}</div>

              <div class="form-row">
                <span class="form-row-label">提交者</span>
                <span class="form-row-value">{{ formatSubmitter(item) }}</span>
              </div>

              <!-- Fields for manual / ai -->
              <template v-if="section.key !== 'groups'">
                <div class="form-row">
                  <span class="form-row-label">AI 决定</span>
                  <span :class="['form-row-value', decisionClass(item.ai_decision)]">{{ item.ai_decision || '—' }}</span>
                </div>
                <div class="form-row">
                  <span class="form-row-label">置信度</span>
                  <span class="form-row-value">{{ formatConfidence(item.ai_confidence) }}</span>
                </div>
                <div style="padding:8px 0">
                  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
                    <span class="form-row-label">理由</span>
                    <button v-if="item.ai_reason" class="reason-toggle" @click="toggleReason(reasonKey(section.key, item))">
                      {{ expandedReasons[reasonKey(section.key, item)] ? '收起' : '展开' }}
                    </button>
                  </div>
                  <span class="text-hint" style="font-size:12px;line-height:1.45;white-space:pre-wrap;word-break:break-word">{{ formatReason(section.key, item) }}</span>
                </div>
              </template>

              <!-- Note for manual -->
              <div v-if="section.key === 'manual'" style="padding:8px 0;border-top:1px solid rgba(255,255,255,0.04)">
                <span class="form-row-label" style="display:block;margin-bottom:4px">备注</span>
                <span class="text-hint" style="font-size:13px">{{ item.note || '无备注' }}</span>
              </div>

              <!-- Fields for groups -->
              <template v-if="section.key === 'groups'">
                <div class="form-row">
                  <span class="form-row-label">审核</span>
                  <span class="form-row-value">{{ item.review_state === 'auto_approved' ? 'AI 自动' : (item.review_state === 'manual_approved' ? '人工通过' : (item.review_state || '—')) }}</span>
                </div>
                <div class="form-row">
                  <span class="form-row-label">来源</span>
                  <span class="form-row-value">{{ item.approved_by || '—' }}</span>
                </div>
                <div class="form-row">
                  <span class="form-row-label">状态</span>
                  <span :class="['form-row-value', item.enabled ? 'status-on' : 'status-off']">{{ item.enabled ? '已启用' : '未启用' }}</span>
                </div>
              </template>

              <!-- Action buttons: manual -->
              <div v-if="section.key === 'manual'" class="btn-group" style="margin-top:10px">
                <button class="btn btn-primary btn-full" :disabled="Boolean(adminBusyKey)" @click="emit('approve', item)">
                  {{ adminBusyKey === `approve:${item.request_id}` ? '处理中…' : '通过' }}
                </button>
                <button class="btn btn-secondary btn-full" :disabled="Boolean(adminBusyKey)" @click="emit('approve-enable', item)">
                  {{ adminBusyKey === `approve_on:${item.request_id}` ? '处理中…' : '通过并启用' }}
                </button>
                <button class="btn btn-secondary btn-full" :disabled="Boolean(adminBusyKey)" @click="emit('ai-review', item)">
                  {{ adminBusyKey === `ai_review:${item.request_id}` ? '处理中…' : 'AI 审核' }}
                </button>
                <button class="btn btn-danger btn-full" :disabled="Boolean(adminBusyKey)" @click="onReject(item)">
                  {{ adminBusyKey === `reject:${item.request_id}` ? '处理中…' : '拒绝' }}
                </button>
              </div>

              <!-- Action buttons: groups -->
              <div v-if="section.key === 'groups'" class="btn-group" style="margin-top:10px">
                <button class="btn btn-secondary btn-full" :disabled="Boolean(adminBusyKey)" @click="emit('check-group-permissions', item)">检查 Bot 权限</button>
                <button class="btn btn-full" :disabled="Boolean(adminBusyKey)" @click="onToggleGroup(item)">
                  {{ adminBusyKey === `toggle:${item.chat_id}` ? '处理中…' : item.enabled ? '关闭' : '启用' }}
                </button>
                <button :class="['btn btn-full', item.verify_enabled ? 'btn-warn' : 'btn-secondary']" :disabled="Boolean(adminBusyKey)" @click="emit('toggle-verify', item)">
                  {{ item.verify_enabled ? '🔐 验证已开' : '🔓 验证' }}
                </button>
                <button class="btn btn-danger btn-full" :disabled="Boolean(adminBusyKey)" @click="onRemoveGroup(item)">
                  {{ adminBusyKey === `remove:${item.chat_id}` ? '处理中…' : '移除' }}
                </button>
              </div>
            </div>
          </template>
        </template>
      </template>
    </template>

    <!-- Admin feedback -->
    <div v-if="adminMessage" :class="['banner', adminTone === 'success' ? 'banner-success' : 'banner-danger']">
      {{ adminMessage }}
    </div>
  </div>
</template>

<style scoped>
.admin-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}

.section-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 12px 14px;
  border: none;
  background: transparent;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.section-toggle:active { opacity: 0.7; }

.section-toggle-left {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
}

.section-toggle-right {
  display: flex;
  align-items: center;
  gap: 6px;
}

.section-arrow {
  font-size: 18px;
  font-weight: 600;
  color: var(--muted);
  transition: transform 0.2s;
}

.section-arrow.open { transform: rotate(90deg); }

.reason-toggle {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  cursor: pointer;
  padding: 0;
}
</style>
