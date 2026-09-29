// app2.dhlexpresscommerce.com/orders 에 MAIN world로 주입.
//
// "Print shipping labels"를 누르면 "Generating N shipping label(s)..." 토스트가 뜨고 나서
// 라벨 PDF 생성이 끝난 뒤에야(비동기) 실제 다운로드가 트리거된다(리포트 xlsx와 동일하게
// URL.createObjectURL(blob) → 임시 <a download> 클릭으로 브라우저 기본 다운로드를 여는
// Blazor 표준 패턴). content-orders.js가 클릭 직후 바로 "완료"로 보고하면 background.js가
// 곧장 /reports로 탭을 이동시켜버려서, 생성이 끝나기도 전에 다운로드 트리거 코드 자체가
// 실행이 안 되는 문제가 있었다.
//
// 그래서 이 훅은 두 가지를 한다:
// 1) "실제로 다운로드가 트리거된 순간"을 감지해 content-orders.js에 알려줘서, 그걸 받은
//    뒤에야 다음 단계로 넘어가도록 한다.
// 2) 브라우저 기본 다운로드(= 크롬의 "저장 위치 확인" 설정이 켜져 있으면 매번 팝업이 뜸)로
//    보내는 대신, 파일 바이트를 base64로 캡처해서 확장(background.js)에 넘기고 그쪽에서
//    chrome.downloads.download(saveAs:false)로 조용히 저장하게 한다. 그래서 origClick은
//    호출하지 않는다(브라우저 자체 다운로드 흐름을 아예 타지 않음).
//
// ISOLATED world 콘텐츠 스크립트로는 페이지 자신의 URL.createObjectURL 호출을 가로챌 수
// 없어서(전역이 분리되어 있음) MAIN world로 주입해야 한다.
(function () {
  const pendingBlobUrls = new Map(); // blob: URL -> Blob

  const origCreateObjectURL = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (blob) {
    const url = origCreateObjectURL(blob);
    if (blob instanceof Blob) pendingBlobUrls.set(url, blob);
    return url;
  };

  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    const filename = this.download || "";
    const blob = pendingBlobUrls.get(this.href);
    if (!blob) {
      return origClick.call(this); // 우리가 캡처한 blob 다운로드가 아니면 평소대로 동작
    }

    blob
      .arrayBuffer()
      .then((buf) => arrayBufferToBase64(buf))
      .then((base64) => {
        window.postMessage(
          {
            type: "__DHL_FILE_DOWNLOAD_TRIGGERED__",
            base64,
            filename: filename || "download",
            mimeType: blob.type || "application/octet-stream",
          },
          "*"
        );
      })
      .catch((err) => console.error("[DHL 자동화] 다운로드 캡처 실패", err));

    // 브라우저 기본 다운로드(저장 위치 확인 팝업 포함)는 타지 않는다.
    // 실제 저장은 확장의 chrome.downloads API가 담당한다.
  };

  function arrayBufferToBase64(buf) {
    const bytes = new Uint8Array(buf);
    const chunkSize = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }
})();
