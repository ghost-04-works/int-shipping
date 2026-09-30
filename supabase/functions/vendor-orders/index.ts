// Supabase Edge Function: vendor-orders
// VERSION-MARKER: 2026-09-30-catalog-category
// ------------------------------------------------------------------
// 벤더 주문 시스템(geon_vsale)의 DHL 발송 주문을 int-shipping "벤더 발송건" 탭에 넘겨주는 읽기 전용 함수.
// geon_vsale 테이블은 RLS로 service_role만 읽을 수 있어서 이 함수가 대신 읽는다. 아무것도 쓰지 않는다.
//
// 요청:  POST { "action": "list", "days": 90 }   // 최근 N일(기본 90) DHL 발송 주문, 취소·외부발송 제외
//        POST { "action": "version" }
// 응답:  { data: [ { id, orderNo, invoiceNo, status, createdAt, vendorName, shipTo,
//                    itemDiscountPct, shippingCost, shippingDiscountPct, creditAmount,
//                    items: [ { name, option, qty, unitPrice, individualDiscountPct, origin, category, vendorCode } ] } ] }
//        items는 인보이스와 같은 순서(벤더용 코드 자연 정렬, 코드 없는 품목은 뒤)
// ------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VERSION = "2026-09-30-catalog-category";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SB_URL, SB_SERVICE_ROLE_KEY);

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── 호출자 확인: 로그인한 @geon.works 사용자만 허용 (shopify-orders, sellmate-stock과 같은 방식) ──
const STAFF_EMAIL_DOMAIN = "geon.works";

async function isStaffRequest(req: Request): Promise<boolean> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return false;
  const resp = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: Deno.env.get("SUPABASE_ANON_KEY") ?? "" },
  });
  if (!resp.ok) return false;
  const user = await resp.json().catch(() => null);
  const email = String(user?.email ?? "").toLowerCase();
  return email.endsWith(`@${STAFF_EMAIL_DOMAIN}`);
}

// geon_vsale의 sortOrderItemsByVendorCode와 같은 정렬 (인보이스 품목 순서)
function vendorCodeOf(vc: any): string | undefined {
  if (!vc) return undefined;
  return Array.isArray(vc) ? vc[0]?.vendor_code : vc.vendor_code;
}
function one(v: any) {
  return Array.isArray(v) ? v[0] ?? null : v ?? null;
}

async function listOrders(days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("orders")
    .select(
      "id, order_no, invoice_no, status, created_at, ship_to, item_discount_pct, shipping_discount_pct, " +
        "shipping_cost_computed, shipping_cost_override, credit_amount, vendors(name), " +
        "order_items(product_name_snapshot, option_snapshot, qty, unit_price_snapshot, individual_discount_pct_snapshot, " +
        "origin_snapshot, sku_snapshot, line_status, vendor_catalog_items(vendor_code, origin, products(category)), products(category))",
    )
    .eq("shipping_method", "DHL")
    .eq("is_external_shipment", false)
    .neq("status", "취소")
    .gte("created_at", since)
    .eq("order_items.line_status", "active")
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw new Error(`벤더 주문 조회 실패: ${error.message}`);

  // 카테고리: 벤더 주문 품목은 order_items.product_id가 비어 있고 카탈로그 품목(vendor_catalog_items.product_id)으로만
  // 상품과 연결된다. 카탈로그에 없는 직접 추가 품목은 SKU(sku_snapshot = products.sku_code)로 찾는다.
  const categoryOf = (it: any) => one(one(it.vendor_catalog_items)?.products)?.category ?? one(it.products)?.category ?? null;
  const missingSkus = [
    ...new Set(
      (data ?? []).flatMap((o: any) => (o.order_items ?? []).filter((it: any) => !categoryOf(it) && it.sku_snapshot).map((it: any) => it.sku_snapshot)),
    ),
  ];
  const categoryBySku = new Map<string, string>();
  if (missingSkus.length > 0) {
    const { data: products, error: productError } = await supabase
      .from("products")
      .select("sku_code, category")
      .in("sku_code", missingSkus);
    if (productError) throw new Error(`상품 카테고리 조회 실패: ${productError.message}`);
    for (const p of products ?? []) if (p.category) categoryBySku.set(p.sku_code, p.category);
  }

  return (data ?? []).map((o: any) => {
    const items = [...(o.order_items ?? [])].sort((a: any, b: any) => {
      const av = vendorCodeOf(a.vendor_catalog_items);
      const bv = vendorCodeOf(b.vendor_catalog_items);
      if (!av && !bv) return 0;
      if (!av) return 1;
      if (!bv) return -1;
      return av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
    });
    return {
      id: o.id,
      orderNo: o.order_no,
      invoiceNo: o.invoice_no,
      status: o.status,
      createdAt: o.created_at,
      vendorName: one(o.vendors)?.name ?? null,
      shipTo: o.ship_to ?? {},
      itemDiscountPct: Number(o.item_discount_pct ?? 0),
      shippingCost: Number(o.shipping_cost_override ?? o.shipping_cost_computed ?? 0),
      shippingDiscountPct: Number(o.shipping_discount_pct ?? 0),
      creditAmount: Number(o.credit_amount ?? 0),
      items: items.map((it: any) => ({
        name: it.product_name_snapshot,
        option: it.option_snapshot,
        qty: it.qty,
        unitPrice: Number(it.unit_price_snapshot),
        individualDiscountPct: Number(it.individual_discount_pct_snapshot ?? 0),
        // 카탈로그 품목은 vendor_catalog_items.origin, 직접 추가한 품목은 origin_snapshot
        origin: it.origin_snapshot ?? one(it.vendor_catalog_items)?.origin ?? null,
        category: categoryOf(it) ?? categoryBySku.get(it.sku_snapshot) ?? null,
        vendorCode: vendorCodeOf(it.vendor_catalog_items) ?? null,
      })),
    };
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }
  if (!(await isStaffRequest(req))) {
    return new Response(JSON.stringify({ error: "@geon.works 계정 로그인이 필요합니다. 새로고침 후 다시 로그인해주세요." }), {
      status: 401,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json().catch(() => ({}));
    let result;
    if (body.action === "list") {
      const days = Math.min(Math.max(Number(body.days) || 90, 1), 365);
      result = await listOrders(days);
    } else if (body.action === "version") {
      result = VERSION;
    } else {
      return new Response(JSON.stringify({ error: `알 수 없는 action: ${body.action}` }), {
        status: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ data: result }), {
      status: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }
});
