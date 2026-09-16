<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';

const props = defineProps({
  initData: { type: String, default: '' },
});

const STATUS_API = '/miniapp_api/model_status';
const POLL_INTERVAL_MS = 60_000;
const MAX_BARS = 90;

const data = ref(null);
const error = ref(false);
let timer = null;

const roleLabel = { main: '主模型', backup: '备用', review: '审核' };
const expandedModels = reactive({});

const normalizedHistory = computed(() => {
  const history = Array.isArray(data.value?.history) ? data.value.history : [];
  return history.map((snap) => ({
    ts: snap.ts,
    models: Object.fromEntries(
      Object.entries(snap.models ?? {}).map(([label, meta]) => [
        label,
        {
          ...meta,
          status:
            meta.status === 'ok'
              ? 'up'
              : meta.status === 'slow'
                ? 'slow'
                : 'down',
          latency: meta.latency_ms ?? 0,
        },
      ]),
    ),
  }));
});

const latestModels = computed(() => {
  const latest = normalizedHistory.value[normalizedHistory.value.length - 1];
  return latest?.models ?? {};
});

const modelList = computed(() => {
  const rows = Object.entries(latestModels.value).map(([label, meta]) => {
    const bars = buildBars(label, normalizedHistory.value);
    const latest = bars.length > 0 ? bars[bars.length - 1] : null;
    return { label, ...meta, bars, latest };
  });
  return rows.sort((a, b) => {
    const rank = { main: 0, backup: 1, review: 2 };
    return (rank[a.role] ?? 9) - (rank[b.role] ?? 9);
  });
});

const groupedModelList = computed(() => {
  const groups = new Map();
  for (const item of modelList.value) {
    const key = item.model || item.label;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return Array.from(groups.entries()).map(([model, members]) => {
    const latestStatuses = members.map((m) => m.latest?.status ?? 'unknown');
    let status = 'unknown';
    if (latestStatuses.includes('up')) status = 'up';
    else if (latestStatuses.includes('slow')) status = 'slow';
    else if (latestStatuses.includes('down')) status = 'down';
    const latestLatency = members
      .map((m) => m.latest?.latency ?? 0)
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b)[0] ?? 0;
    return { model, members, status, latestLatency };
  });
});

function buildBars(label, history) {
  const bars = [];
  for (const snap of history) {
    const m = snap.models?.[label];
    if (!m) {
      bars.push({ status: 'unknown', latency: 0, ts: snap.ts });
    } else {
      bars.push({ status: m.status, latency: m.latency ?? 0, ts: snap.ts });
    }
  }
  while (bars.length < MAX_BARS) {
    bars.unshift({ status: 'none', latency: 0, ts: 0 });
  }
  return bars.slice(-MAX_BARS);
}

function statusColor(status) {
  if (status === 'up') return 'var(--ms-blue, #3b82f6)';
  if (status === 'slow') return 'var(--ms-green, #22c55e)';
  if (status === 'down') return 'var(--ms-red, #ef4444)';
  return 'var(--ms-empty, rgba(128,128,128,0.15))';
}

function statusText(status) {
  if (status === 'up') return '可用';
  if (status === 'slow') return '缓慢';
  if (status === 'down') return '不可用';
  return '—';
}

function toggleModelDetails(modelName) {
  expandedModels[modelName] = !expandedModels[modelName];
}

function formatLatency(ms) {
  if (!ms || ms <= 0) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatTime(ts) {
  if (!ts) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts * 1000));
}

