<script setup>
import { computed } from 'vue';
import { formatHealthTimestamp, formatUptimeSeconds } from '../lib/health';

const props = defineProps({
  health: { type: Object, default: null },
  error: { type: String, default: '' },
});

const statusText = computed(() => {
  const status = props.health?.status;
  if (status === 'ok') return '正常';
  if (status === 'degraded') return '降级';
  if (status === 'error') return '故障';
  return '未知';
});

const statusClass = computed(() => {
  const status = props.health?.status;
  if (status === 'ok') return 'status-on';
  if (status === 'degraded') return 'text-hint';
  if (status === 'error') return 'status-error';
  return '';
});
</script>

<template>
  <div>
    <div class="section-label">运行状态</div>
    <div class="card">
      <div v-if="error">
        <span class="text-error">{{ error }}</span>
      </div>
      <template v-else-if="health">
        <div class="form-row">
          <span class="form-row-label">服务状态</span>
          <span :class="['form-row-value', statusClass]">{{ statusText }}</span>
        </div>
        <div class="form-row">
          <span class="form-row-label">运行时长</span>
          <span class="form-row-value">{{ formatUptimeSeconds(health.uptime) }}</span>
        </div>
        <div class="form-row">
          <span class="form-row-label">Redis</span>
          <span :class="['form-row-value', health.checks?.redis?.ok ? 'status-on' : 'status-error']">
            {{ health.checks?.redis?.ok ? `${health.checks?.redis?.latency_ms ?? 0}ms` : '异常' }}
          </span>
        </div>
        <div class="form-row">
          <span class="form-row-label">SQLite</span>
          <span :class="['form-row-value', health.checks?.sqlite?.ok ? 'status-on' : 'status-error']">
            {{ health.checks?.sqlite?.ok ? '正常' : '异常' }}
          </span>
        </div>
        <div class="form-row">
          <span class="form-row-label">更新时间</span>
          <span class="form-row-value">{{ formatHealthTimestamp(health.checks?.timestamp) }}</span>
        </div>
      </template>
      <div v-else>
        <span class="text-hint">暂无状态数据。</span>
      </div>
    </div>
  </div>
</template>
