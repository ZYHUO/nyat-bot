<script setup>
import { computed, onMounted, reactive, ref } from 'vue';

const props = defineProps({
  request: { type: Function, required: true },
  initData: { type: String, default: '' },
});

const items = ref([]);
const loading = ref(false);
const errorMessage = ref('');

const statusFilter = ref('all');
const search = ref('');
const collapsed = reactive(Object.create(null));
const updating = reactive(Object.create(null));

async function loadAll() {
  loading.value = true;
  errorMessage.value = '';
  try {
    const data = await props.request('sticker_kb_list');
    items.value = Array.isArray(data?.items) ? data.items : [];
  } catch (err) {
    errorMessage.value = typeof err === 'string' ? err : (err?.message ?? '加载失败');
  } finally {
    loading.value = false;
  }
}

onMounted(loadAll);

const stats = computed(() => {
  const arr = items.value;
  let total = arr.length;
  let pickable = 0;
  let blocked = 0;
  let unknown = 0;
  let pending = 0;
  for (const it of arr) {
    if (it.analysis_status !== 'ready') {
      pending++;
      continue;
    }
    if (it.persona_fit === false) blocked++;
    else if (it.persona_fit === true) pickable++;
    else unknown++;
  }
  return { total, pickable, blocked, unknown, pending };
});

