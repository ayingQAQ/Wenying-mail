<template>
  <div class="box">
    <div class="header-actions">
      <button class="mail-icon-button" aria-label="返回邮件列表" @click="handleBack"><Icon icon="mail-ui:arrow-left"/></button>
      <button v-perm="'email:delete'" class="mail-icon-button" aria-label="移到回收站" @click="handleDelete"><Icon icon="mail-ui:trash-2"/></button>
      <button v-if="emailStore.contentData.showStar" class="mail-icon-button" :aria-label="email.isStar?'取消星标':'添加星标'" :style="email.isStar?{color:'#bc8026'}:{}" @click="changeStar"><Icon icon="mail-ui:star"/></button>
      <Icon class="icon" v-if="emailStore.contentData.showReply" v-perm="'email:send'"  @click="openReply" icon="la:reply" width="21" height="21" />
      <Icon class="icon" v-if="emailStore.contentData.showReply" v-perm="'email:send'"  @click="openForward" icon="iconoir:arrow-up-right" width="20" height="20" />
    </div>
    <div></div>
    <el-scrollbar class="scrollbar">
      <div class="container">
        <div class="reader-sender-header"><span class="reader-avatar" aria-hidden="true">{{(email.name||email.sendEmail||'M').slice(0,1).toUpperCase()}}</span><div class="reader-heading"><div class="reader-sender"><strong>{{email.name||email.sendEmail}}</strong><span>&lt;{{email.sendEmail}}&gt;</span></div><h2 class="email-title">{{email.subject||'（无主题）'}}</h2></div></div>
        <div class="content">
          <div class="email-info">
            <div class="reader-meta"><span>收件人：{{formateReceive(email.recipient)}}</span><span>时间：{{formatDetailDate(email.createTime)}}</span></div>
            <el-alert v-if="email.status === 3" :closable="false" :title="toMessage(email.message)" class="email-msg" type="error" show-icon />
            <el-alert v-if="email.status === 4" :closable="false" :title="$t('complained')" class="email-msg" type="warning" show-icon />
            <el-alert v-if="email.status === 5" :closable="false" :title="$t('delayed')" class="email-msg" type="warning" show-icon />
          </div>
          <VerificationCode :code="detectedCode"/>
          <el-scrollbar class="htm-scrollbar" :class="!email.attList?.length ? 'bottom-distance' : ''">
            <div class="body-actions">
              <button @click="bodyFormat = bodyFormat === 'html' ? 'text' : 'html'">{{ bodyFormat === 'html' ? (english ? 'Plain text' : '纯文本') : 'HTML' }}</button>
              <a v-if="email.rawAvailable" :href="`/api/email/${email.emailId}/raw`" download>.eml</a>
              <span v-if="loading" role="status">{{ english ? 'Loading…' : '正在加载…' }}</span>
              <button v-if="bodyError" @click="loadContent({force:true})">{{ english ? 'Retry loading message' : '重新加载邮件' }}</button>
            </div>
            <ShadowHtml :key="email.emailId" class="shadow-html" :html="bodyContent" :images="bodyImages" v-if="bodyFormat === 'html' && bodyContent" />
            <pre v-else-if="bodyFormat === 'text' && bodyContent" class="email-text">{{bodyContent}}</pre>
          </el-scrollbar>
          <div class="att" v-if="email.attList?.length > 0">
            <div class="att-title">
              <span>{{$t('attachments')}}</span>
              <span>{{$t('attCount',{total: email.attList.length})}}</span>
            </div>
            <div class="att-box">

              <div class="att-item" v-for="att in email.attList" :key="att.attId">
                <div class="att-icon" >
                  <Icon v-bind="getIconByName(att.filename)" />
                </div>
                <div class="att-name" >
                  {{ att.filename }}
                </div>
                <div class="att-size">{{ formatBytes(att.size) }}</div>
                <div class="opt-icon att-icon">

                  <a :href="`/api/attachment/${att.attId}`" download>
                    <Icon icon="system-uicons:push-down" width="22" height="22"/>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </el-scrollbar>
    <el-image-viewer
        v-if="showPreview"
        :url-list="srcList"
        show-progress
        @close="showPreview = false"
    />
  </div>
