// app2.dhlexpresscommerce.com/orders 에 주입.
// 처리 대상 주문번호에 해당하는 행의 체크박스를 자동으로 체크하고,
// 페이지네이션(Telerik/Kendo Blazor Grid, 50개씩)을 넘기며 반복한 뒤
// 상단 "Actions" 드롭다운 → "Print shipping labels"를 클릭한다.
//
// 라벨 출력 전에 신고 가액(Unit Price)을 바꿔야 하는 주문이 있으면(int-shipping의 "DHL 신고 가액
// 확인"에서 넘어온 dhlPriceQueue), 먼저 주문마다 상세 화면(/orders/<탭>/<id>)을 열어 Items 표의
// Unit Price를 고치고 Save → 새로고침해서 값이 실제로 저장됐는지 확인한 뒤 목록으로 돌아온다.
// 상세 화면 이동은 전체 페이지 로드라 이 스크립트가 매번 새로 실행되므로, 진행 상태는
// chrome.storage.local(dhlPriceQueue / dhlPriceCurrent)에 두고 이어받는다.
// 가액 수정이 하나라도 실패하면 잘못된 가액으로 라벨이 나가지 않도록 라벨 출력 없이 중단한다.
//
// 가액 읽기 전용 작업(dhlReadQueue)도 있다: int-shipping이 라벨 출력 전에 DHL에 들어가 있는 단가를
// Shopify와 비교할 수 있도록, 같은 방식으로 주문마다 상세 화면을 열어 Items 표(품목명/SKU/수량/단가)를
// 읽어 dhlReadResults에 모으고, 다 읽으면 READ_DONE으로 돌려준다(아무것도 수정하지 않음).
//
// 2026-07-31 실제 DOM 확인 완료 (개발자도구 기준):
const SELECTORS = {
  tableRow: "tr.k-table-row.k-master-row", // 헤더 등 다른 tr.k-table-row와 구분하기 위해 k-master-row까지 포함
  rowOrderNumber: "a.order-number", // 예: <a class="... order-number">#28355</a>
  rowCheckbox: 'input[type="checkbox"].k-checkbox',
  nextPageButton: 'button[title="Go to the next page"]', // 비활성화 시 class에 k-disabled 포함
  loadingIndicator: '[class*="k-loading"], [class*="k-i-loading"]',
  bulkActionsButton: "button.button-bulk-actions", // "1 selected" 옆의 "Actions" 드롭다운 버튼
  // 주문 상세 화면 (2026-09-29 저장된 HTML 기준: dhl_docs/DHL Express Commerce.html)
  itemsGrid: ".ssit-order-detail-grid.order-items",
  itemsGridHeaderCell: "thead th[data-col-index]",
  itemsGridRow: "tbody tr.k-master-row",
  saveButton: "button.btn-order-save",
  itemEditButton: "button.grid-button-edit", // Items 행 오른쪽 연필 버튼 → Item details 창
  itemModal: ".blazored-modal.order-item-create-modal",
  sectionToggle: ".items-display-toggle", // 주문 상세 각 영역(Items 등) 제목 옆 펼치기/접기(∨/∧) 버튼
  orderDescItem: ".ssit-order-desc-item", // "Reference # 7192060100771" 등 주문 상단 정보
};

const DHL_ORDERS_URL = "https://app2.dhlexpresscommerce.com/orders";
// Items 표 헤더의 data-text 값 — 컬럼 순서는 사용자가 바꿀 수 있어서 인덱스 대신 헤더 이름으로 찾는다
const ITEMS_COLUMN_TEXT = {
  sku: "SKU",
  unitPrice: "Unit Price", // 실제 값은 "Unit Price (USD)"
  ship: "Ship",
};
const PRICE_MAX_ATTEMPTS = 2; // 저장 후 확인했을 때 값이 안 바뀌어 있으면 한 번 더 시도

const BUTTON_TEXT = {
  printLabels: "Print shipping labels", // Actions 드롭다운 안의 메뉴 항목
};

const MAX_PAGES = 50; // 무한 루프 방지용 안전장치

main().catch((err) => {
  console.error("[DHL 자동화] content-orders 실행 오류", err);
  chrome.runtime.sendMessage({
    type: "ORDERS_DONE",
    success: false,
    error: String(err?.message ?? err),
  });
});

