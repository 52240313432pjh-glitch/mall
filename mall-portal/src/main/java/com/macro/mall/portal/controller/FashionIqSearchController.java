package com.macro.mall.portal.controller;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.macro.mall.common.api.CommonResult;
import com.macro.mall.mapper.PmsProductMapper;
import com.macro.mall.model.PmsProduct;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Public Mall adapter for the local FashionIQ retrieval process. */
@RestController
@RequestMapping("/product")
public class FashionIqSearchController {
    private final PmsProductMapper productMapper;
    private final ObjectMapper objectMapper;
    private final RestTemplate retrievalClient;

    @Value("${FASHIONIQ_SERVICE_URL:http://127.0.0.1:8765}")
    private String serviceUrl;

    @Value("${FASHIONIQ_SERVICE_TOKEN:}")
    private String serviceToken;

    public FashionIqSearchController(PmsProductMapper productMapper, ObjectMapper objectMapper) {
        this.productMapper = productMapper;
        this.objectMapper = objectMapper;
        SimpleClientHttpRequestFactory factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(3000);
        factory.setReadTimeout(190000);
        this.retrievalClient = new RestTemplate(factory);
    }

    @PostMapping(value = "/visualSearch", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public CommonResult<Map<String, Object>> search(
            @RequestParam("text") String text,
            @RequestParam(value = "image", required = false) MultipartFile image,
            @RequestParam(value = "referenceProductId", required = false) Long referenceProductId,
            @RequestParam(value = "category", required = false) String category,
            @RequestParam(value = "topK", defaultValue = "12") Integer topK,
            @RequestParam(value = "mode", defaultValue = "fusion") String mode) throws IOException {
        if (text == null || text.trim().isEmpty() || text.length() > 500) {
            return CommonResult.validateFailed("请输入 1 到 500 字的修改描述");
        }
        if ((image == null || image.isEmpty()) == (referenceProductId == null)) {
            return CommonResult.validateFailed("请选择图片或参考商品");
        }
        if (topK == null || topK < 1 || topK > 50) {
            return CommonResult.validateFailed("结果数量须在 1 到 50 之间");
        }
        if (!"fusion".equals(mode)) {
            return CommonResult.validateFailed("当前仅支持三路融合检索");
        }
        if (category != null && !category.isEmpty()
                && !List.of("dress", "shirt", "toptee").contains(category)) {
            return CommonResult.validateFailed("未知 FashionIQ 分类");
        }
        if (image != null && !image.isEmpty()) {
            if (image.getSize() > 5L * 1024 * 1024
                    || !List.of("image/jpeg", "image/png", "image/webp").contains(image.getContentType())) {
                return CommonResult.validateFailed("请选择不超过 5 MB 的 JPG、PNG 或 WebP 图片");
            }
        }
        if (referenceProductId != null) {
            PmsProduct reference = productMapper.selectByPrimaryKey(referenceProductId);
            if (reference == null || !Integer.valueOf(1).equals(reference.getPublishStatus())
                    || !Integer.valueOf(0).equals(reference.getDeleteStatus())) {
                return CommonResult.validateFailed("参考商品不存在或已下架");
            }
        }

        Map<String, Object> request = new LinkedHashMap<>();
        request.put("modification", text.trim());
        request.put("top_k", topK);
        request.put("mode", mode);
        if (category != null && !category.isEmpty()) {
            request.put("category", category);
        }
        if (referenceProductId != null) {
            request.put("reference_product_id", referenceProductId);
        } else {
            request.put("image_base64", Base64.getEncoder().encodeToString(image.getBytes()));
        }
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        if (!serviceToken.isEmpty()) {
            headers.set("X-Service-Token", serviceToken);
        }
        try {
            ResponseEntity<JsonNode> response = retrievalClient.postForEntity(
                    serviceUrl + "/search", new HttpEntity<>(request, headers), JsonNode.class);
            JsonNode payload = response.getBody();
            if (payload == null || !payload.path("results").isArray()) {
                return CommonResult.failed("检索服务返回了无效结果");
            }
            List<Map<String, Object>> results = new ArrayList<>();
            for (JsonNode hit : payload.path("results")) {
                long id = hit.path("product_id").asLong(0);
                PmsProduct product = productMapper.selectByPrimaryKey(id);
                if (product == null || !Integer.valueOf(1).equals(product.getPublishStatus())
                        || !Integer.valueOf(0).equals(product.getDeleteStatus())) {
                    continue;
                }
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("product", product);
                entry.put("score", hit.path("fusion_score").asDouble());
                entry.put("branchRanks", objectMapper.convertValue(hit.path("branch_ranks"), Map.class));
                entry.put("branchSimilarities", objectMapper.convertValue(
                        hit.path("branch_similarities"), Map.class));
                results.add(entry);
            }
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("mode", payload.path("mode").asText(mode));
            data.put("targetDescription", payload.path("target_description_zh").isNull()
                    ? null : payload.path("target_description_zh").asText());
            data.put("fusionMethod", payload.path("fusion_method").asText());
            data.put("fusionWeights", objectMapper.convertValue(
                    payload.path("fusion_weights"), Map.class));
            data.put("branchTopK", payload.path("branch_top_k").asInt());
            data.put("results", results);
            return CommonResult.success(data);
        } catch (HttpStatusCodeException exc) {
            try {
                String detail = objectMapper.readTree(exc.getResponseBodyAsString()).path("error").asText();
                return CommonResult.failed(detail.isEmpty() ? "检索服务暂不可用" : detail);
            } catch (Exception ignored) {
                return CommonResult.failed("检索服务暂不可用");
            }
        } catch (Exception exc) {
            return CommonResult.failed("检索服务暂不可用，请确认本地 FashionIQ 服务已启动");
        }
    }
}