async function fetchStatus() {
  if (!props.initData) return;
  try {
    const url = `${STATUS_API}?init_data=${encodeURIComponent(props.initData)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error();
    const json = await res.json();
    if (json.ok) {
      data.value = json;
      error.value = false;
    }
  } catch {
    error.value = true;
  }
}

onMounted(() => {
  if (props.initData) {
    fetchStatus();
    timer = setInterval(fetchStatus, POLL_INTERVAL_MS);
  }
});

watch(() => props.initData, (newVal) => {
  if (newVal && !timer) {
    fetchStatus();
    timer = setInterval(fetchStatus, POLL_INTERVAL_MS);
  }
});

onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div v-if="data || error">
    <div class="section-label" style="display:flex;justify-content:space-between;align-items:center">
      <span>模型状态</span>
      <span class="ms-legend">
        <span class="ms-legend-item"><span class="ms-dot" style="background:#3b82f6"></span>可用</span>
        <span class="ms-legend-item"><span class="ms-dot" style="background:#22c55e"></span>缓慢</span>
        <span class="ms-legend-item"><span class="ms-dot" style="background:#ef4444"></span>不可用</span>
      </span>
    </div>

    <div v-if="error && !data" class="card">
      <span class="text-error">无法加载状态数据</span>
    </div>

    <div v-for="group in groupedModelList" :key="group.model" class="card">
      <div class="ms-model-header">
        <span class="ms-model-name">{{ group.model }}</span>
        <span class="text-hint" style="font-size:12px">{{ group.members.length }} 路由</span>
        <span class="ms-model-status" :style="{ color: statusColor(group.status) }">
          {{ statusText(group.status) }}
          <template v-if="group.latestLatency > 0"> · {{ formatLatency(group.latestLatency) }}</template>
        </span>
        <button v-if="group.members.length > 1" class="ms-expand-btn" @click="toggleModelDetails(group.model)">
          {{ expandedModels[group.model] ? '收起' : '展开' }}
        </button>
      </div>
      <div class="ms-bars">
        <div v-for="(bar, i) in group.members[0].bars" :key="i" class="ms-bar" :style="{ background: statusColor(bar.status) }" :title="bar.ts ? `${formatTime(bar.ts)} — ${statusText(bar.status)}${bar.latency ? ' ' + formatLatency(bar.latency) : ''}` : ''" />
      </div>
      <div class="ms-time-axis">
        <span>{{ group.members[0].bars[0]?.ts ? formatTime(group.members[0].bars[0].ts) : '' }}</span>
        <span>{{ group.members[0].bars[group.members[0].bars.length - 1]?.ts ? formatTime(group.members[0].bars[group.members[0].bars.length - 1].ts) : '' }}</span>
      </div>
      <div v-if="group.members.length > 1 && expandedModels[group.model]" class="ms-member-list">
        <div v-for="m in group.members" :key="m.label" class="ms-member-row">
          <span class="ms-member-label">{{ m.label }}</span>
          <span :class="['badge', m.role === 'main' ? 'badge-accent' : m.role === 'review' ? 'badge-warn' : 'badge-muted']" style="font-size:11px">{{ roleLabel[m.role] || m.role }}</span>
          <span class="ms-model-status" :style="{ color: statusColor(m.latest?.status) }">{{ statusText(m.latest?.status) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ms-legend { display: flex; gap: 8px; }
.ms-legend-item { display: flex; align-items: center; gap: 3px; font-size: 10px; color: var(--muted); }
.ms-dot { width: 7px; height: 7px; border-radius: 50%; }

.ms-model-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.ms-model-name { font-size: 14px; font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ms-model-status { margin-left: auto; font-size: 12px; font-weight: 500; flex-shrink: 0; }

.ms-expand-btn {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  cursor: pointer;
  margin-left: 4px;
}

.ms-bars { display: flex; gap: 1.5px; height: 24px; align-items: stretch; }
.ms-bar { flex: 1; min-width: 0; border-radius: 2px; transition: opacity 0.15s; }
.ms-bar:hover { opacity: 0.7; }

.ms-time-axis { display: flex; justify-content: space-between; font-size: 10px; color: var(--muted); margin-top: 3px; opacity: 0.7; }

.ms-member-list { margin-top: 8px; border-top: 1px solid var(--border); padding-top: 6px; }
.ms-member-row { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 3px 0; }
.ms-member-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
</style>
