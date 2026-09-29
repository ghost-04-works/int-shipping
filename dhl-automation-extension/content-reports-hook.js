// app2.dhlexpresscommerce.com/reports 에 MAIN world로 주입.
//
// DHL 리포트의 "Download Xlsx" 버튼은 별도 파일 URL을 열지 않고, 서버 응답으로 받은
// 바이트를 브라우저 메모리에서 바로 Blob으로 만들어 URL.createObjectURL(blob) →
// 임시 <a download> 클릭으로 다운로드시킨다 (Blazor 표준 패턴).
// 이 스크립트는 그 Blob이 만들어지는 순간을 가로채 base64로 인코딩한 뒤
// window.postMessage로 흘려보낸다. content-reports.js(ISOLATED world)가 이를 받아
// int-shipping 쪽으로 중계하면, 다운로드된 xlsx를 파일시스템 없이 바로 웹 페이지에 넣을 수 있다.
// 브라우저 기본 다운로드(크롬 "저장 위치 확인" 설정이 켜져 있으면 매번 팝업이 뜸)로는
// 보내지 않고, background.js가 chrome.downloads.download(saveAs:false)로 조용히 저장한다.
//
// content_scripts는 world:"MAIN"이라 페이지의 실제 전역(window.URL 등)을 공유해야만
// 페이지 자신의 다운로드 코드가 만드는 Blob을 가로챌 수 있다 — ISOLATED world에서
// 같은 방식으로 훅을 걸면 페이지의 호출에는 영향을 주지 못한다(별도 전역이라 무시됨).
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
    if (!blob || !/\.xlsx?$/i.test(filename)) {
      return origClick.call(this); // xlsx 다운로드가 아니면 평소대로 동작
    }

    blob
      .arrayBuffer()
      .then((buf) => arrayBufferToBase64(buf))
      .then((base64) => {
        window.postMessage(
          {
            type: "__DHL_XLSX_BLOB_CAPTURED__",
            base64,
            filename: filename || "report.xlsx",
            mimeType: blob.type || "application/octet-stream",
          },
          "*"
        );
      })
      .catch((err) => console.error("[DHL 자동화] xlsx blob 캡처 실패", err));

    // 브라우저 기본 다운로드(저장 위치 확인 팝업 포함)는 타지 않는다.
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
