// app2.dhlexpresscommerce.com/reports 에 주입.
// "GENERATE REPORT" 클릭 -> 모달에서 START DATE를 오늘 날짜로 맞추고 "GENERATE" 클릭 ->
// 오늘 날짜 행이 "Ready"가 될 때까지 새로고침하며 폴링 -> "DOWNLOAD XLSX" 클릭.
//
// location.reload()로 페이지를 새로고침하면 콘텐츠 스크립트가 처음부터 다시 실행되므로,
// 진행 상태(리포트 생성 여부, 시도 횟수)는 sessionStorage에 저장해 재실행 시 이어받는다.
//
// 2026-07-31 실제 DOM 확인 및 실전 테스트 완료 (개발자도구 기준).
// - "GENERATE REPORT"는 텍스트가 아니라 <input type="button" value="Generate report">라
//   textContent 매칭이 아닌 별도 셀렉터로 찾는다.
// - 클릭하면 바로 생성되지 않고 리포트 타입/기간 선택 **모달**이 뜬다. END DATE는 기본값이
//   오늘이라 문제 없지만, START DATE 기본값은 "어제"라서 오늘 날짜로 맞춰줘야 한다.
//   Kendo DateInput 세그먼트는 실제 키보드 입력에만 반응하고 .value 대입이나 합성
//   KeyboardEvent 디스패치로는 값이 갱신되지 않아(content script에서는 진짜 키 입력을
//   보낼 수 없음), 대신 캘린더 아이콘을 눌러 팝업을 열고 "오늘" 셀(class="k-today")을
//   클릭하는 방식을 쓴다 — 월이 바뀌는 경우에도 항상 정확히 오늘을 가리켜서 더 안전하다.
// - Download 버튼은 표준 <button>이 아닌 커스텀 <btn> 엘리먼트다.
const SELECTORS = {
  generateReportButton: "input.btn-create-reports", // value="Generate report"
  modalGenerateButton: "button.btn-modal", // 모달 안의 "Generate" 확정 버튼
  calendarPopup: ".k-datepicker-popup",
  calendarTodayCellLink: "td.k-today .k-link",
  tableRow: "tr.k-table-row.k-master-row", // 헤더 행 제외, 데이터 행만
  // 컬럼 순서(QUEUED DATE, REPORT TYPE, START DATE, END DATE, INCLUDE CHILD ACCOUNTS,
  // INCLUDE ARCHIVED ITEMS, STATUS, Download Csv, Download Xlsx)가 바뀌면 인덱스도 같이 수정할 것
  queuedDateCell: 'td[data-col-index="0"]',
  statusCell: 'td[data-col-index="6"]',
  downloadButtonInRow: ".btn-report-download-report", // 행 안에 CSV/XLSX 두 개 있음, 텍스트로 구분
  loadingIndicator: '[class*="k-loading"], [class*="k-i-loading"]',
};

const STATUS_READY = "Ready";
const MAX_ATTEMPTS = 30;
const POLL_INTERVAL_MS = 10000; // 10초 간격, 최대 5분

const STATE_KEY = "dhlReportState"; // sessionStorage 키

main().catch((err) => {
  console.error("[DHL 자동화] content-reports 실행 오류", err);
  clearState();
  chrome.runtime.sendMessage({
    type: "REPORTS_DONE",
    success: false,
    error: String(err?.message ?? err),
  });
});

async function main() {
  const state = getState();

  if (!state.generated) {
    const result = await openModalAndGenerate();
    if (!result.ok) {
      clearState();
      chrome.runtime.sendMessage({
        type: "REPORTS_DONE",
        success: false,
        error: result.error,
      });
      return;
    }
    setState({ generated: true, attempt: 0 });
    reportProgress(0, "리포트 생성 요청, 대기 중");
    await sleep(POLL_INTERVAL_MS);
    location.reload();
    return;
  }

  const attempt = state.attempt + 1;
  await waitForTableReady();

  const row = findTodayReadyRow();
  if (row) {
    const downloadBtn = findDownloadXlsxButton(row);
    if (downloadBtn) {
      const blobPromise = waitForCapturedXlsxBlob();
      downloadBtn.click();
      const report = await blobPromise; // 캡처 실패/타임아웃 시 null — 파일은 정상적으로 다운로드됨
      clearState();
      chrome.runtime.sendMessage({ type: "REPORTS_DONE", success: true, report });
      return;
    }
  }

  reportProgress(
    attempt,
    row ? "Ready 상태이나 다운로드 버튼을 찾지 못함" : "리포트 준비 대기 중"
  );

  if (attempt >= MAX_ATTEMPTS) {
    clearState();
    chrome.runtime.sendMessage({
      type: "REPORTS_DONE",
      success: false,
      error: "타임아웃: 리포트가 준비되지 않았습니다.",
    });
    return;
  }

  setState({ generated: true, attempt });
  await sleep(POLL_INTERVAL_MS);
  location.reload();
}

