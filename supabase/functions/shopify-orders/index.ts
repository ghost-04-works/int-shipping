// Supabase Edge Function: shopify-orders
// VERSION-MARKER: 2026-09-29-get-by-id
// ------------------------------------------------------------------
// Shopify Admin GraphQL API를 대신 호출해주는 프록시.
// 브라우저에는 Shopify 액세스 토큰을 절대 노출하지 않고,
// 이 Edge Function 안에서만 시크릿(SHOPIFY_ACCESS_TOKEN)을 사용합니다.
//
// 환경변수 (Supabase 프로젝트 설정 > Edge Functions > Secrets):
//   SHOPIFY_STORE_DOMAIN   예: geonworks.myshopify.com
//   SHOPIFY_ACCESS_TOKEN   Admin API 액세스 토큰
//   SHOPIFY_API_VERSION    예: 2024-10 (미지정 시 아래 기본값 사용)
//
// 지원 액션 (POST body의 action 필드로 구분):
//   { "action": "list", "status": "unfulfilled" }
//     -> 미발송(unfulfilled) 주문 전체 조회 (기존과 동일, 배열을 그대로 반환)
//
//   { "action": "list", "status": "fulfilled", "cursor": null }
//     -> 처리완료(fulfilled) 주문 조회. 한 번에 최대 250건씩 끊어서 반환하고
//        { orders, hasMore, nextCursor } 형태로 응답. 더 보려면 nextCursor를
//        다음 요청의 cursor로 넘기면 이어서 가져옴 (예전엔 최근 200건까지만
//        보여주고 그 이상은 볼 방법이 없었음 — 그 문제를 고침).
//
//   { "action": "search", "query": "28123", "status": "fulfilled" }
//     -> 주문번호(부분 일치)로 검색. 페이지네이션과 무관하게 과거 주문도 바로 찾을 수 있음.
//        status는 "fulfilled"(기본), "unfulfilled", 또는 "any"(취소·보관 주문 포함 전체 —
//        int-shipping "주문번호로 가액 확인"에서 사용).
//
//   { "action": "get", "orderId": "7192060100771" }
//     -> Shopify 주문 ID로 단건 조회 (검색에 안 잡히는 취소·환불·보관 주문도 조회됨). 없으면 null.
//
//   { "action": "version" } -> 배포된 함수 버전 문자열
//
//   { "action": "updateAddress", "orderId": "gid://shopify/Order/123",
//     "address": { "address1": "...", "city": "...", ... } }
//     -> 배송주소 수정
//
//   { "action": "fulfill", "orderId": "gid://shopify/Order/123",
//     "trackingNumber": "3828283311290000", "carrier": "DHL Express",
//     "notifyCustomer": false }
//     -> 발송처리 (운송장 입력 + fulfillment 생성)
// ------------------------------------------------------------------

// 배포된 버전 확인용 ({ "action": "version" }) — 위 VERSION-MARKER와 같이 올릴 것
const VERSION = "2026-09-29-get-by-id";

const STORE_DOMAIN = Deno.env.get("SHOPIFY_STORE_DOMAIN")!;
const ACCESS_TOKEN = Deno.env.get("SHOPIFY_ACCESS_TOKEN")!;
const API_VERSION = Deno.env.get("SHOPIFY_API_VERSION") ?? "2026-07";

const GRAPHQL_URL = `https://${STORE_DOMAIN}/admin/api/${API_VERSION}/graphql.json`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // 필요 시 실제 프론트 도메인으로 제한하세요
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

