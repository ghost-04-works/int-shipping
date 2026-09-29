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
};

const DHL_ORDERS_URL = "https://app2.dhlexpresscommerce.com/orders";
// Items 표 헤더의 data-text 값 — 컬럼 순서는 사용자가 바꿀 수 있어서 인덱스 대신 헤더 이름으로 찾는다
const ITEMS_COLUMN_TEXT = {
  sku: "SKU",
  unitPrice: "Unit Price", // 실제 값은 "Unit Price (USD)"
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
    await runPriceEditOnDetailPage();
    return;
  }

  const { dhlPriceQueue = [], dhlPriceCurrent = null } = await storageGet([
    "dhlPriceQueue",
    "dhlPriceCurrent",
  ]);
  if (dhlPriceCurrent) {
    // 상세 화면에서 처리 중이던 주문이 끝나지 않은 채 목록으로 돌아온 경우 — 저장이 됐는지 알 수 없으니 중단
    throw new Error(`${dhlPriceCurrent.orderNumber} 가액 수정이 끝나지 않은 채 목록으로 돌아왔습니다. DHL에서 직접 확인해주세요.`);
  }
  if (dhlPriceQueue.length > 0) {
    await openNextPriceOrder(dhlPriceQueue);
    return;
  }

  const targetOrderNumbers = await getTargetOrderNumbers();
  if (targetOrderNumbers.length === 0) {
    console.warn("[DHL 자동화] 처리 대상 주문번호가 없습니다.");
    return;
  }

  const remaining = new Set(targetOrderNumbers);
  const total = targetOrderNumbers.length;

  await waitForTableReady();

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
  await waitForTableReady();

  let link = null;
  for (let page = 0; page < MAX_PAGES && !link; page++) {
    link = findOrderLink(current.orderNumber);
    if (link) break;
    if (!(await goToNextPageIfNeeded())) break;
  }
  if (!link) {
    throw new Error(`가액 수정 대상 ${current.orderNumber}을(를) DHL 주문 목록에서 찾지 못했습니다.`);
  }

  await storageSet({
    dhlPriceQueue: rest,
    dhlPriceCurrent: { ...current, stage: "edit", attempts: 0 },
  });

  const href = link.getAttribute("href");
  if (href && !href.startsWith("#") && !href.startsWith("javascript")) {
    location.assign(new URL(href, location.href).href); // 전체 로드 → 이 스크립트가 상세 화면에서 다시 실행됨
    return;
  }
  // href가 없는 SPA 링크면 클릭 후 같은 스크립트에서 이어서 처리
  link.click();
  const start = Date.now();
  while (!isOrderDetailPage() && Date.now() - start < 15000) await sleep(300);
  if (!isOrderDetailPage()) throw new Error(`${current.orderNumber} 상세 화면으로 이동하지 못했습니다.`);
  await runPriceEditOnDetailPage();
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

  const grid = await waitForItemsGrid();
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

  for (const { priceInput, item } of assignments) {
    setInputValue(priceInput, formatPrice(item.unitPrice));
    await sleep(150);
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

async function waitForItemsGrid({ timeout = 20000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const grid = document.querySelector(SELECTORS.itemsGrid);
    if (grid && grid.querySelector(SELECTORS.itemsGridRow)) {
      await sleep(800); // 행 안 input 값이 채워질 시간
      return grid;
    }
    await sleep(300);
  }
  throw new Error("주문 상세 화면의 Items 표를 찾지 못했습니다.");
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
function matchItemsToRows(grid, items) {
  const skuCol = findColumnIndex(grid, ITEMS_COLUMN_TEXT.sku);
  const priceCol = findColumnIndex(grid, ITEMS_COLUMN_TEXT.unitPrice);
  if (priceCol == null) throw new Error("Items 표에서 Unit Price 컬럼을 찾지 못했습니다.");

  const rows = Array.from(grid.querySelectorAll(SELECTORS.itemsGridRow)).map((row) => ({
    sku: norm(row.querySelector(`td[data-col-index="${skuCol}"] input`)?.value),
    name: norm(row.querySelector('td[data-col-index="0"] input')?.value),
    priceInput: row.querySelector(`td[data-col-index="${priceCol}"] input`),
    used: false,
  }));

  const assignments = [];
  const unmatched = [];
  for (const item of items) {
    const sku = norm(item.sku);
    const title = norm(item.title);
    const row =
      (sku && rows.find((r) => !r.used && r.sku === sku)) ||
      (!sku && title && rows.find((r) => !r.used && r.name && (r.name === title || title.startsWith(r.name) || r.name.startsWith(title))));
    if (!row || !row.priceInput) {
      unmatched.push(item.sku || item.title);
      continue;
    }
    row.used = true;
    assignments.push({ priceInput: row.priceInput, item });
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

async function goToNextPageIfNeeded() {
  const nextBtn = document.querySelector(SELECTORS.nextPageButton);
  if (!nextBtn || nextBtn.disabled || nextBtn.getAttribute("aria-disabled") === "true") {
    return false;
  }
  nextBtn.click();
  await waitForTableReady();
  return true;
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
