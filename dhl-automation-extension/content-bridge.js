// int-shipping 페이지(https://ghost-04-works.github.io/int-shipping/*)에 주입되어
// 웹 페이지 <-> 크롬 확장(background.js) 사이의 통신 다리 역할을 한다.
//
// 요청 종류 (페이지 → 확장):
//   DHL_AUTOMATE        (가액 수정 +) 라벨 출력 + 리포트. printLabels: true가 명시돼야만 처리한다.
//   DHL_AUTOMATE_READ   DHL 단가 읽기만 (수정·출력 없음)
//   DHL_PRICES_ONLY     DHL 가액만 수정 (라벨 출력 없음) — 라벨 요청과 종류 자체를 분리해, 이 요청을 모르는
//                       옛 버전 파일은 무시할 뿐 라벨로 이어질 수 없게 한다(실측: 가액만 수정에서 라벨이 출력된 사고).
//   DHL_EXT_PING        확장 버전 확인 → DHL_EXT_HELLO { version }로 응답

const EXT_VERSION = chrome.runtime.getManifest().version;

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const type = event.data?.type;

  if (type === "DHL_EXT_PING") {
    postToPage({ type: "DHL_EXT_HELLO", version: EXT_VERSION });
    return;
  }
  if (type !== "DHL_AUTOMATE" && type !== "DHL_AUTOMATE_READ" && type !== "DHL_PRICES_ONLY") return;

  const orderNumbers = event.data.orderNumbers ?? [];
  const priceUpdates = event.data.priceUpdates ?? [];
  let message;
  if (type === "DHL_AUTOMATE_READ") {
    message = { type: "DHL_READ_PRICES_START", orderNumbers };
  } else if (type === "DHL_PRICES_ONLY") {
    message = { type: "DHL_PRICES_ONLY_START", orderNumbers, priceUpdates };
  } else {
    if (event.data.printLabels !== true) {
      postToPage({ type: "DHL_AUTOMATE_ERROR", error: "라벨 출력 요청이 명시되지 않아 처리하지 않았습니다." });
      return;
    }
    message = { type: "DHL_AUTOMATE_START", orderNumbers, priceUpdates, printLabels: true };
  }

  chrome.runtime.sendMessage(message, (response) => {
    if (chrome.runtime.lastError) {
      postToPage({ type: "DHL_AUTOMATE_ERROR", error: chrome.runtime.lastError.message });
      return;
    }
    if (!response?.ok) {
      postToPage({ type: "DHL_AUTOMATE_ERROR", error: response?.error ?? "알 수 없는 오류" });
    }
  });
});

// 페이지가 먼저 로드돼 PING을 못 받았을 수도 있으니 로드 시 한 번 알린다
postToPage({ type: "DHL_EXT_HELLO", version: EXT_VERSION });

// background.js가 보내는 진행상황/완료/에러 메시지를 페이지로 전달한다.
chrome.runtime.onMessage.addListener((message) => {
  if (!message?.type?.startsWith("DHL_AUTOMATE")) return;
  postToPage(message);
});

function postToPage(payload) {
  window.postMessage(payload, "*");
}
