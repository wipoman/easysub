<template>
  <div class="page-head"><h1>{{ t('nav.notifications') }}</h1></div>
  <p v-if="message" role="status">{{ message }}</p>
  <section v-if="info" class="card">
    <h3>续费提醒</h3>
    <p>Telegram · {{ info.telegram ? '已配置' : '未配置' }}　 邮件 · {{ info.email ? '已配置' : '未配置' }}</p>
    <p class="muted">渠道参数在 Worker 的生产环境变量中设置。每天北京时间 09:00 按订阅的提醒日期扫描。</p>
    <button class="btn" :disabled="busy || !(info.telegram || info.email)" @click="scan">立即扫描并发送到期提醒</button>
  </section>
  <section class="card">
    <div class="page-head"><h3>投递记录</h3><button class="btn ghost" :disabled="busy" @click="load">刷新</button></div>
    <p v-if="info && !info.deliveries.length" class="muted">暂无投递记录</p>
    <article v-for="row in info?.deliveries" :key="row.day + row.channel">
      <b>{{ row.day }} · {{ row.channel.startsWith('telegram-') ? 'Telegram' : '邮件' }} · {{ row.state === 'sent' ? '已发送' : '待确认' }}</b>
      <p class="body">{{ row.body }}</p>
    </article>
  </section>
</template>
<script setup>
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import api from '../api'
const { t } = useI18n()
const info = ref(null), busy = ref(false), message = ref('')
async function load() {
  try { info.value = (await api.get('/api/worker/notifications')).data }
  catch (e) { message.value = e.response?.data?.detail || '读取投递记录失败' }
}
async function scan() {
  busy.value = true
  try { await api.post('/api/worker/scan'); message.value = '本次扫描已完成' }
  catch { message.value = '扫描或投递未完成，请查看投递记录' }
  finally { await load(); busy.value = false }
}
onMounted(load)
</script>
<style scoped>
.card {padding:20px;margin-bottom:16px} article {border-top:1px solid var(--border);padding-top:12px}.body {white-space:pre-wrap}
</style>
