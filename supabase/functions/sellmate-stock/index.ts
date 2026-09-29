// Supabase Edge Function: sellmate-stock
// VERSION-MARKER: 2026-08-04-optional-order-id
// ------------------------------------------------------------------
// Shopify 출고 품목(SKU + 수량)을 받아서:
//   1) Supabase products 테이블에서 sku_code -> barcode 매칭
//   2) 셀메이트 API 인증 토큰 발급
//   3) POST /stockHistories 로 실제 재고차감 (work_type_id=8: 발송및출고)
//
// 환경변수 (Supabase 프로젝트 설정 > Edge Functions > Secrets):
//   SELLMATE_DOMAIN
//   SELLMATE_CLIENT_ID
//   SELLMATE_CLIENT_SECRET
//   (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY는 모든 Supabase 프로젝트에
//    기본 제공되는 예약 환경변수라 별도 설정 불필요)
//
// 요청 형식:
//   POST { "action": "deduct",
//          "warehouseId": 1,
//          "items": [ { "sku": "GA000E-01", "quantity": 2 }, ... ],
//          "workTypeId": 8,      // 선택, 기본값 8 (발송및출고)
//          "inputTypeId": 2,     // 선택, 기본값 2 (개별)
//          "note": "Shopify #28338"  // 선택, work_note에 기록
//          "orderId": "gid://shopify/Order/123",  // 선택 — 있으면 중복처리 방지(같은
//                                                  // orderId로 다시 호출 시 409) 대상이 됨.
//                                                  // 특정 주문과 무관한 수동 차감이면 생략.
//          "orderNumber": "#28338"  // orderId를 줄 때만 의미 있음(중복방지 기록용)
//        }
//   POST { "action": "lookupProducts", "skus": ["ABC123", ...] }
//   POST { "action": "checkProcessed", "orderIds": ["gid://shopify/Order/123", ...] }
//   POST { "action": "searchProducts", "query": "키보드" }   // 품목명 또는 SKU 부분일치 검색
//
// 응답 형식:
//   deduct:
//     { "unmatchedSkus": ["ABC123"], "sellmate": { success: [...], errors: [...], message: "..." } }
//   lookupProducts:
//     { "ABC123": { barcode, originCode, productName } }
//   checkProcessed:
//     { "gid://shopify/Order/123": { orderNumber, warehouseId, processedAt } }  // 처리된 건만 포함
//   searchProducts:
//     [ { skuCode, barcode, originCode, productName, option }, ... ]  // 최대 20건
// ------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SELLMATE_DOMAIN = Deno.env.get("SELLMATE_DOMAIN")!;
const SELLMATE_CLIENT_ID = Deno.env.get("SELLMATE_CLIENT_ID")!;
const SELLMATE_CLIENT_SECRET = Deno.env.get("SELLMATE_CLIENT_SECRET")!;
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SELLMATE_BASE_URL = `https://c-api.sellmate.co.kr/external/${SELLMATE_DOMAIN}`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(SB_URL, SB_SERVICE_ROLE_KEY);

// ── 0) 중복처리 방지: 이미 처리된 주문인지 확인 후 먼저 기록 시도 ──
async function claimOrderForProcessing(orderId: string, orderNumber: string, warehouseId: number) {
  const { error } = await supabase
    .from("processed_shipments")
    .insert({ order_id: orderId, order_number: orderNumber, warehouse_id: warehouseId });

  if (error) {
    // unique 제약 위반(23505) = 이미 처리된 주문
    if (error.code === "23505") {
      return { alreadyProcessed: true };
    }
    throw new Error(`중복확인 처리 실패: ${error.message}`);
  }
  return { alreadyProcessed: false };
}

// ── 0-1) 재고차감 처리 여부 일괄 조회 (처리완료 탭에서 상태 표시용) ──
async function checkProcessed(orderIds: string[]) {
  const uniqueIds = [...new Set(orderIds.filter(Boolean))];
  if (uniqueIds.length === 0) return {};

  const { data, error } = await supabase
    .from("processed_shipments")
    .select("*")
    .in("order_id", uniqueIds);

  if (error) {
    throw new Error(`Supabase processed_shipments 조회 실패: ${error.message}`);
  }

  const result: Record<string, { orderNumber: string | null; warehouseId: number | null; processedAt: string | null }> = {};
  for (const row of data ?? []) {
    result[row.order_id] = {
      orderNumber: row.order_number ?? null,
      warehouseId: row.warehouse_id ?? null,
      // created_at 컬럼이 없는 스키마일 수도 있어 있으면 쓰고 없으면 null
      processedAt: row.created_at ?? null,
    };
  }
  return result;
}

