// 서비스 워커: int-shipping 탭 <-> DHL 탭 사이의 메시지 중계와 탭 생성/전환을 담당한다.

const DHL_ORDERS_URL = "https://app2.dhlexpresscommerce.com/orders";
const DHL_REPORTS_URL = "https://app2.dhlexpresscommerce.com/reports";

// 진행 중인 자동화 작업의 상태. 한 번에 하나의 작업만 처리한다(2단계 스코프).
let job = null; // { sourceTabId, sourceWindowId, dhlTabId, orderNumbers, phase }

function resetJob() {
  job = null;
}

async function notifySource(payload) {
  if (!job?.sourceTabId) return;
  try {
    await chrome.tabs.sendMessage(job.sourceTabId, payload);
  } catch (err) {
    console.warn("[DHL 자동화] 원본 탭에 메시지 전달 실패", err);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // async sendResponse 사용
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "DHL_AUTOMATE_START":
      return startJob(message.orderNumbers, sender.tab?.id, sender.tab?.windowId);

    case "ORDERS_PROGRESS":
      await notifySource({
        type: "DHL_AUTOMATE_PROGRESS",
        phase: "orders",
        checked: message.checked,
        total: message.total,
      });
      return { ok: true };

    case "ORDERS_DONE":
      return onOrdersDone(message);

    case "REPORTS_PROGRESS":
      await notifySource({
        type: "DHL_AUTOMATE_PROGRESS",
        phase: "reports",
        attempt: message.attempt,
        maxAttempts: message.maxAttempts,
        status: message.status,
      });
      return { ok: true };

    case "REPORTS_DONE":
      return onReportsDone(message);

    // content-orders-hook.js / content-reports-hook.js가 가로챈 파일을 조용히 저장할 때 사용
    // (브라우저 기본 다운로드를 타지 않으므로 크롬 "저장 위치 확인" 설정과 무관하게 항상 조용히 저장됨)
    case "SAVE_FILE":
      return saveFile(message.file);

    // content-orders.js / content-reports.js가 처리 대상 주문번호 목록을 요청할 때 사용
    case "GET_TARGET_ORDERS":
      return { orderNumbers: job?.orderNumbers ?? [] };

    default:
      return { ok: false, error: "unknown message type" };
  }
}

async function startJob(orderNumbers, sourceTabId, sourceWindowId) {
  if (!Array.isArray(orderNumbers) || orderNumbers.length === 0) {
    return { ok: false, error: "orderNumbers가 비어있습니다." };
  }
  if (job) {
    return { ok: false, error: "이미 진행 중인 자동화 작업이 있습니다." };
  }

  job = { sourceTabId, sourceWindowId, dhlTabId: null, orderNumbers, phase: "orders" };
  await chrome.storage.local.set({ dhlTargetOrders: orderNumbers });

  const tab = await chrome.tabs.create({ url: DHL_ORDERS_URL });
  job.dhlTabId = tab.id;

  await notifySource({
    type: "DHL_AUTOMATE_PROGRESS",
    phase: "orders",
    checked: 0,
    total: orderNumbers.length,
  });

  return { ok: true };
}

async function onOrdersDone(message) {
  if (!job) return { ok: false, error: "no active job" };

  if (!message.success) {
    await notifySource({
      type: "DHL_AUTOMATE_ERROR",
      phase: "orders",
      error: message.error ?? "주문 체크 중 오류가 발생했습니다.",
      notFound: message.notFound ?? [],
    });
    resetJob();
    return { ok: true };
  }

  await notifySource({
    type: "DHL_AUTOMATE_PROGRESS",
    phase: "orders",
    checked: job.orderNumbers.length,
    total: job.orderNumbers.length,
    notFound: message.notFound ?? [],
    labelsTriggered: true,
    labelDownloadConfirmed: message.labelDownloadConfirmed,
  });

  job.phase = "reports";
  await chrome.tabs.update(job.dhlTabId, { url: DHL_REPORTS_URL });
  return { ok: true };
}

async function onReportsDone(message) {
  if (!job) return { ok: false, error: "no active job" };

  if (message.success) {
    await notifySource({ type: "DHL_AUTOMATE_DONE", phase: "reports", report: message.report ?? null });
    // 다운로드 성공 시에만 int-shipping 탭으로 포커스를 돌려준다 — 사용자가 할 일이 끝난
    // DHL 탭에 남아있다가 실수로 뭔가 누르는 걸 막기 위함. 실패 시에는 사용자가 DHL 화면에서
    // 무슨 일이 있었는지 직접 봐야 하므로 그대로 둔다.
    await focusSourceTab();
  } else {
    await notifySource({
      type: "DHL_AUTOMATE_ERROR",
      phase: "reports",
      error: message.error ?? "리포트 다운로드에 실패했습니다.",
    });
  }

  resetJob();
  return { ok: true };
}

// content-orders-hook.js / content-reports-hook.js가 캡처한 파일(base64)을
// chrome.downloads API로 조용히 저장한다. saveAs:false라 "저장 위치 확인" 팝업이 뜨지 않는다
// (그 크롬 설정은 페이지가 직접 트리거하는 다운로드에만 적용되고, 확장이 API로 시작하는
// 다운로드는 saveAs 옵션으로 직접 제어된다).
//
// 시행착오 기록:
// 1) data: URL + filename 옵션 → 내용은 정확한데 파일명이 크롬 기본값("download"/"다운로드",
//    확장자 없음)으로 저장됨 (chrome.downloads.download가 data: URL에서는 filename을
//    신뢰성 있게 반영하지 않는 특성).
// 2) Blob URL(URL.createObjectURL)로 대체 시도 → MV3 서비스 워커에는 DOM이 없어서
//    URL.createObjectURL 자체가 존재하지 않음(TypeError). 서비스 워커에서는 못 씀.
// 3) (현재) data: URL은 유지하되, chrome.downloads.onDeterminingFilename 이벤트로
//    크롬이 파일명을 확정하기 직전에 원하는 이름을 강제 지정. 이 이벤트가 정확히
//    "확장이 다운로드 파일명을 제어하는" 공식 메커니즘이라 data: URL의 기본 이름 무시
//    문제를 우회할 수 있다.
const pendingDownloadFilenames = new Map(); // downloadId -> filename

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const filename = pendingDownloadFilenames.get(item.id);
  if (!filename) {
    suggest(); // 우리가 시작한 다운로드가 아니면 기본 동작
    return;
  }
  pendingDownloadFilenames.delete(item.id);
  suggest({ filename, conflictAction: "uniquify" });
});

async function saveFile(file) {
  if (!file?.base64 || !file?.filename) {
    return { ok: false, error: "저장할 파일 데이터가 없습니다." };
  }
  try {
    const dataUrl = `data:${file.mimeType || "application/octet-stream"};base64,${file.base64}`;
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename: file.filename,
      saveAs: false,
    });
    pendingDownloadFilenames.set(downloadId, file.filename);
    return { ok: true, downloadId };
  } catch (err) {
    console.error("[DHL 자동화] 파일 저장 실패", err);
    return { ok: false, error: String(err?.message ?? err) };
  }
}

async function focusSourceTab() {
  if (!job?.sourceTabId) return;
  try {
    await chrome.tabs.update(job.sourceTabId, { active: true });
    if (job.sourceWindowId) {
      await chrome.windows.update(job.sourceWindowId, { focused: true });
    }
  } catch (err) {
    console.warn("[DHL 자동화] 원본 탭 포커스 복귀 실패", err);
  }
}