// "Generate report" 클릭 -> 모달 -> START DATE를 오늘로 맞춤 -> 모달의 "Generate" 클릭
async function openModalAndGenerate() {
  await waitForTableReady();
  const genBtn = document.querySelector(SELECTORS.generateReportButton);
  if (!genBtn) {
    return { ok: false, error: '"Generate report" 버튼을 찾지 못했습니다.' };
  }
  genBtn.click();

  const modalGenBtn = await waitForElement(SELECTORS.modalGenerateButton);
  if (!modalGenBtn) {
    return { ok: false, error: "리포트 생성 모달을 찾지 못했습니다." };
  }

  const fixed = await setStartDateToToday();
  if (!fixed.ok) return fixed;

  modalGenBtn.click();
  return { ok: true };
}

// START DATE 기본값은 "어제"이므로, 캘린더 팝업을 열어 "오늘" 셀을 클릭해 맞춘다.
async function setStartDateToToday() {
  const calendarButtons = Array.from(
    document.querySelectorAll("button.k-input-button")
  ).filter((b) => b.querySelector('[class*="k-svg-i-calendar"]'));
  const startDateCalendarBtn = calendarButtons[0];
  if (!startDateCalendarBtn) {
    return { ok: false, error: "START DATE 캘린더 버튼을 찾지 못했습니다." };
  }
  startDateCalendarBtn.click();

  const popup = await waitForElement(SELECTORS.calendarPopup);
  if (!popup) {
    return { ok: false, error: "캘린더 팝업을 찾지 못했습니다." };
  }
  const todayLink = popup.querySelector(SELECTORS.calendarTodayCellLink);
  if (!todayLink) {
    return { ok: false, error: '캘린더에서 "오늘" 셀을 찾지 못했습니다.' };
  }
  todayLink.click();
  await sleep(200); // 팝업 닫힘 + 입력값 반영 대기
  return { ok: true };
}

// content-reports-hook.js(MAIN world)가 다운로드 클릭을 가로채 캡처한 xlsx를
// window.postMessage로 흘려보낸다. 여기서 그걸 받아 background.js에 "조용히 저장"을
// 요청하고, 동시에 base64/파일명을 REPORTS_DONE에 실어보내 int-shipping 자동 반영에도 쓴다.
function waitForCapturedXlsxBlob({ timeout = 8000 } = {}) {
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
      if (event.data?.type !== "__DHL_XLSX_BLOB_CAPTURED__") return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      const report = {
        base64: event.data.base64,
        filename: event.data.filename,
        mimeType: event.data.mimeType,
      };
      chrome.runtime.sendMessage({ type: "SAVE_FILE", file: report });
      resolve(report);
    }

    window.addEventListener("message", onMessage);
  });
}

async function waitForElement(selector, { timeout = 5000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const el = document.querySelector(selector);
    if (el) return el;
    await sleep(200);
  }
  return null;
}

function findTodayReadyRow() {
  const todayStr = formatTodayForTable();
  const rows = document.querySelectorAll(SELECTORS.tableRow);
  for (const row of rows) {
    const dateText = row.querySelector(SELECTORS.queuedDateCell)?.textContent?.trim();
    const statusText = row.querySelector(SELECTORS.statusCell)?.textContent?.trim();
    // QUEUED DATE 셀에는 "31. 07. 26 11:48 오전"처럼 시간까지 포함되므로 날짜 부분만 비교
    if (dateText?.startsWith(todayStr) && statusText === STATUS_READY) {
      return row;
    }
  }
  return null;
}

function findDownloadXlsxButton(row) {
  const buttons = row.querySelectorAll(SELECTORS.downloadButtonInRow);
  for (const btn of buttons) {
    if (/xlsx/i.test(btn.textContent)) return btn;
  }
  return null;
}

function formatTodayForTable() {
  // 사이트 표시 형식: "DD. MM. YY" (예: "31. 07. 26")
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, "0");
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const yy = String(now.getFullYear()).slice(-2);
  return `${dd}. ${mm}. ${yy}`;
}

async function waitForTableReady({ timeout = 10000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const loading = document.querySelector(SELECTORS.loadingIndicator);
    const hasRows = document.querySelectorAll(SELECTORS.tableRow).length > 0;
    if (!loading && hasRows) return;
    await sleep(300);
  }
}

function reportProgress(attempt, status) {
  chrome.runtime.sendMessage({
    type: "REPORTS_PROGRESS",
    attempt,
    maxAttempts: MAX_ATTEMPTS,
    status,
  });
}

function getState() {
  try {
    return JSON.parse(sessionStorage.getItem(STATE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function setState(state) {
  sessionStorage.setItem(STATE_KEY, JSON.stringify(state));
}

function clearState() {
  sessionStorage.removeItem(STATE_KEY);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