function classifyStatus(item) {
  if (item.analysis_status !== 'ready') return 'pending';
  if (item.persona_fit === false) return 'blocked';
  if (item.persona_fit === true) return 'pickable';
  return 'unknown';
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase();
  return items.value.filter((it) => {
    if (statusFilter.value !== 'all' && classifyStatus(it) !== statusFilter.value) return false;
    if (q) {
      const hay = `${it.emoji ?? ''} ${it.set_name ?? ''} ${(it.emotion_tags ?? []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
});

const groups = computed(() => {
  const map = new Map();
  for (const it of filtered.value) {
    const key = it.set_name ?? '(无集合)';
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(it);
  }
  return Array.from(map.entries())
    .map(([set_name, list]) => {
      const totalUsage = list.reduce((s, x) => s + (x.usage_count ?? 0), 0);
      return { set_name, items: list, totalUsage };
    })
    .sort((a, b) => b.totalUsage - a.totalUsage || a.set_name.localeCompare(b.set_name));
});

function toggleGroup(setName) {
  collapsed[setName] = !collapsed[setName];
}

async function setPersonaFit(item, value) {
  if (updating[item.file_unique_id]) return;
  updating[item.file_unique_id] = true;
  try {
    await props.request('sticker_kb_update', {
      file_unique_id: item.file_unique_id,
      persona_fit: value,
    });
    item.persona_fit = value;
  } catch (err) {
    errorMessage.value = typeof err === 'string' ? err : (err?.message ?? '更新失败');
  } finally {
    updating[item.file_unique_id] = false;
  }
}

async function bulkSetGroup(group, value) {
  errorMessage.value = '';
  for (const item of group.items) {
    if (item.analysis_status !== 'ready') continue;
    if (item.persona_fit === value) continue;
    try {
      await props.request('sticker_kb_update', {
        file_unique_id: item.file_unique_id,
        persona_fit: value,
      });
      item.persona_fit = value;
    } catch (err) {
      errorMessage.value = typeof err === 'string' ? err : (err?.message ?? '部分更新失败');
      break;
    }
  }
}

function emojiOrPlaceholder(item) {
  return item.emoji && item.emoji.trim() ? item.emoji : '🖼';
}

function tagsLine(item) {
  const tags = Array.isArray(item.emotion_tags) ? item.emotion_tags.slice(0, 4) : [];
  return tags.join(' / ');
}

function previewUrl(item) {
  if (item.asset_status !== 'preview_ready') return null;
  const fuid = encodeURIComponent(item.file_unique_id);
  const initData = encodeURIComponent(props.initData ?? '');
  return `/miniapp_api/sticker_preview/${fuid}?init_data=${initData}`;
}
</script>

<template>
  <div class="panel-stickers">
    <div class="card" style="margin-bottom:12px">
      <div style="display:flex;flex-wrap:wrap;gap:14px;font-size:13px">
        <span><strong>共</strong> {{ stats.total }}</span>
        <span class="text-success"><strong>可发</strong> {{ stats.pickable + stats.unknown }}</span>
        <span><strong>已禁</strong> {{ stats.blocked }}</span>
        <span class="text-hint"><strong>未分析</strong> {{ stats.pending }}</span>
      </div>
      <div class="text-hint" style="font-size:12px;margin-top:6px">
        「已禁」= 仍能识别，但 bot 不会主动发出。适合给"看着可以但发出去尴尬"的贴纸用。
      </div>
    </div>

    <div class="card" style="margin-bottom:12px">
      <div class="form-row">
        <span class="form-row-label">状态</span>
        <select v-model="statusFilter" class="form-select" style="width:auto;text-align:right">
          <option value="all">全部</option>
          <option value="pickable">已设为可发</option>
          <option value="blocked">已禁用</option>
          <option value="unknown">未设置（默认可发）</option>
          <option value="pending">未分析</option>
        </select>
      </div>
      <div style="margin-top:8px">
        <input
          v-model="search"
          class="form-input"
          type="text"
          placeholder="搜索 emoji / 集合名 / 情绪标签"
        />
      </div>
      <button class="btn btn-full" style="margin-top:10px" :disabled="loading" @click="loadAll">
        {{ loading ? '加载中…' : '刷新' }}
      </button>
    </div>

    <div v-if="errorMessage" class="banner-danger" style="padding:10px;border-radius:8px;margin-bottom:10px;font-size:13px">
      {{ errorMessage }}
    </div>

    <div v-if="loading && items.length === 0" class="text-hint" style="text-align:center;padding:24px">
      加载中…
    </div>

    <div v-for="group in groups" :key="group.set_name" class="card" style="margin-bottom:8px;padding:0">
      <div
        @click="toggleGroup(group.set_name)"
        style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;cursor:pointer;border-bottom:1px solid var(--mac-divider, rgba(0,0,0,0.06))"
      >
        <div style="flex:1;min-width:0">
          <div style="font-weight:500;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            {{ collapsed[group.set_name] ? '▶' : '▼' }} {{ group.set_name }}
          </div>
          <div class="text-hint" style="font-size:12px;margin-top:2px">
            {{ group.items.length }} 张 · 累计使用 {{ group.totalUsage }} 次
          </div>
        </div>
        <div style="display:flex;gap:6px" @click.stop>
          <button
            class="btn btn-sm"
            style="font-size:12px;padding:4px 8px"
            @click="bulkSetGroup(group, true)"
          >
            全开
          </button>
          <button
            class="btn btn-sm btn-secondary"
            style="font-size:12px;padding:4px 8px"
            @click="bulkSetGroup(group, false)"
          >
            全禁
          </button>
        </div>
      </div>
      <div v-show="!collapsed[group.set_name]" style="padding:4px 0">
        <div
          v-for="item in group.items"
          :key="item.file_unique_id"
          style="display:flex;align-items:center;gap:10px;padding:8px 12px;border-top:1px solid var(--mac-divider, rgba(0,0,0,0.04))"
        >
          <div style="width:48px;height:48px;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.04);border-radius:6px;flex-shrink:0">
            <img
              v-if="previewUrl(item)"
              :src="previewUrl(item)"
              :alt="item.emoji || item.file_unique_id"
              style="max-width:48px;max-height:48px;object-fit:contain;display:block"
              loading="lazy"
              @error="$event.target.style.display='none'; $event.target.nextElementSibling && ($event.target.nextElementSibling.style.display='inline')"
            />
            <span
              :style="previewUrl(item) ? 'display:none;font-size:24px' : 'font-size:24px'"
            >
              {{ emojiOrPlaceholder(item) }}
            </span>
          </div>
          <div style="flex:1;min-width:0">
            <div style="font-size:12px;font-family:monospace;color:var(--text-hint, #888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
              {{ item.file_unique_id }}
            </div>
            <div v-if="tagsLine(item)" style="font-size:12px;margin-top:2px">
              {{ tagsLine(item) }}
            </div>
            <div class="text-hint" style="font-size:11px;margin-top:2px">
              用过 {{ item.usage_count ?? 0 }} 次 ·
              <span v-if="item.analysis_status !== 'ready'">未分析</span>
              <span v-else-if="item.persona_fit === false">已禁用</span>
              <span v-else-if="item.persona_fit === true" class="text-success">可发</span>
              <span v-else>默认可发</span>
            </div>
          </div>
          <button
            v-if="item.analysis_status === 'ready'"
            class="btn btn-sm"
            :class="item.persona_fit === false ? 'btn-secondary' : ''"
            style="font-size:12px;padding:4px 10px;min-width:60px"
            :disabled="updating[item.file_unique_id]"
            @click="setPersonaFit(item, item.persona_fit === false ? true : false)"
          >
            {{ updating[item.file_unique_id] ? '…' : (item.persona_fit === false ? '启用' : '禁用') }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="!loading && groups.length === 0" class="text-hint" style="text-align:center;padding:24px">
      没有匹配的贴纸
    </div>
  </div>
</template>

<style scoped>
.panel-stickers {
  font-size: 14px;
}
</style>