async function main() {
  if (isOrderDetailPage()) {
    await runOnDetailPage();
    return;
  }

  const { dhlPriceQueue = [], dhlPriceCurrent = null, dhlReadQueue = [], dhlReadCurrent = null } =
    await storageGet(["dhlPriceQueue", "dhlPriceCurrent", "dhlReadQueue", "dhlReadCurrent"]);
  if (dhlReadCurrent) {
    throw new Error(`${dhlReadCurrent.orderNumber} 가액을 읽는 중에 목록으로 돌아왔습니다. 다시 시도해주세요.`);
  }
  if (dhlReadQueue.length > 0) {
    await openNextReadOrder(dhlReadQueue);
    return;
  }
  if (dhlPriceCurrent) {
    // 상세 화면에서 처리 중이던 주문이 끝나지 않은 채 목록으로 돌아온 경우 — 저장이 됐는지 알 수 없으니 중단
    throw new Error(`${dhlPriceCurrent.orderNumber} 가액 수정이 끝나지 않은 채 목록으로 돌아왔습니다. DHL에서 직접 확인해주세요.`);
  }
  if (dhlPriceQueue.length > 0) {
    await openNextPriceOrder(dhlPriceQueue);
    return;
  }
  const { dhlPriceOnly = false } = await storageGet(["dhlPriceOnly"]);
  if (dhlPriceOnly) {
    // 가액만 수정하는 작업 — 라벨 출력 없이 끝낸다
    chrome.runtime.sendMessage({ type: "PRICES_ONLY_DONE" });
    return;
  }

  const targetOrderNumbers = await getTargetOrderNumbers();
  if (targetOrderNumbers.length === 0) {
    // 자동화 작업 없이 DHL 주문 목록을 연 경우(직접 열었거나 작업이 끝난 탭을 새로고침) — 정상 상황이라
    // warn으로 남기면 chrome://extensions "오류" 목록에 떠서 오류처럼 보이므로 일반 로그로만 남긴다.
    console.log("[DHL 자동화] 진행 중인 자동화 작업이 없어 아무것도 하지 않습니다.");
    return;
  }

  const remaining = new Set(targetOrderNumbers);
  const total = targetOrderNumbers.length;

  await waitForRowsStable();

  for (let page = 0; page < MAX_PAGES; page++) {
    processCurrentPage(remaining);
    reportProgress(total - remaining.size, total);

    if (remaining.size === 0) break;

    const wentToNextPage = await goToNextPageIfNeeded();
    if (!wentToNextPage) break;
  }

  if (remaining.size > 0) {
    console.warn(
      "[DHL 자동화] 다음 주문번호를 찾지 못했습니다:",
      Array.from(remaining)
    );
  }

  const printed = await clickPrintShippingLabels(total);
  if (!printed.ok) {
    chrome.runtime.sendMessage({
      type: "ORDERS_DONE",
      success: false,
      error: printed.error,
      notFound: Array.from(remaining),
    });
    return;
  }

  chrome.runtime.sendMessage({
    type: "ORDERS_DONE",
    success: true,
    notFound: Array.from(remaining),
    labelDownloadConfirmed: printed.labelDownloadConfirmed,
  });
}

// 체크된 행이 있으면 상단에 "Actions" 드롭다운(bulkActionsButton)이 나타난다.
// 그걸 먼저 열고, 그 안의 "Print shipping labels" 메뉴 항목을 클릭해야 한다.
//
// 클릭 후 바로 PDF가 나오지 않고 "Generating N shipping label(s)..." 처리가 끝난 뒤에야
// 실제 다운로드가 트리거된다(비동기). content-orders-hook.js(MAIN world)가 그 다운로드
// 트리거 순간을 감지해 postMessage로 알려주므로, 그 신호를 받을 때까지 기다린 뒤에야
// "완료"로 보고한다 — 그래야 background.js가 라벨 생성이 끝나기도 전에 /reports로
// 탭을 이동시켜서 다운로드가 아예 시작도 못 하는 문제를 막을 수 있다.
async function clickPrintShippingLabels(orderCount = 1) {
  const actionsBtn = document.querySelector(SELECTORS.bulkActionsButton);
  if (!actionsBtn) {
    return { ok: false, error: '"Actions" 버튼을 찾지 못했습니다. (체크된 행이 없을 수 있음)' };
  }
  actionsBtn.click();
  await sleep(300); // 드롭다운 메뉴 렌더링 대기

  const menuItem = findButtonByText(BUTTON_TEXT.printLabels);
  if (!menuItem) {
    return { ok: false, error: `"${BUTTON_TEXT.printLabels}" 메뉴 항목을 찾지 못했습니다.` };
  }

  // 실측: 3건 기준 라벨 생성에 약 3초 소요(주문당 약 1초) — 여유를 두고 주문 수에 비례해 대기
  const timeout = Math.min(180000, 15000 + orderCount * 3000);
  const downloadPromise = waitForFileDownloadTriggered({ timeout });
  menuItem.click();
  const triggered = await downloadPromise;

  return { ok: true, labelDownloadConfirmed: !!triggered };
}

