// int-shipping 페이지(https://ghost-04-works.github.io/int-shipping/*)에 주입되어
// 웹 페이지 <-> 크롬 확장(background.js) 사이의 통신 다리 역할을 한다.

window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== "DHL_AUTOMATE") return;

  const orderNumbers = event.data.orderNumbers ?? [];
  const priceUpdates = event.data.priceUpdates ?? [];
  chrome.runtime.sendMessage(
    { type: "DHL_AUTOMATE_START", orderNumbers, priceUpdates },
    (response) => {
      if (chrome.runtime.lastError) {
        postToPage({
          type: "DHL_AUTOMATE_ERROR",
          error: chrome.runtime.lastError.message,
        });
        return;
      }
      if (!response?.ok) {
        postToPage({
          type: "DHL_AUTOMATE_ERROR",
          error: response?.error ?? "알 수 없는 오류",
        });
      }
    }
  );
});

// background.js가 보내는 진행상황/완료/에러 메시지를 페이지로 전달한다.
chrome.runtime.onMessage.addListener((message) => {
  if (!message?.type?.startsWith("DHL_AUTOMATE")) return;
  postToPage(message);
});

function postToPage(payload) {
  window.postMessage(payload, "*");
}
