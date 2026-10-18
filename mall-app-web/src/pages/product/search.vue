<template>
  <view class="container">
    <!-- 搜索栏 -->
    <view class="search-bar">
      <view class="search-input-wrap">
        <text class="yticon icon-sousuo"></text>
        <input
          class="search-input"
          type="text"
          v-model="keyword"
          placeholder="请输入商品 如：手机"
          placeholder-class="placeholder"
          confirm-type="search"
          :focus="true"
          @confirm="handleSearch"
        />
        <text
          v-if="keyword"
          class="yticon icon-shanchu4 clear-btn"
          @click="handleClearInput"
        ></text>
      </view>
      <text class="search-action-btn" @click="handleSearch">搜索</text>
    </view>

    <!-- FashionIQ 图文检索 -->
    <view class="visual-section">
      <text class="visual-title">图文找相似商品</text>
      <text class="visual-hint">选择一张服饰图片，再描述想改变的地方</text>
      <view class="visual-input-row">
        <view class="visual-image" @click="chooseVisualImage">
          <image v-if="visualImage" :src="visualImage" mode="aspectFill"></image>
          <text v-else>＋ 选择图片</text>
        </view>
        <textarea
          v-model="visualText"
          class="visual-textarea"
          maxlength="500"
          placeholder="例如：改成黑色，袖子更短"
        />
      </view>
      <view class="visual-controls">
        <picker :range="categoryLabels" :value="categoryIndex" @change="changeCategory">
          <text>类别：{{ categoryLabels[categoryIndex] }} ▾</text>
        </picker>
        <text>三路融合检索</text>
      </view>
      <text class="visual-hint">参考图、修改文本和目标描述分别召回，再去重加权排序</text>
      <button class="visual-button" :loading="visualLoading" :disabled="visualLoading" @click="handleVisualSearch">
        {{ visualLoading ? '正在检索…' : '图文检索' }}
      </button>
      <text v-if="visualError" class="visual-error">{{ visualError }}</text>
      <view v-if="visualResults.length" class="visual-results">
        <text class="visual-title">找到 {{ visualResults.length }} 件商品</text>
        <text v-if="targetDescription" class="visual-hint">目标描述：{{ targetDescription }}</text>
        <text v-if="fusionWeights" class="visual-hint">
          权重：参考图 {{ (fusionWeights.reference * 100).toFixed(0) }}% · 修改文本 {{ (fusionWeights.modification * 100).toFixed(0) }}% · 目标描述 {{ (fusionWeights.target * 100).toFixed(0) }}%
        </text>
        <view v-for="hit in visualResults" :key="hit.product.id" class="visual-result" @click="openVisualProduct(hit.product.id)">
          <image :src="hit.product.pic" mode="aspectFill"></image>
          <view class="visual-result-info">
            <text class="visual-result-name">{{ hit.product.name }}</text>
            <text>¥{{ hit.product.price }}</text>
            <text class="visual-hint">融合得分 {{ hit.score.toFixed(3) }}</text>
            <text class="visual-hint">三路名次：图 {{ hit.branchRanks.reference || '—' }} · 文 {{ hit.branchRanks.modification || '—' }} · 描述 {{ hit.branchRanks.target || '—' }}</text>
          </view>
        </view>
      </view>
    </view>

    <!-- 搜索历史 -->
    <view class="history-section" v-if="searchStore.historyList.length > 0">
      <view class="section-header">
        <text class="section-title">搜索历史</text>
        <text class="yticon icon-lajitong clear-icon" @click="handleClearHistory"></text>
      </view>
      <view class="history-list">
        <view
          class="history-item"
          v-for="(item, index) in searchStore.historyList"
          :key="index"
          @click="handleHistoryClick(item)"
        >
          <text class="history-text">{{ item }}</text>
          <text
            class="yticon icon-shanchu4 delete-icon"
            @click.stop="handleDeleteHistory(item)"
          ></text>
        </view>
      </view>
    </view>

    <!-- 空状态 -->
    <view class="empty-section" v-else>
      <text class="empty-text">暂无搜索记录</text>
    </view>
  </view>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { visualSearchAPI } from '@/apis/product'
import type { VisualSearchResponse } from '@/apis/product'
import { useSearchStore } from '@/stores/search'

// ===== Store 相关 =====
// 获取搜索store
const searchStore = useSearchStore()

// ===== 页面数据 =====
// 搜索关键字
const keyword = ref('')
const visualImage = ref('')
const visualText = ref('')
const visualLoading = ref(false)
const visualError = ref('')
const visualResults = ref<VisualSearchResponse['results']>([])
const targetDescription = ref<string | null>(null)
const fusionWeights = ref<VisualSearchResponse['fusionWeights'] | null>(null)
const categoryLabels = ['全部服饰', '连衣裙', '衬衫', '上衣/T恤']
const categories = ['', 'dress', 'shirt', 'toptee']
const categoryIndex = ref(0)

const chooseVisualImage = () => {
  uni.chooseImage({
    count: 1,
    sizeType: ['compressed'],
    success: ({ tempFilePaths }) => {
      visualImage.value = tempFilePaths[0]
      visualResults.value = []
      visualError.value = ''
    },
  })
}

const changeCategory = (event: any) => {
  categoryIndex.value = Number(event.detail.value)
}