// ── 2-2) 동반출고 SKU 조회 (구매 SKU가 나갈 때 같이 나가야 하는 SKU) ──
async function resolveCompanions(skus: string[]) {
  const uniqueSkus = [...new Set(skus.filter(Boolean))];
  const { data, error } = await supabase
    .from("sku_companions")
    .select("parent_sku_code, companion_sku_code, qty_per_unit")
    .in("parent_sku_code", uniqueSkus);

  if (error) {
    throw new Error(`Supabase sku_companions 조회 실패: ${error.message}`);
  }

  const map = new Map<string, { sku: string; qtyPerUnit: number }[]>();
  for (const row of data ?? []) {
    const list = map.get(row.parent_sku_code) ?? [];
    list.push({ sku: row.companion_sku_code, qtyPerUnit: row.qty_per_unit });
    map.set(row.parent_sku_code, list);
  }
  return map;
}

// ── 1) 셀메이트 토큰 발급 ────────────────────────────────────────
async function getSellmateToken(): Promise<string> {
  const resp = await fetch(`${SELLMATE_BASE_URL}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: SELLMATE_CLIENT_ID,
      client_secret: SELLMATE_CLIENT_SECRET,
    }),
  });
  if (!resp.ok) {
    throw new Error(`셀메이트 토큰 발급 실패: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  return data.access_token;
}

// ── 2) SKU -> barcode 매칭 (Supabase products 테이블) ────────────
async function resolveBarcodes(skus: string[]) {
  const uniqueSkus = [...new Set(skus.filter(Boolean))];
  const { data, error } = await supabase
    .from("products")
    .select("sku_code, barcode")
    .in("sku_code", uniqueSkus);

  if (error) {
    throw new Error(`Supabase products 조회 실패: ${error.message}`);
  }

  const skuToBarcode = new Map<string, string>();
  for (const row of data ?? []) {
    if (row.barcode) skuToBarcode.set(row.sku_code, row.barcode);
  }

  const unmatchedSkus = uniqueSkus.filter((sku) => !skuToBarcode.has(sku));
  return { skuToBarcode, unmatchedSkus };
}

// ── 2-1) SKU -> barcode + origin_code + product_name 조회 (GMI 수출신고용) ──
async function lookupProducts(skus: string[]) {
  const uniqueSkus = [...new Set(skus.filter(Boolean))];
  const { data, error } = await supabase
    .from("products")
    .select("sku_code, barcode, origin_code, product_name")
    .in("sku_code", uniqueSkus);

  if (error) {
    throw new Error(`Supabase products 조회 실패: ${error.message}`);
  }

  const result: Record<string, { barcode: string | null; originCode: string | null; productName: string | null }> = {};
  for (const row of data ?? []) {
    result[row.sku_code] = {
      barcode: row.barcode ?? null,
      originCode: row.origin_code ?? null,
      productName: row.product_name ?? null,
    };
  }
  return result;
}

// ── 2-3) 품목명/SKU로 상품 검색 (재고차감 확인 모달에서 SKU 모를 때 찾기용) ──
async function searchProducts(query: string) {
  const q = query.trim();
  if (!q) return [];
  const pattern = `%${q}%`;

  // .or() 필터 문자열에 검색어를 직접 끼워넣으면 콤마 등이 필터 구문을 깨뜨릴 수 있어서,
  // 품목명/SKU 두 번 따로 조회한 뒤 합친다.
  const SELECT_COLS = "sku_code, barcode, origin_code, product_name, option";
  const [byName, bySku] = await Promise.all([
    supabase.from("products").select(SELECT_COLS).ilike("product_name", pattern).limit(20),
    supabase.from("products").select(SELECT_COLS).ilike("sku_code", pattern).limit(20),
  ]);

  if (byName.error) throw new Error(`Supabase products 검색 실패(품목명): ${byName.error.message}`);
  if (bySku.error) throw new Error(`Supabase products 검색 실패(SKU): ${bySku.error.message}`);

  const merged = new Map<
    string,
    { sku_code: string; barcode: string | null; origin_code: string | null; product_name: string | null; option: string | null }
  >();
  for (const row of [...(byName.data ?? []), ...(bySku.data ?? [])]) {
    merged.set(row.sku_code, row);
  }

  // 품목명 두 개를 따로 조회해 합친 거라 순서가 뒤섞여 있음 — 품목명 -> 옵션 순으로
  // 한 번에 정렬해야 같은 품목의 옵션들이 나란히, 보기 좋게 묶여서 나온다.
  const sorted = [...merged.values()].sort((a, b) => {
    const nameCompare = (a.product_name || "").localeCompare(b.product_name || "", "ko");
    if (nameCompare !== 0) return nameCompare;
    return (a.option || "").localeCompare(b.option || "", "ko");
  });

  return sorted.slice(0, 20).map((row) => ({
    skuCode: row.sku_code,
    barcode: row.barcode ?? null,
    originCode: row.origin_code ?? null,
    productName: row.product_name ?? null,
    option: row.option ?? null,
  }));
}

// ── 3) 셀메이트 재고차감 (POST /stockHistories) ──────────────────
async function deductStock(
  token: string,
  items: { barcode1: string; qty: number }[],
  warehouseId: number,
  workTypeId: number,
  inputTypeId: number,
  note: string,
) {
  const payload = {
    item_count: items.length,
    type: 2, // 출고
    items: items.map((it) => ({
      barcode1: it.barcode1,
      qty: it.qty,
      warehouse_id: warehouseId,
      work_type_id: workTypeId,
      input_type_id: inputTypeId,
      work_note: note,
    })),
  };

  const resp = await fetch(`${SELLMATE_BASE_URL}/stockHistories`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
  });

  const result = await resp.json();
  if (!resp.ok) {
    throw new Error(`셀메이트 재고차감 실패: ${resp.status} ${JSON.stringify(result)}`);
  }
  return result;
}

