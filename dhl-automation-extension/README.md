# GEONWORKS DHL 자동화 (크롬 확장 스켈레톤)

`dhl-automation-spec.md` 설계 문서 기반 1차 스켈레톤. 메시지 흐름과 폴링 로직은 구현되어 있으나,
DHL Express Commerce 실제 페이지의 DOM 셀렉터는 아직 채워야 한다.

## 로드 방법

1. `chrome://extensions` 접속
2. "개발자 모드" 켜기
3. "압축해제된 확장 프로그램을 로드합니다." → 이 폴더 선택

## 셀렉터 확인 상태 (2026-07-31)

실제 `app2.dhlexpresscommerce.com`(Telerik/Kendo Blazor 기반)에 로그인해서 개발자도구로 확인 완료.
`content-orders.js`, `content-reports.js`의 `SELECTORS`에 반영되어 있음.

- **orders 페이지**: 행 = `tr.k-table-row.k-master-row`, 체크박스 = `input.k-checkbox`,
  주문번호 = `a.order-number`(텍스트 `#28355` 형태), 다음 페이지 = `button[title="Go to the next page"]`.
  "Print shipping labels"는 독립 버튼이 아니라 체크 시 나타나는 **"Actions" 드롭다운**(`button.button-bulk-actions`)
  안의 메뉴 항목(`role="menuitem"`)이라 먼저 드롭다운을 열어야 함.
- **reports 페이지**: "GENERATE REPORT"는 `<input type="button" class="btn-create-reports" value="Generate report">`라
  텍스트가 아닌 값(value) 기반. 리포트 행 = `tr.k-table-row.k-master-row`, QUEUED DATE/STATUS는
  `td[data-col-index="0"]`/`td[data-col-index="6"]`(컬럼 순서 바뀌면 인덱스도 수정 필요),
  Download 버튼은 표준 `<button>`이 아닌 커스텀 `<btn class="btn-report-download-report">`.
  날짜 표시 형식은 `"31. 07. 26"`(DD. MM. YY, 점+공백 구분).

## 실전 테스트 결과 (2026-07-31)

테스트용 주문 #28361, #28360, #28359로 전체 흐름을 실제로 검증 완료.

- **orders**: 체크 → Actions → Print shipping labels → 3건 모두 "New"에서 "Printed"로 이동 확인.
  (처음 시도 시 배송지가 한국 주소로 되어 있어 `General Exception - Please select a product for this shipment` 에러 발생,
  해외 주소로 수정 후 재시도해서 성공 — 테스트 시 배송지가 실제 배송 가능한 국가여야 함)
- **reports**: "GENERATE REPORT" 클릭 시 뜨는 모달에서 **START DATE 기본값이 "어제"**라 END DATE(오늘)와
  어긋나는 문제 발견 → START DATE도 오늘 날짜로 맞추도록 수정. Kendo DateInput 세그먼트는 실제 키보드 입력에만
  반응하고(.value 대입, 합성 KeyboardEvent 모두 무시됨) content script에서는 진짜 키 입력을 보낼 수 없어서,
  대신 캘린더 아이콘 → 팝업의 "오늘" 셀(`td.k-today`) 클릭 방식으로 구현. 전체 흐름(모달 열기 → 날짜 보정 →
  GENERATE → 새로고침 폴링 → Ready 확인 → DOWNLOAD XLSX)을 실제 코드 그대로 실행해서 `REPORTS_DONE success:true`까지 확인.
- **다운로드 저장 위치 팝업**: 처음엔 크롬 "다운로드할 때마다 저장 위치 확인" 설정 때문에 라벨 PDF/리포트
  XLSX마다 저장 경로를 묻는 팝업이 떴었음. 이후 아래 "조용한 파일 저장" 항목의 방식으로 코드에서 해결함
  (크롬 전역 설정 변경 불필요).
- **라벨 PDF가 다운로드되지 않던 문제**: "Print shipping labels" 클릭 후 바로 "완료"로 보고했는데, 실제로는
  "Generating N shipping label(s)..." 처리가 끝난 뒤(실측 3건 기준 약 3초, 주문당 약 1초)에야 PDF 다운로드가
  트리거되는 비동기 동작이었음. `background.js`가 그 전에 곧장 `/reports`로 탭을 이동시켜버려서 다운로드
  트리거 코드 자체가 실행되지 못했던 것 — `content-orders-hook.js`로 다운로드 트리거 시점을 감지해서 그
  신호를 받을 때까지 기다린 뒤에야 다음 단계로 넘어가도록 수정(타임아웃은 주문 수에 비례, 최대 3분).