const handleVisualSearch = async () => {
  if (!visualImage.value || !visualText.value.trim()) {
    visualError.value = '请先选择图片并输入修改描述'
    return
  }
  visualLoading.value = true
  visualError.value = ''
  visualResults.value = []
  try {
    const result = await visualSearchAPI(
      visualImage.value,
      visualText.value.trim(),
      categories[categoryIndex.value],
    )
    visualResults.value = result.results
    targetDescription.value = result.targetDescription
    fusionWeights.value = result.fusionWeights
    if (result.results.length === 0) visualError.value = '当前商品库没有匹配结果'
  } catch (error) {
    visualError.value = error instanceof Error ? error.message : '图文检索暂不可用'
  } finally {
    visualLoading.value = false
  }
}

const openVisualProduct = (id: number) => {
  uni.navigateTo({ url: `/pages/product/product?id=${id}` })
}

// ===== 事件处理方法 =====
// 执行搜索
const handleSearch = () => {
  const trimmed = keyword.value.trim()
  // 保存到搜索历史（仅有关键字时保存）
  if (trimmed) {
    searchStore.addKeyword(trimmed)
  }
  // 跳转到商品列表页（空关键字搜索所有商品）
  uni.navigateTo({
    url: trimmed
      ? `/pages/product/list?keyword=${encodeURIComponent(trimmed)}`
      : '/pages/product/list',
  })
}

// 点击搜索历史
const handleHistoryClick = (item: string) => {
  keyword.value = item
  searchStore.addKeyword(item)
  uni.navigateTo({
    url: `/pages/product/list?keyword=${encodeURIComponent(item)}`,
  })
}

// 清空输入框
const handleClearInput = () => {
  keyword.value = ''
}

// 取消搜索
const handleCancel = () => {
  uni.navigateBack()
}

// 清空搜索历史
const handleClearHistory = () => {
  uni.showModal({
    content: '确定清空搜索历史？',
    success: (e) => {
      if (e.confirm) {
        searchStore.clearHistory()
      }
    },
  })
}

// 删除单条搜索历史
const handleDeleteHistory = (item: string) => {
  searchStore.removeKeyword(item)
}
</script>

<style lang="scss" scoped>
.container {
  min-height: 100vh;
  background: #fff;
}

// 搜索栏
.search-bar {
  display: flex;
  align-items: center;
  padding: 20rpx 30rpx;
  background: #fff;
}

.search-input-wrap {
  flex: 1;
  display: flex;
  align-items: center;
  height: 70rpx;
  padding: 0 20rpx;
  background: #f5f5f5;
  border-radius: 35rpx;

  .icon-sousuo {
    font-size: 32rpx;
    color: #999;
    margin-right: 10rpx;
  }
}

.search-input {
  flex: 1;
  height: 70rpx;
  font-size: 28rpx;
  color: $font-color-dark;
}

.placeholder {
  color: #999;
  font-size: 28rpx;
}

.clear-btn {
  font-size: 32rpx;
  color: #ccc;
  padding: 0 10rpx;
}

.search-action-btn {
  margin-left: 20rpx;
  font-size: 28rpx;
  color: $base-color;
  white-space: nowrap;
}

// 搜索历史
.history-section {
  padding: 30rpx;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24rpx;
}

.section-title {
  font-size: 30rpx;
  font-weight: bold;
  color: $font-color-dark;
}

.clear-icon {
  font-size: 34rpx;
  color: #ccc;
}

.history-list {
  display: flex;
  flex-wrap: wrap;
}

.history-item {
  display: flex;
  align-items: center;
  max-width: 100%;
  padding: 12rpx 24rpx;
  margin: 0 20rpx 20rpx 0;
  background: #f5f5f5;
  border-radius: 30rpx;
  font-size: 26rpx;
  color: $font-color-base;
}

.history-text {
  max-width: 300rpx;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.delete-icon {
  font-size: 24rpx;
  color: #ccc;
  margin-left: 10rpx;
}

// 空状态
.empty-section {
  display: flex;
  justify-content: center;
  align-items: center;
  padding-top: 200rpx;
}

.empty-text {
  font-size: 28rpx;
  color: #ccc;
}

// 图文检索
.visual-section { padding: 28rpx 30rpx; border-top: 12rpx solid #f5f5f5; }
.visual-title { display: block; font-size: 32rpx; font-weight: 600; color: #303133; margin-bottom: 10rpx; }
.visual-hint { display: block; font-size: 24rpx; color: #909399; line-height: 1.5; }
.visual-input-row { display: flex; gap: 20rpx; margin-top: 22rpx; }
.visual-image { width: 180rpx; height: 180rpx; flex-shrink: 0; border: 2rpx dashed #ddd; border-radius: 12rpx; display: flex; align-items: center; justify-content: center; color: #999; font-size: 24rpx; overflow: hidden; }
.visual-image image { width: 100%; height: 100%; }
.visual-textarea { flex: 1; height: 180rpx; padding: 16rpx; box-sizing: border-box; background: #f7f7f7; border-radius: 12rpx; font-size: 26rpx; }
.visual-controls { display: flex; justify-content: space-between; margin: 22rpx 0; font-size: 26rpx; color: #606266; }
.visual-button { background: #fa436a; color: white; font-size: 28rpx; border-radius: 12rpx; }
.visual-error { display: block; margin-top: 18rpx; color: #d33; font-size: 25rpx; }
.visual-results { margin-top: 30rpx; }
.visual-result { display: flex; align-items: center; padding: 16rpx 0; border-bottom: 1rpx solid #eee; }
.visual-result image { width: 130rpx; height: 150rpx; flex-shrink: 0; border-radius: 8rpx; }
.visual-result-info { display: flex; flex-direction: column; gap: 12rpx; margin-left: 20rpx; font-size: 26rpx; color: #303133; }
.visual-result-name { max-width: 470rpx; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