// ── HTTP 핸들러 ──────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const { action } = body;

    if (action === "lookupProducts") {
      const result = await lookupProducts(body.skus || []);
      return new Response(JSON.stringify({ data: result }), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (action === "checkProcessed") {
      const result = await checkProcessed(body.orderIds || []);
      return new Response(JSON.stringify({ data: result }), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (action === "searchProducts") {
      const result = await searchProducts(body.query || "");
      return new Response(JSON.stringify({ data: result }), {
        status: 200,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    if (action !== "deduct") {
      return new Response(JSON.stringify({ error: `알 수 없는 action: ${action}` }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    const {
      items,
      warehouseId,
      workTypeId = 21, // 오프라인출고 (8번 발송및출고는 order_id/invoice_no 필수라 주문 흐름과 묶이므로 사용 불가)
      inputTypeId = 2, // 개별
      note = "",
      orderId, // Shopify 주문 GID — 있으면 중복처리 방지 키로 쓰임 (없으면 특정 주문과 무관한 수동 차감으로 간주)
      orderNumber = "",
    } = body;

    if (!Array.isArray(items) || items.length === 0) {
      return new Response(JSON.stringify({ error: "items 배열이 필요합니다." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    if (!warehouseId) {
      return new Response(JSON.stringify({ error: "warehouseId가 필요합니다." }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }

    // 0) 중복처리 방지 — orderId가 있을 때만 적용된다. 특정 주문과 연결되지 않은 수동
    // 차감(예: 샘플 발송, 재고 보정)은 orderId 없이 호출해 이 체크를 건너뛸 수 있다.
    if (orderId) {
      const claim = await claimOrderForProcessing(orderId, orderNumber, warehouseId);
      if (claim.alreadyProcessed) {
        return new Response(
          JSON.stringify({ error: `이미 처리된 주문입니다 (${orderNumber || orderId}). 재고차감을 건너뜁니다.` }),
          { status: 409, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
        );
      }
    }

    // 1) 동반출고 SKU 확장 — 구매 SKU 외에 같이 나가야 하는 SKU를 목록에 추가
    const purchasedSkus = items.map((i: { sku: string }) => i.sku).filter(Boolean);
    const companionMap = await resolveCompanions(purchasedSkus);

    const expandedItems: { sku: string; quantity: number }[] = [...items];
    for (const item of items as { sku: string; quantity: number }[]) {
      const companions = companionMap.get(item.sku);
      if (companions) {
        for (const c of companions) {
          expandedItems.push({ sku: c.sku, quantity: item.quantity * c.qtyPerUnit });
        }
      }
    }

    // 2) SKU -> barcode 매칭 (구매 SKU + 동반출고 SKU 전부 포함)
    const skus = expandedItems.map((i) => i.sku);
    const { skuToBarcode, unmatchedSkus } = await resolveBarcodes(skus);

    // 매칭 안 된 SKU는 제외하고 진행 (unmatchedSkus는 응답에 포함해 사람이 확인)
    const stockItems = expandedItems
      .filter((i) => skuToBarcode.has(i.sku))
      .map((i) => ({
        barcode1: skuToBarcode.get(i.sku)!,
        qty: i.quantity,
      }));

    let sellmateResult = null;
    if (stockItems.length > 0) {
      const token = await getSellmateToken();
      sellmateResult = await deductStock(
        token,
        stockItems,
        warehouseId,
        workTypeId,
        inputTypeId,
        note,
      );
    }

    return new Response(
      JSON.stringify({ data: { unmatchedSkus, sellmate: sellmateResult } }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