## 조용한 파일 저장 (2026-07-31)

라벨 PDF, 리포트 XLSX 둘 다 원래는 페이지가 직접 트리거하는 브라우저 기본 다운로드(`<a download>` 클릭)라
크롬 "저장 위치 확인" 설정이 켜져 있으면 파일마다 팝업이 떴다. `content-orders-hook.js` /
`content-reports-hook.js`(둘 다 `world: "MAIN"`)가 다운로드를 가로챌 때 원래 클릭(`origClick`)을 호출하지
않고, 대신 캡처한 바이트(base64)를 `background.js`로 넘겨 `chrome.downloads.download({..., saveAs:false})`로
직접 저장하도록 바꿈. `saveAs:false`는 확장이 API로 시작하는 다운로드에 대해 명시적으로 파일 선택 창을 띄우지
않는 옵션이라, 크롬의 전역 "저장 위치 확인" 설정과 무관하게 항상 조용히 저장된다. `manifest.json`에
`"downloads"` 권한 추가 필요.

## int-shipping 연동 + 리포트 자동 반영 (2026-07-31)

`int-shipping`(별도 저장소 `ghost-04-works/int-shipping`, GitHub Pages 배포)의 "DHL 발송건" 탭에
"라벨 자동 출력" 버튼과 `content-bridge.js` 연동을 완료. 소스는 그 저장소에 있음(이 폴더 범위 밖).

추가로, 원래 "범위 밖"으로 뒀던 **xlsx 자동 반영**도 구현함:

- `content-reports-hook.js`를 `world: "MAIN"`으로 `/reports*`에 주입. DHL의 "Download Xlsx"는 별도
  파일 URL이 아니라 서버 응답을 브라우저 메모리에서 바로 `Blob`으로 만들어
  `URL.createObjectURL` → 임시 `<a download>` 클릭으로 다운로드시키는 방식(Blazor 표준 패턴)이라,
  그 Blob이 만들어지는 순간을 가로채 base64로 인코딩해 `window.postMessage`로 흘려보냄.
  **ISOLATED world 콘텐츠 스크립트로는 페이지 자신의 `URL.createObjectURL` 호출을 가로챌 수 없음**
  (전역이 분리되어 있어 오버라이드가 페이지 쪽에 영향을 안 줌) — 그래서 MAIN world 스크립트가 필요했음.
- `content-reports.js`가 그 캡처된 base64를 받아 `REPORTS_DONE`에 실어 보냄(타임아웃 시 `report: null`,
  이 경우 파일은 정상적으로 디스크에 다운로드되고 기존처럼 수동 업로드로 폴백).
- `background.js`가 `DHL_AUTOMATE_DONE`에 `report` 필드로 relay.
- int-shipping 쪽은 `report`를 받으면: "처리완료" 탭 전환 → 주문 목록 새로고침(Shopify 동기화 대기 2초) →
  `DataTransfer`로 `#dhl-report-input.files`에 파일 주입 + `change` 이벤트 디스패치(기존 파싱/자동선택
  로직 재사용) → 파싱 완료 확인 후 **"출고분/GMI 엑셀 생성" 버튼까지 자동 클릭**해서 원산지 확인 모달을 띄움.
  재고차감(`선택 주문 재고차감`)과 모달의 최종 "확인 후 엑셀 생성"은 재고/통관 서류에 실제 영향을 주는
  동작이라 자동 클릭하지 않고 사람이 검토 후 직접 누르도록 남겨둠.

## 메시지 흐름 요약

```
int-shipping 페이지
  → (postMessage DHL_AUTOMATE) → content-bridge.js
  → (runtime.sendMessage DHL_AUTOMATE_START) → background.js
      → 주문번호를 chrome.storage.local에 저장, /orders 새 탭 오픈
  → content-orders.js: 체크박스 체크 + 페이지네이션 반복 → 라벨 출력 버튼 클릭
      → (runtime.sendMessage ORDERS_DONE) → background.js
      → background.js가 같은 탭을 /reports로 이동
  → content-reports-hook.js(MAIN world): Download Xlsx의 Blob 생성을 가로채 캡처 준비
  → content-reports.js: GENERATE REPORT 클릭 → 폴링(새로고침) → Ready 확인 → DOWNLOAD XLSX 클릭
      → 캡처된 xlsx(base64)를 REPORTS_DONE에 실어 → background.js
  → background.js가 진행상황/완료(+report)/에러를 원본 int-shipping 탭(content-bridge.js)에 relay
  → content-bridge.js가 postMessage(DHL_AUTOMATE_PROGRESS / DONE / ERROR)로 페이지에 전달
  → int-shipping이 report를 받으면 "처리완료" 탭 전환 → 파일 자동 주입 → 출고분/GMI 엑셀 생성 버튼 자동 클릭
```