// content-orders-hook.js가 보내는 "실제 다운로드가 트리거됨" 신호를 기다린다.
// 신호에는 캡처된 파일(base64)이 들어있어 그대로 background.js에 넘겨 조용히 저장한다.
// 타임아웃이 지나도 신호가 없으면 그냥 진행은 하되 labelDownloadConfirmed:false로 알린다.
function waitForFileDownloadTriggered({ timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      window.removeEventListener("message", onMessage);
      resolve(null);
    }, timeout);

    function onMessage(event) {
      if (event.source !== window) return;
      if (event.data?.type !== "__DHL_FILE_DOWNLOAD_TRIGGERED__") return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      chrome.runtime.sendMessage({
        type: "SAVE_FILE",
        file: {
          base64: event.data.base64,
          filename: event.data.filename,
          mimeType: event.data.mimeType,
        },
      });
      resolve(event.data);
    }

    window.addEventListener("message", onMessage);
  });
}

// ── 신고 가액(Unit Price) 수정 ─────────────────────────────────────

function isOrderDetailPage() {
  return /^\/orders\/[^/]+\/\d+/.test(location.pathname);
}

// 목록에서 다음 가액 수정 대상 주문을 찾아 상세 화면으로 이동한다.
async function openNextPriceOrder(queue) {
  const [current, ...rest] = queue;
  const link = await findOrderLinkAcrossPages(current.orderNumber);
  if (!link) {
    throw new Error(`가액 수정 대상 ${current.orderNumber}을(를) DHL 주문 목록에서 찾지 못했습니다. (${describeLastScan()})`);
  }

  await storageSet({
    dhlPriceQueue: rest,
    dhlPriceCurrent: { ...current, stage: "edit", attempts: 0 },
  });
  await openOrderDetail(link, current.orderNumber);
}

// 가액 읽기: 목록에서 못 찾은 주문(DHL에 아직 없거나 다른 탭에 있음)은 notFound로 기록하고 넘어간다 —
// int-shipping 비교 화면에서 사람이 보고 판단하도록.
async function openNextReadOrder(queue) {
  const [orderNumber, ...rest] = queue;
  const link = await findOrderLinkAcrossPages(orderNumber);
  if (!link) {
    await recordReadResult(orderNumber, { notFound: true, scan: describeLastScan() }, rest);
    if (rest.length > 0) {
      location.assign(DHL_ORDERS_URL);
    } else {
      await finishRead();
    }
    return;
  }
  await storageSet({ dhlReadQueue: rest, dhlReadCurrent: { orderNumber } });
  await openOrderDetail(link, orderNumber);
}

// 못 찾았을 때 원인을 볼 수 있게 마지막 탐색 기록을 남긴다(몇 페이지, 몇 건, 처음/마지막 주문번호).
let lastScan = null;

async function findOrderLinkAcrossPages(orderNumber) {
  await waitForRowsStable();
  const scan = { pages: 0, rows: 0, first: null, last: null };
  lastScan = scan;
  for (let page = 0; page < MAX_PAGES; page++) {
    const seen = orderNumbersOnPage();
    scan.pages++;
    scan.rows += seen.length;
    scan.first ??= seen[0] ?? null;
    scan.last = seen[seen.length - 1] ?? scan.last;
    const link = findOrderLink(orderNumber);
    if (link) return link;
    if (!(await goToNextPageIfNeeded())) break;
  }
  return null;
}