async function shopifyGraphQL(query: string, variables: Record<string, unknown> = {}) {
  const resp = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await resp.json();
  if (json.errors) {
    throw new Error(`Shopify GraphQL error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

// ── 1) 주문 목록 조회 / 검색 ──────────────────────────────────────
// 주문 목록/검색/단건 조회가 같이 쓰는 주문 필드 (mapOrderNode가 기대하는 모양)
const ORDER_FIELDS = `
          id
          name
          note
          tags
          createdAt
          cancelledAt
          displayFulfillmentStatus
          shippingLine { title }
          shippingAddress {
            firstName
            lastName
            address1
            address2
            city
            province
            zip
            country
            countryCodeV2
            phone
          }
          lineItems(first: 100) {
            edges {
              node {
                id
                title
                variantTitle
                sku
                quantity
                originalUnitPriceSet {
                  shopMoney { amount }
                }
                # 할인(자동 할인·할인 코드·주문 전체 할인 배분) 적용 후 고객이 실제 결제한 단가
                discountedUnitPriceAfterAllDiscountsSet {
                  shopMoney { amount }
                }
              }
            }
          }
          fulfillmentOrders(first: 5) {
            edges {
              node {
                id
                status
              }
            }
          }
`;

function buildOrdersQuery() {
  return `
  query listOrders($cursor: String, $searchQuery: String!) {
    orders(first: 50, after: $cursor, query: $searchQuery, sortKey: CREATED_AT, reverse: true) {
      edges {
        cursor
        node {
          ${ORDER_FIELDS}
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
}

// GraphQL 응답의 order 노드 -> 프론트엔드가 쓰는 평평한 객체로 변환.
// listOrders/searchOrders 둘 다 이 매핑을 그대로 재사용한다.
function mapOrderNode(node: any) {
  return {
    id: node.id,
    orderNumber: node.name,
    note: node.note,
    tags: node.tags,
    createdAt: node.createdAt,
    cancelledAt: node.cancelledAt,
    fulfillmentStatus: node.displayFulfillmentStatus,
    shippingMethod: node.shippingLine?.title ?? null,
    shippingAddress: node.shippingAddress,
    lineItems: node.lineItems.edges.map((e: any) => {
      const baseTitle = e.node.title;
      const variantTitle = e.node.variantTitle;
      const fullTitle =
        variantTitle && variantTitle !== "Default Title"
          ? `${baseTitle} - ${variantTitle}`
          : baseTitle;
      return {
        id: e.node.id,
        title: fullTitle,
        sku: e.node.sku,
        quantity: e.node.quantity,
        price: parseFloat(e.node.originalUnitPriceSet?.shopMoney?.amount ?? "0"),
        // DHL 신고 가액 비교·GMI 수출신고에 쓰는 할인 적용 단가 (Shopify 주문 화면에 보이는 결제 단가)
        discountedUnitPrice: parseFloat(
          e.node.discountedUnitPriceAfterAllDiscountsSet?.shopMoney?.amount ??
            e.node.originalUnitPriceSet?.shopMoney?.amount ??
            "0",
        ),
      };
    }),
    fulfillmentOrderIds: node.fulfillmentOrders.edges.map((e: any) => e.node.id),
  };
}

function statusToSearchQuery(status: string) {
  if (status === "any") return ""; // GraphQL orders는 조건이 없으면 취소·보관 주문까지 전부 조회
  return status === "fulfilled"
    ? "fulfillment_status:fulfilled"
    : "fulfillment_status:unfulfilled AND status:open";
}

// status: "unfulfilled"(기본, 발송대상) | "fulfilled"(처리완료 조회용)
//
// unfulfilled는 화면(발송 대상 탭들)이 "전체 목록"을 전제로 만들어져 있어서
// 예전처럼 끝까지 다 긁어와 배열로 반환한다 (최대 20페이지 = 1000건).
//
// fulfilled는 계속 쌓이기만 하고 사람이 다 볼 필요는 드물어서, 한 번 호출에
// 최대 5페이지(250건)만 가져오고 { orders, hasMore, nextCursor } 형태로 반환.
// 프론트엔드가 nextCursor를 다음 호출의 cursor로 넘기면 이어서 더 가져온다.
async function listOrders(status: string = "unfulfilled", cursor: string | null = null) {
  const searchQuery = statusToSearchQuery(status);
  const MAX_PAGES = status === "fulfilled" ? 5 : 20;

  const orders: unknown[] = [];
  let currentCursor: string | null = cursor;
  let hasNextPage = true;
  let pageCount = 0;

  while (hasNextPage && pageCount < MAX_PAGES) {
    const data = await shopifyGraphQL(buildOrdersQuery(), { cursor: currentCursor, searchQuery });
    for (const edge of data.orders.edges) {
      orders.push(mapOrderNode(edge.node));
    }
    hasNextPage = data.orders.pageInfo.hasNextPage;
    currentCursor = data.orders.pageInfo.endCursor;
    pageCount++;
  }

  if (status === "fulfilled") {
    return { orders, hasMore: hasNextPage, nextCursor: currentCursor };
  }
  return orders;
}

// 주문번호(부분 일치)로 검색 — 페이지네이션과 무관하게 바로 찾을 수 있음.
// "28123"처럼 숫자만 줘도, "#28123"처럼 줘도 동작하도록 숫자만 뽑아서 검색어를 만든다.
async function searchOrders(query: string, status: string = "fulfilled") {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const digits = trimmed.replace(/[^0-9]/g, "");
  // "#28783" 정확 일치를 먼저 넣고 부분 일치(*28783*)도 같이 찾는다 — Shopify 검색은 앞쪽 와일드카드를
  // 제대로 처리하지 못하는 경우가 있어 부분 일치만으로는 정확한 주문번호가 빠질 수 있다.
  const namePart = digits
    ? `(name:#${digits} OR name:${digits} OR name:*${digits}*)`
    : `name:*${trimmed}*`;
  const statusPart = statusToSearchQuery(status);
  if (status === "any") {
    // 조건 없는 검색에 취소·보관(closed) 주문이 안 잡히는 경우가 있어(실측: Shopify에서 취소한 #28783이
    // 조건 없이도, fulfilled/unfulfilled로도 0건) 해당 상태를 명시한 검색을 같이 돌려 합친다.
    const queries = [namePart, `${namePart} AND status:cancelled`, `${namePart} AND status:closed`];
    const byId = new Map<string, unknown>();
    for (const searchQuery of queries) {
      const data = await shopifyGraphQL(buildOrdersQuery(), { cursor: null, searchQuery });
      for (const edge of data.orders.edges) {
        if (!byId.has(edge.node.id)) byId.set(edge.node.id, mapOrderNode(edge.node));
      }
    }
    return Array.from(byId.values());
  }

  const searchQuery = `${namePart} AND ${statusPart}`;
  const data = await shopifyGraphQL(buildOrdersQuery(), { cursor: null, searchQuery });
  return data.orders.edges.map((edge: any) => mapOrderNode(edge.node));
}

// Shopify 주문 ID로 단건 조회 — 검색 결과에 안 나오는 주문(실측: 취소+환불+보관된 #28783은
// 검색 조건을 어떻게 줘도 0건)도 상태와 무관하게 가져온다. 숫자 ID("7192060100771")나 gid 둘 다 받음.
// int-shipping은 DHL 주문 상세의 "Reference #"(= Shopify 주문 ID)를 읽어 이걸 호출한다.
async function getOrder(orderId: string) {
  const id = String(orderId ?? "").trim();
  if (!id) return null;
  const gid = id.startsWith("gid://") ? id : `gid://shopify/Order/${id.replace(/[^0-9]/g, "")}`;
  const data = await shopifyGraphQL(
    `query getOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`,
    { id: gid },
  );
  return data.order ? mapOrderNode(data.order) : null;
}

// ── 2) 배송주소 수정 ─────────────────────────────────────────────
const UPDATE_ADDRESS_MUTATION = `
  mutation updateOrderAddress($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id }
      userErrors { field message }
    }
  }
`;

async function updateAddress(orderId: string, address: Record<string, unknown>) {
  // MailingAddressInput에 존재하는 필드만 골라서 전송 (조회 응답을 그대로 되돌리면
  // countryCodeV2 같은 출력 전용 필드가 섞여 들어가 422 에러가 남)
  const sanitized: Record<string, unknown> = {};
  const allowedFields = [
    "firstName",
    "lastName",
    "address1",
    "address2",
    "city",
    "province",
    "zip",
    "phone",
    "company",
  ];
  for (const key of allowedFields) {
    if (address[key] !== undefined) sanitized[key] = address[key];
  }
  // countryCodeV2(조회 필드) -> countryCode(입력 필드)로 변환
  if (address.countryCodeV2) sanitized.countryCode = address.countryCodeV2;

  const data = await shopifyGraphQL(UPDATE_ADDRESS_MUTATION, {
    input: { id: orderId, shippingAddress: sanitized },
  });
  const errors = data.orderUpdate.userErrors;
  if (errors?.length) {
    throw new Error(`주소 수정 실패: ${JSON.stringify(errors)}`);
  }
  return data.orderUpdate.order;
}

// ── 3) 발송처리 (운송장 입력 + fulfillment 생성) ───────────────────
const FULFILLMENT_ORDER_LINE_ITEMS_QUERY = `
  query getFulfillmentOrderLineItems($id: ID!) {
    fulfillmentOrder(id: $id) {
      id
      lineItems(first: 100) {
        edges {
          node {
            id
            remainingQuantity
          }
        }
      }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = `
  mutation createFulfillment($fulfillment: FulfillmentV2Input!) {
    fulfillmentCreateV2(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
        trackingInfo { number company url }
      }
      userErrors { field message }
    }
  }
`;

async function fulfillOrder(
  fulfillmentOrderId: string,
  trackingNumber: string,
  carrier: string,
  notifyCustomer: boolean,
) {
  // 해당 fulfillment order의 라인아이템/잔여수량을 먼저 조회해야
  // fulfillmentOrderLineItems에 필요한 id/quantity를 채울 수 있음
  const foData = await shopifyGraphQL(FULFILLMENT_ORDER_LINE_ITEMS_QUERY, {
    id: fulfillmentOrderId,
  });
  const lineItems = foData.fulfillmentOrder.lineItems.edges
    .map((e: any) => ({ id: e.node.id, quantity: e.node.remainingQuantity }))
    .filter((li: any) => li.quantity > 0);

  const data = await shopifyGraphQL(FULFILLMENT_CREATE_MUTATION, {
    fulfillment: {
      notifyCustomer,
      trackingInfo: {
        number: trackingNumber,
        company: carrier, // 예: "DHL Express", "우체국택배"
      },
      lineItemsByFulfillmentOrder: [
        {
          fulfillmentOrderId,
          fulfillmentOrderLineItems: lineItems,
        },
      ],
    },
  });

  const errors = data.fulfillmentCreateV2.userErrors;
  if (errors?.length) {
    throw new Error(`발송처리 실패: ${JSON.stringify(errors)}`);
  }
  return data.fulfillmentCreateV2.fulfillment;
}

// ── HTTP 핸들러 ──────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  try {
    const body = await req.json();
    const { action } = body;

    let result;
    switch (action) {
      case "list":
        result = await listOrders(body.status ?? "unfulfilled", body.cursor ?? null);
        break;

      case "get":
        result = await getOrder(body.orderId);
        break;

      case "version":
        result = VERSION;
        break;

      case "search":
        result = await searchOrders(body.query ?? "", body.status ?? "fulfilled");
        break;

      case "updateAddress":
        result = await updateAddress(body.orderId, body.address);
        break;

      case "fulfill":
        result = await fulfillOrder(
          body.fulfillmentOrderId,
          body.trackingNumber,
          body.carrier,
          body.notifyCustomer ?? true, // 기본값 true: 발송처리 시 고객에게 알림 메일 발송 (기존 방식과 동일)
        );
        break;

      default:
        return new Response(JSON.stringify({ error: `알 수 없는 action: ${action}` }), {
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