## 조용한 파일 저장 — 파일명 문제 시행착오 (2026-07-31)

`chrome.downloads.download()`로 저장 위치 확인 팝업 없이 저장하는 과정에서 파일명이 계속 틀어지는 문제를
겪었고, 최종적으로 `chrome.downloads.onDeterminingFilename`으로 해결했다. 순서대로:

1. **data: URL + `filename` 옵션** → 실제 파일 내용(라벨 PDF, 리포트 xlsx 둘 다)은 완벽하게 저장되는데,
   파일명이 우리가 지정한 값이 아니라 크롬이 자체적으로 붙이는 기본 이름("download"/한국어 크롬에서는
   "다운로드", 확장자 없음)으로 나옴. `chrome.downloads.download`가 `data:` URL에 대해서는 `filename`
   옵션을 신뢰성 있게 반영하지 않는 특성 때문.
2. **Blob URL(`URL.createObjectURL`)로 대체** → MV3 서비스 워커(`background.js`)에는 DOM이 없어서
   `URL.createObjectURL`이 아예 존재하지 않음. `TypeError: URL.createObjectURL is not a function`으로
   즉시 실패(그래서 이번엔 파일이 아예 하나도 안 받아짐).
3. **(현재) `chrome.downloads.onDeterminingFilename` 이벤트 사용** — `data:` URL은 그대로 두고,
   `chrome.downloads.download()`가 반환한 `downloadId`를 기억해뒀다가, 크롬이 파일명을 확정하기 직전에
   발생하는 이 이벤트에서 `suggest({filename, conflictAction: "uniquify"})`로 원하는 파일명을 강제
   지정. 이게 확장이 다운로드 파일명을 제어하도록 크롬이 공식적으로 제공하는 메커니즘이라 data: URL의
   기본 이름 무시 문제를 우회할 수 있었다.

## 탭 포커스 복귀 (2026-07-31)

라벨 출력 → 리포트 다운로드까지 진행되는 동안 화면은 DHL 탭에 머물러 있다가(새 탭이 활성 상태로 열리므로),
**리포트 다운로드에 성공하면** `background.js`가 `chrome.tabs.update`/`chrome.windows.update`로 원본
int-shipping 탭·창에 자동으로 포커스를 돌려준다. 사용자가 이미 할 일이 끝난 DHL 탭에 남아있다가 실수로
뭔가 누르는 걸 막기 위함. 실패했을 때는 DHL 화면에서 무슨 일이 있었는지 봐야 하므로 포커스를 옮기지 않는다.

## 범위 밖 (아직 자동화하지 않은 것 — 의도적)

- **재고차감**(`선택 주문 재고차감` 버튼): 실제 재고 수량이 바뀌는 동작이라 사람 개입 없이 실행하지 않음
- **원산지 확인 모달의 "확인 후 엑셀 생성"**: 통관 신고서(GMI)에 들어갈 원산지 코드는 사람이 검토해야 함
- PDF 라벨 저장 경로 지정 (크롬 기본 다운로드 폴더 사용)
- Pickup(수거예약) 페이지 자동화

## 신고 가액(Unit Price) 확인·수정 (2026-09-29)

DHL(DEC)에도 할인 금액이 들어가긴 하지만 Shopify와 정확히 일치하지 않는 경우가 많아(예: 3.20 → 3.21,
68.80 → 69.06) 담당자가 주문마다 확인·수정하던 작업을 자동화함. 흐름은 "읽기 → 비교·선택 → 수정 + 라벨 출력" 2단계.