function describeLastScan() {
  if (!lastScan) return "";
  const range = lastScan.first ? ` (${lastScan.first} ~ ${lastScan.last})` : "";
  return `목록 ${lastScan.pages}페이지, 주문 ${lastScan.rows}건 확인${range}`;
}

async function openOrderDetail(link, orderNumber) {
  const href = link.getAttribute("href");
  if (href && !href.startsWith("#") && !href.startsWith("javascript")) {
    location.assign(new URL(href, location.href).href); // 전체 로드 → 이 스크립트가 상세 화면에서 다시 실행됨
    return;
  }
  // href가 없는 SPA 링크면 클릭 후 같은 스크립트에서 이어서 처리
  link.click();
  const start = Date.now();
  while (!isOrderDetailPage() && Date.now() - start < 15000) await sleep(300);
  if (!isOrderDetailPage()) throw new Error(`${orderNumber} 상세 화면으로 이동하지 못했습니다.`);
  await runOnDetailPage();
}

async function runOnDetailPage() {
  const { dhlReadCurrent } = await storageGet(["dhlReadCurrent"]);
  if (dhlReadCurrent) {
    await runPriceReadOnDetailPage(dhlReadCurrent);
    return;
  }
  await runPriceEditOnDetailPage();
}

async function runPriceReadOnDetailPage(current) {
  const grid = await waitForItemsGrid();
  if (!pageShowsOrderNumber(current.orderNumber)) {
    throw new Error(`열린 상세 화면이 ${current.orderNumber} 주문이 아닙니다.`);
  }
  const rows = readItemRows(grid).map(({ name, sku, qty, unitPrice }) => ({ name, sku, qty, unitPrice }));
  const reference = readOrderReference();
  const { dhlReadQueue = [] } = await storageGet(["dhlReadQueue"]);
  await recordReadResult(current.orderNumber, { rows, reference }, dhlReadQueue);
  await storageSet({ dhlReadCurrent: null });
  if (dhlReadQueue.length > 0) {
    location.assign(DHL_ORDERS_URL);
  } else {
    await finishRead();
  }
}

