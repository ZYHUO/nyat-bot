<script setup>
import { computed, reactive } from 'vue';

const props = defineProps({
  modelRouting: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  validationResult: { type: Object, default: null },
});

const emit = defineEmits(['validate-provider']);

const providerForm = reactive({
  endpoint: '',
  model: '',
  apiKey: '',
  apiFormat: 'openai',
  stream: false,
});

const usageRows = computed(() =>
  Object.entries(props.modelRouting?.effective ?? {}).map(([usage, config]) => ({
    usage,
    label: config?.label ?? '',
    backups: Array.isArray(config?.backups) ? config.backups : [],
    timeout: config?.timeout,
    maxTokens: config?.maxTokens,
    temperature: config?.temperature,
  })),
);

const providerRows = computed(() =>
  Object.entries(props.modelRouting?.providers ?? {}).map(([label, provider]) => ({
    label,
    endpoint: provider?.endpoint ?? '',
    model: provider?.model ?? '',
    apiFormat: provider?.api_format ?? 'openai',
    stream: Boolean(provider?.stream),
  })),
);

function formatUsage(row) {
  const parts = [`${row.label || '未配置'}`];
  if (row.backups.length) parts.push(`备援: ${row.backups.join(', ')}`);
  if (Number.isFinite(row.timeout)) parts.push(`超时 ${row.timeout}ms`);
  if (Number.isFinite(row.maxTokens)) parts.push(`maxTokens ${row.maxTokens}`);
  if (row.temperature !== undefined) parts.push(`temp ${row.temperature}`);
  return parts.join(' · ');
}

function onValidateProvider() {
  emit('validate-provider', {
    provider: {
      endpoint: providerForm.endpoint.trim(),
      model: providerForm.model.trim(),
      api_key: providerForm.apiKey,
      api_format: providerForm.apiFormat,
      stream: providerForm.stream,
    },
  });
}
</script>

<template>
  <div>
    <div class="section-label">模型路由（环境变量只读）</div>
    <div class="text-hint" style="font-size:12px;margin-bottom:8px">运行时改路由已移除；此处仅展示当前生效配置，并保留 Provider 连通性验证。</div>

    <div class="card">
      <div v-for="row in usageRows" :key="`usage-${row.usage}`" class="form-row">
        <span class="form-row-label">{{ row.usage }}</span>
        <span class="form-row-value">{{ row.label || '未配置' }}</span>
      </div>
      <div v-if="usageRows.length === 0" style="text-align:center;padding:8px 0">
        <span class="text-hint">未读取到 usage 路由。</span>
      </div>
    </div>

    <div class="section-label">已加载 Providers</div>
    <div class="card">
      <template v-for="row in providerRows" :key="`provider-${row.label}`">
        <div class="form-row">
          <span class="form-row-label">{{ row.label }}</span>
          <span class="form-row-value">{{ row.model || '未配置 model' }}</span>
        </div>
        <div class="text-hint" style="font-size:12px;margin-bottom:6px">{{ row.endpoint }} · {{ row.apiFormat }}<template v-if="row.stream"> · stream</template></div>
      </template>
      <div v-if="providerRows.length === 0" style="text-align:center;padding:8px 0">
        <span class="text-hint">未读取到 provider 配置。</span>
      </div>
    </div>

    <div class="section-label">验证 Provider</div>
    <div class="text-hint" style="font-size:12px;margin-bottom:8px">仅用于连通性检查，不会保存任何配置。</div>
    <div class="card">
      <div style="margin-bottom:10px">
        <label class="form-label">Endpoint</label>
        <input v-model="providerForm.endpoint" class="form-input" type="text" placeholder="https://.../v1" />
      </div>
      <div style="margin-bottom:10px">
        <label class="form-label">Model</label>
        <input v-model="providerForm.model" class="form-input" type="text" placeholder="gpt-4o-mini" />
      </div>
      <div style="margin-bottom:10px">
        <label class="form-label">API Key</label>
        <input v-model="providerForm.apiKey" class="form-input" type="password" placeholder="仅用于本次验证" />
      </div>
      <div class="form-row">
        <span class="form-row-label">API 格式</span>
        <select v-model="providerForm.apiFormat" class="form-select" style="width:auto;text-align:right">
          <option value="openai">openai-compatible</option>
          <option value="claude">claude</option>
        </select>
      </div>
      <div class="form-row">
        <span class="form-row-label">SSE stream</span>
        <input v-model="providerForm.stream" type="checkbox" />
      </div>
      <button class="btn btn-full" style="margin-top:10px" :disabled="busy" @click="onValidateProvider">
        {{ busy ? '处理中…' : '验证连通性' }}
      </button>
      <div v-if="validationResult" :class="['validation-result', validationResult.ok ? 'banner-success' : 'banner-danger']" style="margin-top:10px;padding:10px;border-radius:8px;font-size:13px">
        <strong>{{ validationResult.ok ? '验证通过' : '验证失败' }}</strong>
        <span v-if="validationResult.httpCode"> · HTTP {{ validationResult.httpCode }}</span>
        <span v-if="validationResult.latencyMs"> · {{ validationResult.latencyMs }}ms</span>
        <div v-if="validationResult.detail" style="margin-top:4px;white-space:pre-wrap;word-break:break-word">{{ validationResult.detail }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Component uses global theme classes — no extra scoped styles needed */
</style>