1. **읽기** — int-shipping "라벨 자동 출력" → `DHL_AUTOMATE_READ` → `background.js`가 `DHL_READ_PRICES_START` 작업 시작.
   `content-orders.js`가 주문마다 목록에서 주문번호 링크로 상세 화면(`/orders/<탭>/<id>`)을 열어 Items 표의
   품목명/SKU/수량(Ship 컬럼 "of N")/Unit Price를 읽어 `dhlReadResults`에 모은다(아무것도 수정하지 않음).
   목록에서 못 찾은 주문은 `notFound`로 기록. 다 읽으면 `READ_DONE` → int-shipping에 `DHL_AUTOMATE_READ_DONE`,
   읽기용 DHL 탭은 닫고 int-shipping 탭으로 포커스 복귀.
2. **비교·선택** — int-shipping "DHL 신고 가액 확인" 창에서 Shopify 할인 적용 단가(`shopify-orders` 함수의
   `discountedUnitPrice`, 없으면 `price`)와 DHL 단가를 비교. 불일치 품목마다 **Shopify에 맞춤 / DHL 값 유지 / 직접 입력**
   선택(일괄 버튼 있음). 수량 불일치, DHL에 없는 품목, Shopify에 없는 DHL 품목, DHL에서 못 찾은 주문도 표시.
   최종 단가는 int-shipping localStorage(`dhlDeclaredPrices`)에 남아 GMI 수출신고 엑셀 단가로 쓰인다(두 서류 금액 일치).
3. **수정 + 라벨 출력** — 최종 단가가 DHL 값과 다른 품목만 `priceUpdates`(`rowIndex` 포함)로 `DHL_AUTOMATE`에 넘긴다.
   `content-orders.js`가 해당 주문 상세 화면에서 Unit Price 입력칸 수정 → `Save` → 새로고침 후 값이 실제로
   저장됐는지 확인(안 됐으면 1회 재시도) → 목록 복귀. 전부 끝나면 기존 라벨 출력 흐름으로 진행.
   품목을 못 찾거나 저장 확인에 실패하면 **라벨을 출력하지 않고 중단**한다.

- 셀렉터(2026-09-29 DHL 주문 상세 화면 기준): Items 표 `.ssit-order-detail-grid.order-items`,
  컬럼은 헤더 `th[data-text]`("SKU", "Ship", "Unit Price (USD)")로 찾음(컬럼 순서 변경 대비), 저장 `button.btn-order-save`.
- **가액만 확인·수정**: int-shipping에서 주문번호를 입력하면 `shopify-orders`의 `search`(`status: "any"`, 취소·발송완료
  주문 포함)로 주문을 불러와 같은 읽기 → 비교 과정을 거친 뒤, `DHL_AUTOMATE`에 `priceOnly: true`로 가액 수정만 하고
  라벨 출력/리포트는 건너뛴다(`dhlPriceOnly` → `PRICES_ONLY_DONE` → `DHL_AUTOMATE_PRICES_DONE`). DHL 탭은 결과 확인용으로 열어 둔다.
  Shopify 검색은 취소+환불+보관된 주문을 어떤 조건으로도 돌려주지 않아서(실측 #28783), 검색에 없으면 DHL 단가를 먼저 읽으면서
  주문 상세의 `Reference #`(= Shopify 주문 ID, `.ssit-order-desc-item`)를 가져와 `shopify-orders`의 `get`으로 직접 조회한다.
- 작업이 끝나면(성공/실패) `dhlTargetOrders`/`dhlPrice*`/`dhlRead*` 저장값을 지운다.

## 라벨 출력 안전장치 (2026-09-29, 확장 1.2)

"가액만 확인·수정"에서 라벨이 출력된 사고가 있어(#28783, 확장 파일 일부만 교체된 상태로 추정) 라벨 출력은
명시적으로 요청된 경우에만 하도록 바꿨다.

- 요청 종류 분리: 가액만 수정은 `DHL_PRICES_ONLY`(→ `DHL_PRICES_ONLY_START`), 라벨 작업은 `DHL_AUTOMATE` + `printLabels: true`.
  `content-bridge.js`와 `background.js` 둘 다 `printLabels: true`가 없는 라벨 요청은 거절한다.
- `content-orders.js`는 저장값 `dhlPrintLabels === true`(라벨 작업으로 시작된 경우에만 설정)일 때만 라벨을 출력한다.
- 버전 확인: `content-bridge.js`가 `DHL_EXT_HELLO { version }`(manifest 버전)을 알리고, int-shipping은 1.2 미만이거나
  응답이 없으면 요청을 보내지 않는다. **확장 파일은 항상 폴더 전체를 교체할 것.**
