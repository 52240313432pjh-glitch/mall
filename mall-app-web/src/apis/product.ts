import { http } from '@/utils/http'
import type { CommonPage } from '@/types/common'
import type { PmsProduct } from '@/types/product'
import type { CategoryTreeNode, ProductListParam, PmsPortalProductDetail } from '@/types/product'

/** 商品分类树 */
export const getCategoryTreeAPI = () => {
  return http<CategoryTreeNode[]>({
    method: 'GET',
    url: '/product/categoryTreeList',
  })
}

/** 商品列表搜索 */
export const searchProductListAPI = (params: ProductListParam) => {
  return http<CommonPage<PmsProduct>>({
    method: 'GET',
    url: '/product/search',
    params,
  })
}

/** 商品详情 */
export const getProductDetailAPI = (id: number) => {
  return http<PmsPortalProductDetail>({
    method: 'GET',
    url: `/product/detail/${id}`,
  })
}

/** FashionIQ 图文检索结果 */
export type VisualSearchResponse = {
  mode: 'fusion'
  targetDescription: string
  fusionMethod: 'weighted_rrf'
  fusionWeights: { reference: number; modification: number; target: number }
  branchTopK: number
  results: {
    product: PmsProduct
    score: number
    branchRanks: Partial<Record<'reference' | 'modification' | 'target', number>>
    branchSimilarities: Partial<Record<'reference' | 'modification' | 'target', number>>
  }[]
}

/** 上传参考图和修改文字，使用商城 Portal 代理检索服务。 */
export const visualSearchAPI = (
  filePath: string,
  text: string,
  category: string,
): Promise<VisualSearchResponse> => {
  return new Promise((resolve, reject) => {
    uni.uploadFile({
      url: `${import.meta.env.VITE_API_BASE_URL}/product/visualSearch`,
      filePath,
      name: 'image',
      timeout: 210000,
      formData: { text, category, mode: 'fusion', topK: '12' },
      success(response) {
        try {
          const body = JSON.parse(response.data) as { code: number; message: string; data: VisualSearchResponse }
          if (response.statusCode >= 200 && response.statusCode < 300 && body.code === 200) {
            resolve(body.data)
          } else {
            reject(new Error(body.message || '图文检索失败'))
          }
        } catch (error) {
          reject(error)
        }
      },
      fail(error) {
        reject(new Error(error.errMsg || '图文检索请求失败'))
      },
    })
  })
}