</template>
<script setup>
import ShadowHtml from '@/components/shadow-html/index.vue'
import VerificationCode from '@/components/verification-code.vue';
import {verificationCode} from '@/utils/mail-ui.js';
import {computed, reactive, ref, watch, onMounted, onUnmounted} from "vue";
import {useRouter} from 'vue-router'
import {ElMessage, ElMessageBox} from 'element-plus'
import {emailDelete, emailRead, emailDetail, emailBody} from "@/request/email.js";
import {Icon} from "@iconify/vue";
import {useEmailStore} from "@/store/email.js";
import {useAccountStore} from "@/store/account.js";
import {formatDetailDate} from "@/utils/day.js";
import {starAdd, starCancel} from "@/request/star.js";
import {formatBytes} from "@/utils/file-utils.js";
import {getIconByName} from "@/utils/icon-utils.js";
import {allEmailDelete} from "@/request/all-email.js";
import {useUiStore} from "@/store/ui.js";
import {useI18n} from "vue-i18n";
import {EmailUnreadEnum} from "@/enums/email-enum.js";
import {createReaderCache} from '@/utils/reader-cache.js';
import {watchMessageSelection} from '@/utils/watch-message.js';

const uiStore = useUiStore();
const props=defineProps({embedded:Boolean});
const emit=defineEmits(['close']);
const accountStore = useAccountStore();
const emailStore = useEmailStore();
const router = useRouter()
const email = computed(() => emailStore.contentData.email || {
  emailId: 0,
  attList: [],
  content: '',
  text: '',
  recipient: '[]',
})
const showPreview = ref(false)
const srcList = reactive([])

const { t, locale } = useI18n()
const english = computed(() => locale.value.startsWith('en'))
const bodyFormat = ref('html'), bodyContent = ref(''), bodyImages = ref([]), loading = ref(false), bodyError = ref(false)
const detectedCode=computed(()=>verificationCode(email.value,bodyFormat.value==='text'?bodyContent.value:bodyContent.value.replace(/<[^>]*>/g,' ')));
const readerCache=createReaderCache();
let contentController, contentEpoch = 0
async function loadContent({force=false}={}) {
  contentController?.abort()
  const epoch = ++contentEpoch, id = email.value.emailId
  bodyContent.value = ''; bodyImages.value = []; bodyError.value = false
  if (!id) return
  contentController = new AbortController(); loading.value = true
  try {
    const key=`${id}:${bodyFormat.value}`;
    const cached=force?null:readerCache.get(key);
    const [detail, body] = cached || await Promise.all([
      emailDetail(id, contentController.signal), emailBody(id, bodyFormat.value, contentController.signal)
    ])
    if (epoch !== contentEpoch || email.value.emailId !== id) return
    if(!cached)readerCache.set(key,[detail,body]);
    emailStore.contentData.email = {...email.value, ...detail, unread:email.value.unread, isStar:email.value.isStar}
    bodyContent.value = body.content; bodyImages.value = body.images
    loading.value = false; tryMarkRead()
  } catch { if (epoch === contentEpoch) bodyError.value = true }
  finally { if (epoch === contentEpoch) loading.value = false }
}
watchMessageSelection(() => email.value.emailId, bodyFormat, loadContent)
watch(() => accountStore.currentAccountId, () => {
  readerCache.clear();
  if (!props.embedded) handleBack()
})

const readRequesting = new Set(), starRequesting = new Set(), deleteRequesting = new Set()
let readerClosed = false

