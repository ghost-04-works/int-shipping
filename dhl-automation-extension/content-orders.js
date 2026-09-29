// app2.dhlexpresscommerce.com/orders 에 주입.
// 처리 대상 주문번호에 해당하는 행의 체크박스를 자동으로 체크하고,
// 페이지네이션(Telerik/Kendo Blazor Grid, 50개씩)을 넘기며 반복한 뒤
// 상단 "Actions" 드롭다운 → "Print shipping labels"를 클릭한다.
//
// 2026-07-31 실제 DOM 확인 완료 (개발자도구 기준):
const SELECTORS = {
  tableRow: "tr.k-table-row.k-master-row", // 헤더 등 다른 tr.k-table-row와 구분하기 위해 k-master-row까지 포함
  rowOrderNumber: "a.order-number", // 예: <a class="... order-number">#28355</a>
  rowCheckbox: 'input[type="checkbox"].k-checkbox',
  nextPageButton: 'button[title="Go to the next page"]', // 비활성화 시 class에 k-disabled 포함
  loadingIndicator: '[class*="k-loading"], [class*="k-i-loading"]',
  bulkActionsButton: "button.button-bulk-actions", // "1 selected" 옆의 "Actions" 드롭다운 버튼
};

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