// 주문 상세 상단의 "Reference # 7192060100771" — Shopify에서 들어온 주문이면 Shopify 주문 ID다.
// int-shipping이 Shopify 검색에 안 잡히는 주문(취소·환불·보관)을 이 ID로 직접 조회하는 데 쓴다.
function readOrderReference() {
  for (const el of document.querySelectorAll(SELECTORS.orderDescItem)) {
    const text = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const m = text.match(/^Reference\s*#\s*(\d+)/i);
    if (m) return m[1];
  }
  return null;
}

async function recordReadResult(orderNumber, result, remainingQueue) {
  const { dhlReadResults = {} } = await storageGet(["dhlReadResults"]);
  dhlReadResults[orderNumber] = result;
  await storageSet({ dhlReadResults, dhlReadQueue: remainingQueue });
  chrome.runtime.sendMessage({ type: "READ_PROGRESS", orderNumber, remaining: remainingQueue.length });
}

async function finishRead() {
  const { dhlReadResults = {} } = await storageGet(["dhlReadResults"]);
  chrome.runtime.sendMessage({ type: "READ_DONE", results: dhlReadResults });
}

function findOrderLink(orderNumber) {
  for (const row of document.querySelectorAll(SELECTORS.tableRow)) {
    const link = row.querySelector(SELECTORS.rowOrderNumber);
    if (link?.textContent?.trim() === orderNumber) return link;
  }
  return null;
}

async function runPriceEditOnDetailPage() {
  const { dhlPriceCurrent: current } = await storageGet(["dhlPriceCurrent"]);
  if (!current) return; // 자동화 중이 아닐 때 사용자가 직접 연 상세 화면 — 아무것도 하지 않음

  const grid = await ensureItemsEditable(await waitForItemsGrid());
  if (!pageShowsOrderNumber(current.orderNumber)) {
    throw new Error(`열린 상세 화면이 ${current.orderNumber} 주문이 아닙니다.`);
  }

  const assignments = matchItemsToRows(grid, current.items);

  if (current.stage === "verify") {
    const mismatches = assignments.filter(
      ({ priceInput, item }) => !samePrice(priceInput.value, item.unitPrice)
    );
    if (mismatches.length === 0) {
      await storageSet({ dhlPriceCurrent: null });
      const { dhlPriceQueue = [] } = await storageGet(["dhlPriceQueue"]);
      chrome.runtime.sendMessage({
        type: "PRICES_PROGRESS",
        orderNumber: current.orderNumber,
        remaining: dhlPriceQueue.length,
      });
      location.assign(DHL_ORDERS_URL);
      return;
    }
    if (current.attempts + 1 >= PRICE_MAX_ATTEMPTS) {
      const detail = mismatches
        .map(({ priceInput, item }) => `${item.sku || item.title}: ${priceInput.value} (목표 ${formatPrice(item.unitPrice)})`)
        .join(", ");
      throw new Error(`${current.orderNumber} 가액이 저장되지 않았습니다 — ${detail}`);
    }
    await storageSet({ dhlPriceCurrent: { ...current, stage: "edit", attempts: current.attempts + 1 } });
    // 아래 edit 단계로 계속 진행 (재시도)
  }

  for (const { priceInput, rowEl, item } of assignments) {
    if (priceInput) {
      setInputValue(priceInput, formatPrice(item.unitPrice));
      await sleep(150);
    } else {
      await editPriceViaItemModal(rowEl, formatPrice(item.unitPrice), item);
    }
  }
  await sleep(500);

  const saveBtn = document.querySelector(SELECTORS.saveButton);
  if (!saveBtn) throw new Error(`${current.orderNumber} 상세 화면에서 Save 버튼을 찾지 못했습니다.`);

  const latest = (await storageGet(["dhlPriceCurrent"])).dhlPriceCurrent;
  await storageSet({ dhlPriceCurrent: { ...latest, stage: "verify" } });
  saveBtn.click();
  await waitForSaveSettled();
  location.reload(); // 새로고침한 화면에서 값이 실제로 저장됐는지 확인
}

// Items 표가 뜨고 행 안의 입력칸 값(품목명/SKU/단가)까지 채워질 때까지 기다린다.
// 표 구조와 "of N" 수량 글자는 먼저 그려지고 입력칸 값은 조금 뒤에 채워져서, 표가 보이자마자 읽으면
// 품목명·SKU·단가가 전부 빈 값으로 읽힌다(실측: #28783 7개 품목이 모두 "DHL에 없음" + 빈 DHL 행 7개).
// 값이 끝내 안 채워지면 페이지를 한 번 새로고침해서 다시 시도하고, 그래도 안 되면 중단한다.
async function waitForItemsGrid({ timeout = 20000 } = {}) {
  const reloadKey = `dhlGridReloaded:${location.pathname}`;
  const start = Date.now();
  let lastSnapshot = "";
  let stableSince = 0;
  while (Date.now() - start < timeout) {
    const grid = pickItemsGrid();
    if (grid && grid.querySelector(SELECTORS.itemsGridRow)) {
      const rows = readItemRows(grid);
      const filled = rows.length > 0 && rows.every((r) => (r.name || r.sku) && r.unitPrice !== null);
      const snapshot = rows.map((r) => `${r.sku}|${r.name}|${r.unitPrice}`).join(";");
      if (filled) {
        if (snapshot !== lastSnapshot) {
          lastSnapshot = snapshot;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 600) {
          sessionStorage.removeItem(reloadKey);
          return grid;
        }
      }
    }
    await sleep(300);
  }
  if (!sessionStorage.getItem(reloadKey)) {
    sessionStorage.setItem(reloadKey, "1");
    location.reload();
    return new Promise(() => {}); // 새로고침되면 스크립트가 처음부터 다시 실행됨
  }
  sessionStorage.removeItem(reloadKey);
  throw new Error("주문 상세 화면의 Items 표 값(품목명/SKU/단가)이 채워지지 않았습니다. 다시 시도해주세요.");
}

function pageShowsOrderNumber(orderNumber) {
  const escaped = orderNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${escaped}(?!\\d)`).test(document.body.innerText);
}

function findColumnIndex(grid, text) {
  for (const th of grid.querySelectorAll(SELECTORS.itemsGridHeaderCell)) {
    const label = (th.dataset.text || th.textContent || "").trim().toLowerCase();
    if (label.startsWith(text.toLowerCase())) return th.dataset.colIndex;
  }
  return null;
}

// int-shipping이 넘긴 품목(sku/title/unitPrice)을 Items 표의 행과 짝짓는다.
// SKU가 있으면 SKU로, 없으면 품목명으로 찾고, 같은 SKU가 여러 줄이면 위에서부터 차례로 쓴다.
// 하나라도 못 찾으면 어떤 행을 고쳐야 할지 확신할 수 없으니 중단한다.
// Items 표의 행을 읽는다. 값(name/sku/qty/unitPrice)은 원래 표기 그대로, 매칭용은 소문자 정규화.
function readItemRows(grid) {
  const skuCol = findColumnIndex(grid, ITEMS_COLUMN_TEXT.sku);
  const priceCol = findColumnIndex(grid, ITEMS_COLUMN_TEXT.unitPrice);
  const shipCol = findColumnIndex(grid, ITEMS_COLUMN_TEXT.ship);
  if (priceCol == null) throw new Error("Items 표에서 Unit Price 컬럼을 찾지 못했습니다.");

  // 표는 입력칸으로 그려질 때도 있고(저장본 HTML), 글자로만 표시될 때도 있다(실측: DEC에서 직접 수정·저장한
  // #28783 상세 화면) — 입력칸 값이 없으면 칸에 보이는 글자를 읽는다.
  const cellValue = (row, col) => {
    const td = row.querySelector(`td[data-col-index="${col}"]`);
    if (!td) return "";
    const inputValue = td.querySelector("input")?.value?.trim();
    return inputValue || td.textContent?.replace(/\s+/g, " ").trim() || "";
  };

  return Array.from(grid.querySelectorAll(SELECTORS.itemsGridRow)).map((row) => {
    const name = cellValue(row, 0);
    const sku = skuCol == null ? "" : cellValue(row, skuCol);
    const priceInput = row.querySelector(`td[data-col-index="${priceCol}"] input`);
    // Ship 컬럼은 "<input value=70> of 70" 형태 — 뒤의 " of N"이 주문 수량
    const shipCell = row.querySelector(`td[data-col-index="${shipCol}"]`);
    const qtyMatch = shipCell?.textContent?.match(/of\s*(\d+)/);
    const qty = qtyMatch ? Number(qtyMatch[1]) : Number(shipCell?.querySelector("input")?.value) || null;
    const priceText = cellValue(row, priceCol).replace(/[^0-9.\-]/g, "");
    return {
      name,
      sku,
      qty,
      unitPrice: priceText === "" ? null : parseFloat(priceText),
      normName: norm(name),
      normSku: norm(sku),
      priceInput,
      rowEl: row,
    };
  });
}

// 표가 글자로만 표시돼 Unit Price 입력칸이 없을 때: 행의 편집(연필) 버튼 → "Item details" 창에서
// Unit Price를 바꾸고 "Update order"를 누른다(사람이 수기로 고치던 방식과 같음, 저장본 HTML의 창 구조 기준).
async function editPriceViaItemModal(rowEl, value, item) {
  const label = item.sku || item.title;
  const editBtn = rowEl.querySelector(SELECTORS.itemEditButton);
  if (!editBtn) throw new Error(`품목 편집 버튼을 찾지 못했습니다(${label}).`);
  editBtn.click();

  const modal = await waitFor(() => document.querySelector(SELECTORS.itemModal), 8000);
  if (!modal) throw new Error(`Item details 창이 열리지 않았습니다(${label}).`);
  await sleep(500);

  const field = Array.from(modal.querySelectorAll(".add-item-input")).find(
    (el) => el.querySelector(".modal-label")?.textContent?.trim().toLowerCase() === "unit price"
  );
  const input = field?.querySelector("input");
  if (!input) throw new Error(`Item details 창에서 Unit Price 칸을 찾지 못했습니다(${label}).`);
  setInputValue(input, value);
  await sleep(300);

  const updateBtn = Array.from(modal.querySelectorAll("button")).find(
    (b) => b.textContent?.trim().toLowerCase() === "update order"
  );
  if (!updateBtn) throw new Error(`Item details 창에서 Update order 버튼을 찾지 못했습니다(${label}).`);
  updateBtn.click();

  const closed = await waitFor(() => !document.querySelector(SELECTORS.itemModal), 10000);
  if (!closed) throw new Error(`Update order 후 Item details 창이 닫히지 않았습니다(${label}).`);
  await sleep(800);
}

// 화면에 Items 표가 둘 이상 그려질 수 있어(요약 표 + 편집 표) 입력칸이 있는 편집 표를 우선한다.
function pickItemsGrid() {
  const grids = Array.from(document.querySelectorAll(SELECTORS.itemsGrid));
  return grids.find(hasPriceInputs) ?? grids[0] ?? null;
}

// Unit Price 칸에 입력칸이 있는 편집용 표인지 (무게/사이즈 칸만 입력칸인 경우와 구분)
function hasPriceInputs(grid) {
  const priceCol = findColumnIndex(grid, ITEMS_COLUMN_TEXT.unitPrice);
  return priceCol != null && !!grid.querySelector(`${SELECTORS.itemsGridRow} td[data-col-index="${priceCol}"] input`);
}

// Items 영역이 접혀(∨) 있으면 표가 글자로만 된 요약이라 입력칸도, 행별 편집(연필) 버튼도 없다
// (실측: #28783). "Items" 제목 옆의 펼치기 버튼을 눌러 편집용 표(입력칸 + 연필 버튼)로 바꾼다.
async function ensureItemsEditable(grid) {
  if (hasPriceInputs(grid)) return grid;
  const toggle = Array.from(document.querySelectorAll(SELECTORS.sectionToggle)).find(
    (t) => t.closest(".row")?.querySelector(".order-section-heading")?.textContent?.trim().toLowerCase() === "items"
  );
  if (!toggle) return grid; // 펼치기 버튼이 없으면 그대로 진행(행 편집 버튼이 있으면 Item details 창으로 수정)
  (toggle.querySelector("i.toggle") ?? toggle).click();
  const expanded = await waitFor(() => {
    const g = pickItemsGrid();
    return g && hasPriceInputs(g) ? g : null;
  }, 10000);
  if (!expanded) return grid;
  return waitForItemsGrid(); // 펼친 표의 값이 다 채워질 때까지 다시 기다림
}

async function waitFor(check, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const v = check();
    if (v) return v;
    await sleep(200);
  }
  return null;
}

function matchItemsToRows(grid, items) {
  const rows = readItemRows(grid).map((r) => ({ ...r, used: false }));
  const nameMatches = (r, title) =>
    r.normName && (r.normName === title || title.startsWith(r.normName) || r.normName.startsWith(title));

  const assignments = [];
  const unmatched = [];
  for (const item of items) {
    const sku = norm(item.sku);
    const title = norm(item.title);
    // 가액 읽기 때의 행 위치(rowIndex)가 있고 그 행이 여전히 같은 품목이면 그 행을 우선 쓴다(같은 SKU가 여러 줄인 경우 대비)
    const byIndex = Number.isInteger(item.rowIndex) ? rows[item.rowIndex] : null;
    const row =
      (byIndex && !byIndex.used && (sku ? byIndex.normSku === sku : nameMatches(byIndex, title)) && byIndex) ||
      (sku && rows.find((r) => !r.used && r.normSku === sku)) ||
      (!sku && title && rows.find((r) => !r.used && nameMatches(r, title)));
    if (!row) {
      unmatched.push(item.sku || item.title);
      continue;
    }
    if (!row.priceInput && !row.rowEl.querySelector(SELECTORS.itemEditButton)) {
      throw new Error(
        `DHL Items 표에 Unit Price 입력칸도, 품목 편집 버튼도 없어 수정할 수 없습니다(${item.sku || item.title}).`
      );
    }
    row.used = true;
    assignments.push({ priceInput: row.priceInput, rowEl: row.rowEl, item });
  }
  if (unmatched.length > 0) {
    throw new Error(`DHL Items 표에서 품목을 찾지 못했습니다: ${unmatched.join(", ")}`);
  }
  return assignments;
}

// Blazor 바인딩은 input/change 이벤트로 값을 받아가므로 네이티브 setter로 값을 넣고 이벤트를 발생시킨다.
function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  input.focus();
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.blur();
}

async function waitForSaveSettled() {
  await sleep(1500);
  const start = Date.now();
  while (Date.now() - start < 15000) {
    const loading = Array.from(document.querySelectorAll(".k-loader-container, " + SELECTORS.loadingIndicator))
      .some((el) => el.offsetParent !== null);
    if (!loading) break;
    await sleep(300);
  }
  await sleep(1500);
}

function formatPrice(value) {
  return Number(value).toFixed(2);
}

function samePrice(a, b) {
  return Math.abs(parseFloat(a) - Number(b)) < 0.005;
}

function norm(v) {
  return (v ?? "").toString().trim().toLowerCase();
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(values) {
  return new Promise((resolve) => chrome.storage.local.set(values, resolve));
}

function getTargetOrderNumbers() {
  return new Promise((resolve) => {
    chrome.storage.local.get("dhlTargetOrders", (result) => {
      resolve(result.dhlTargetOrders ?? []);
    });
  });
}

function processCurrentPage(remaining) {
  const rows = document.querySelectorAll(SELECTORS.tableRow);
  for (const row of rows) {
    const orderNoText = row
      .querySelector(SELECTORS.rowOrderNumber)
      ?.textContent?.trim();
    if (orderNoText && remaining.has(orderNoText)) {
      const checkbox = row.querySelector(SELECTORS.rowCheckbox);
      if (checkbox && !checkbox.checked) {
        checkbox.click();
      }
      remaining.delete(orderNoText);
    }
  }
}

// 다음 페이지로 넘긴다. 클릭 후 표의 주문번호 목록이 실제로 바뀔 때까지 기다려야 한다 —
// 안 그러면 아직 이전 페이지가 떠 있는 상태를 다시 검사하고 넘어가 버려 주문을 놓친다
// (실측: New 탭 286건 중 #28784를 못 찾음).
async function goToNextPageIfNeeded() {
  const nextBtn = document.querySelector(SELECTORS.nextPageButton);
  if (
    !nextBtn ||
    nextBtn.disabled ||
    nextBtn.getAttribute("aria-disabled") === "true" ||
    nextBtn.classList.contains("k-disabled")
  ) {
    return false;
  }
  const before = orderNumbersOnPage().join(",");
  nextBtn.click();
  const start = Date.now();
  while (Date.now() - start < 15000) {
    await sleep(300);
    const now = orderNumbersOnPage().join(",");
    if (now && now !== before) break;
  }
  if (orderNumbersOnPage().join(",") === before) return false; // 페이지가 안 바뀜 — 마지막 페이지로 간주
  await waitForRowsStable();
  return true;
}

function orderNumbersOnPage() {
  return Array.from(document.querySelectorAll(SELECTORS.tableRow))
    .map((row) => row.querySelector(SELECTORS.rowOrderNumber)?.textContent?.trim())
    .filter(Boolean);
}

// 표가 다 그려질 때까지(주문번호 목록이 0.8초 동안 그대로일 때까지) 기다린다.
async function waitForRowsStable({ timeout = 15000 } = {}) {
  await waitForTableReady();
  const start = Date.now();
  let last = orderNumbersOnPage().join(",");
  let stableSince = Date.now();
  while (Date.now() - start < timeout) {
    await sleep(200);
    const now = orderNumbersOnPage().join(",");
    if (now !== last) {
      last = now;
      stableSince = Date.now();
    } else if (now && Date.now() - stableSince >= 800) {
      return;
    }
  }
}

async function waitForTableReady({ timeout = 10000 } = {}) {
  const start = Date.now();
  // 로딩 스피너가 있으면 사라질 때까지, 없으면 테이블 행이 나타날 때까지 대기
  while (Date.now() - start < timeout) {
    const loading = document.querySelector(SELECTORS.loadingIndicator);
    const hasRows = document.querySelectorAll(SELECTORS.tableRow).length > 0;
    if (!loading && hasRows) return;
    await sleep(300);
  }
}

function reportProgress(checked, total) {
  chrome.runtime.sendMessage({ type: "ORDERS_PROGRESS", checked, total });
}

function findButtonByText(text) {
  // Kendo/Telerik Actions 드롭다운의 메뉴 항목은 <li role="menuitem">로 렌더링된다.
  const candidates = document.querySelectorAll(
    "button, a, [role='button'], [role='menuitem']"
  );
  const normalized = text.trim().toLowerCase();
  for (const el of candidates) {
    if (el.textContent?.trim().toLowerCase() === normalized) return el;
  }
  for (const el of candidates) {
    if (el.textContent?.trim().toLowerCase().includes(normalized)) return el;
  }
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