function tryMarkRead() {
  if (!emailStore.contentData.showUnread) return
  const current = email.value
  if (!current?.emailId || readRequesting.has(current.emailId) || current.unread !== EmailUnreadEnum.UNREAD) return

  // 等详情数据就绪（detailMap 已写入，或正文已有内容）再标已读
  const detailReady = !loading.value && !bodyError.value
  if (!detailReady) return

  const emailId = current.emailId
  readRequesting.add(emailId)
  emailRead([emailId]).then(() => {
    current.unread = EmailUnreadEnum.READ
    if (email.value.emailId === emailId) email.value.unread = EmailUnreadEnum.READ
    if (emailStore.detailMap[emailId]) emailStore.detailMap[emailId].unread = EmailUnreadEnum.READ
    emailStore.markListRead(emailId)
  }).catch(() => {
    // The interceptor reports the failure; leave the message unread.
  }).finally(() => readRequesting.delete(emailId))
}

watch(
  () => [
    email.value?.emailId,
    email.value?.content,
    email.value?.text,
    emailStore.detailMap[email.value?.emailId]
  ],
  () => tryMarkRead(),
  { flush: 'post' }
)

onMounted(() => {
  tryMarkRead()
  window.addEventListener('keydown', handleKeyDown);
})

onUnmounted(() => {
  readerCache.clear();contentEpoch++; contentController?.abort(); bodyContent.value = ''; bodyImages.value = []
  emailStore.contentData.showUnread = false;
  readerClosed = true
  window.removeEventListener('keydown', handleKeyDown);
})

function handleKeyDown(event) {
  if (event.key !== 'Escape') return;
  if (showPreview.value) return;
  if (document.querySelector('.el-message-box')) return;
  const writeBox = document.querySelector('.write-box');
  if (writeBox && writeBox.offsetParent !== null) return;
  handleBack();
}

function openReply() {
  uiStore.writerRef.openReply(email.value)
}

function openForward() {
  uiStore.writerRef.openForward(email.value)
}

function toMessage(message) {
  return  message ? JSON.parse(message).message : '';
}

function formateReceive(recipient) {
  if (!recipient) return ''
  recipient = JSON.parse(recipient)
  return recipient.map(item => item.address).join(', ')
}

async function changeStar() {
  const current = email.value, emailId = current.emailId
  if (!emailId || starRequesting.has(emailId)) return
  const starred = current.isStar ? 0 : 1
  starRequesting.add(emailId)
  try {
    await (starred ? starAdd : starCancel)(emailId)
    current.isStar = starred
    if (email.value.emailId === emailId) email.value.isStar = starred
    if (emailStore.detailMap[emailId]) emailStore.detailMap[emailId].isStar = starred
    const event = starred ? 'addStarEmailId' : 'cancelStarEmailId'
    emailStore[event] = emailId
    setTimeout(() => { if (emailStore[event] === emailId) emailStore[event] = 0 })
    if (starred) emailStore.starScroll?.addItem?.(current)
    else emailStore.starScroll?.deleteEmail([emailId])
  } catch {
    // Keep the last confirmed star state when the server rejects the operation.
  } finally { starRequesting.delete(emailId) }
}

const handleBack = () => {
  if(props.embedded)emit('close');else router.back()
}

const handleDelete = async () => {
  const emailId = email.value.emailId, delType = emailStore.contentData.delType
  if (!emailId || deleteRequesting.has(emailId)) return
  deleteRequesting.add(emailId)
  try {
    await ElMessageBox.confirm(t('delEmailConfirm'), {
      confirmButtonText: t('confirm'),
      cancelButtonText: t('cancel'),
      type: 'warning'
    })
    await (delType === 'logic' ? emailDelete : allEmailDelete)(emailId)
    delete emailStore.detailMap[emailId]
    emailStore.deleteIds = [emailId]
    ElMessage({message: t('delSuccessMsg'), type: 'success', plain: true})
    if (!readerClosed && email.value.emailId === emailId) handleBack()
  } catch {
    // Cancellation is expected; request failures are reported by the interceptor.
  } finally { deleteRequesting.delete(emailId) }
}
</script>
<style scoped lang="scss">
.box {
  height: 100%;
  overflow: hidden;
}

