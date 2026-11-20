<template>
  <div class="page-head"><h1>{{ t('nav.settings') }}</h1></div>
  <p v-if="message" role="status">{{ message }}</p>
  <form v-if="form" class="grid" @submit.prevent="save">
    <section class="card"><h3>账号与密码</h3><label>{{ t('auth.username') }}<input :value="form.username" readonly /></label>
      <p class="muted">登录名和密码由 Cloudflare 生产环境的 ADMIN_USERNAME 和 ADMIN_PASSWORD 管理。</p>
    </section>
    <section class="card"><h3>{{ t('settings.theme') }} / {{ t('settings.language') }}</h3>
      <label>{{ t('settings.language') }}<select v-model="form.locale"><option value="zh">中文</option><option value="en">English</option><option value="ru">Русский</option></select></label>
      <label>{{ t('settings.theme') }}<select v-model="form.theme"><option v-for="v in themes" :key="v" :value="v">{{ t('settings.theme' + v[0].toUpperCase() + v.slice(1)) }}</option></select></label>
    </section>
    <section class="card"><h3>货币与预算</h3>
      <label>{{ t('settings.baseCurrency') }}<select v-model="form.base_currency"><option v-for="c in form.currencies" :key="c">{{ c }}</option></select></label>
      <label>月度预算（{{ form.base_currency }}）<input type="number" min="0" step="any" v-model.number="form.monthly_budget" placeholder="留空表示不限" /></label>
    </section>
    <div class="actions"><button class="btn" :disabled="busy">{{ t('settings.save') }}</button></div>
  </form>
</template>
<script setup>
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAuth } from '../stores/auth'
import api from '../api'
const { t, locale } = useI18n(), auth = useAuth()
const themes = ['light','dark','ocean','forest','purple','auto']
const form = ref(null), message = ref(''), busy = ref(false)
onMounted(async () => {
  try { form.value = (await api.get('/api/worker/settings')).data }
  catch (e) { message.value = e.response?.data?.detail || '读取设置失败' }
})
async function save() {
  busy.value = true
  try {
    form.value = (await api.put('/api/worker/settings', { ...form.value, monthly_budget: form.value.monthly_budget || null })).data
    await auth.fetchMe()
    locale.value = form.value.locale
    message.value = t('settings.saved')
  } catch (e) { message.value = e.response?.data?.detail || '保存失败' }
  finally { busy.value = false }
}
</script>
<style scoped>
.grid {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,320px),1fr));gap:18px}.card {padding:20px}.actions {grid-column:1/-1}
</style>