.header-actions {
  padding: 9px 15px 8px;
  display: flex;
  align-items: center;
  gap: 20px;
  box-shadow: var(--header-actions-border);
  font-size: 18px;
  .star {
    display: flex;
    align-items: center;
    justify-content: center;
    min-width: 21px;
  }
  .icon {
    cursor: pointer;
  }
}


.scrollbar {
  height: calc(100% - 38px);
  width: 100%;
}

.container {
  font-size: 14px;
  padding-left: 20px;
  padding-right: 20px;
  padding-top: 10px;
  @media (max-width: 1023px) {
    padding-left: 15px;
    padding-right: 15px;
  }

  .email-title {
    font-size: 20px;
    font-weight: bold;
    margin-bottom: 10px;
  }

  .htm-scrollbar {
  }

  .content {
    display: flex;
    flex-direction: column;

    .att {
      margin-top: 30px;
      margin-bottom: 30px;
      border: 1px solid var(--light-border-color);
      padding: 14px;
      border-radius: 6px;
      width: 100%;
      max-width: 600px;
      box-sizing: border-box;
      .att-box {
        min-width: 0;
        width: 100%;
        max-width: 600px;
        display: grid;
        gap: 12px;
        grid-template-rows: 1fr;
      }

      .att-title {
        margin-bottom: 8px;
        display: flex;
        justify-content: space-between;
        span:first-child {
          font-weight: bold;
        }
      }

      .att-item {
        cursor: pointer;
        div {
          align-self: center;
        }
        background: var(--light-ill);
        padding: 5px 7px;
        border-radius: 4px;
        align-self: start;
        display: grid;
        grid-template-columns: auto minmax(0,1fr) auto auto;
        .att-icon {
          display: grid;
        }

        .att-size {
          color: var(--secondary-text-color);
        }

        .att-name {
          margin-left: 8px;
          margin-right: 8px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
          word-break: break-all;
        }

        .att-image {
          width: 60px;
          height: 60px;
          object-fit: contain;
        }

        .opt-icon {
          padding-left: 10px;
          color: var(--secondary-text-color);
          align-items: center;
          display: flex;
          gap: 8px;
          cursor: pointer;
          a {
            color: var(--secondary-text-color);
            align-items: center;
            display: flex;
          }
        }
      }
    }

    .email-info {

      border-bottom: 1px solid var(--light-border-color);
      margin-bottom: 20px;
      padding-bottom: 8px;
      @media (max-width: 1024px) {
        margin-bottom: 15px;
      }
      .date {
        color: var(--regular-text-color);
        margin-bottom: 6px;
      }

      .email-msg {
        max-width: 400px;
        width: fit-content;
        margin-bottom: 15px;
      }

      .send {
        display: flex;
        margin-bottom: 6px;

        .send-name {
          color: var(--regular-text-color);
          display: flex;
          flex-wrap: wrap;
        }

        .send-name-title {
          padding-right: 5px;
        }
      }

      .receive {
        margin-bottom: 6px;
        display: flex;
        .receive-email {
          max-width: 700px;
          word-break: break-word;
        }
        span:nth-child(2) {
          color: var(--regular-text-color);
        }
      }

      .send-source {
        white-space: nowrap;
        font-weight: bold;
        padding-right: 10px;
      }

      .source {
        white-space: nowrap;
        font-weight: bold;
        padding-right: 10px;
      }
    }
  }
}

.shadow-html::after  {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: var(--message-block-color); /* 半透明黑色蒙层 */
  pointer-events: none; /* 不影响点击 */
}

.email-text {
  font-family: inherit;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}

.bottom-distance {
  margin-bottom: 30px;
}


</style>
