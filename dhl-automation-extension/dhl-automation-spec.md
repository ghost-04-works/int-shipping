# DHL Express Commerce 자동화 크롬 확장 — 설계 문서

## 배경 / 목적
`int-shipping` 웹 툴(https://ghost-04-works.github.io/int-shipping/)에서 체크한 발송 대상 주문을,
DHL Express Commerce(https://app2.dhlexpresscommerce.com) 사이트에 매번 수동으로 들어가서
① 주문 체크 → 라벨 출력, ② 리포트 생성 → 다운로드 하지 않고
크롬 확장 프로그램이 자동으로 처리하게 만드는 것이 목표.

DHL 공식 API(MyDHL API)는 존재하지만 계정 매니저를 통한 별도 승인 절차가 필요해 시간이 걸림.
이 확장은 그 사이 임시(또는 병행) 대안으로, DHL Express Commerce의 웹 화면을 자동 조작한다.

## 전체 흐름
1. `int-shipping` 웹 툴에서 사용자가 DHL 발송 대상 주문들을 체크박스로 선택
2. 웹 툴에 새로 추가할 **"라벨 자동 출력"** 버튼 클릭
3. 웹 툴이 선택된 주문번호 목록(`["#28346", "#28345", ...]`)을 크롬 확장으로 전달
4. 확장이 새 탭에서 `app2.dhlexpresscommerce.com/orders` 를 열고:
   - 목록에 있는 주문번호와 일치하는 테이블 행의 체크박스를 자동으로 체크
   - 페이지네이션(50개씩)이 있으므로 여러 페이지에 걸쳐 있으면 페이지 넘기며 반복
   - 전부 체크되면 상단 액션바의 **"Print shipping labels"** 버튼 클릭 → PDF 다운로드 트리거
5. 이어서 확장이 `app2.dhlexpresscommerce.com/reports` 로 이동:
   - **"GENERATE REPORT"** 클릭
   - 오늘 날짜(QUEUED DATE 기준) 행이 상태 "Ready"가 될 때까지 주기적으로 새로고침/폴링
   - Ready 확인되면 그 행의 **"DOWNLOAD XLSX"** 클릭 → 파일 다운로드
6. 다운로드된 xlsx 파일은 지금처럼 사용자가 `int-shipping` 웹 툴의 "DHL 리포트 업로드" 입력창에
   직접 드래그해서 넣는 것으로 마무리 (파일시스템 접근은 범위 밖으로 남겨둠 — 아래 "범위 밖" 참조)

## 크롬 확장 구조 (Manifest V3)

```
dhl-automation-extension/
├── manifest.json
├── background.js          # 서비스 워커: 메시지 중계, 탭 생성/전환
├── content-orders.js      # app2.dhlexpresscommerce.com/orders 에 주입
├── content-reports.js     # app2.dhlexpresscommerce.com/reports 에 주입
├── content-bridge.js      # int-shipping 페이지에 주입 (웹 페이지 ↔ 확장 통신 다리)
└── icons/
```

### manifest.json 핵심 설정
```json
{
  "manifest_version": 3,
  "name": "GEONWORKS DHL 자동화",
  "version": "1.0",
  "permissions": ["tabs", "scripting", "storage"],
  "host_permissions": [
    "https://app2.dhlexpresscommerce.com/*",
    "https://ghost-04-works.github.io/*"
  ],
  "background": { "service_worker": "background.js" },
  "content_scripts": [
    {
      "matches": ["https://ghost-04-works.github.io/int-shipping/*"],
      "js": ["content-bridge.js"]
    },
    {
      "matches": ["https://app2.dhlexpresscommerce.com/orders*"],
      "js": ["content-orders.js"]
    },
    {
      "matches": ["https://app2.dhlexpresscommerce.com/reports*"],
      "js": ["content-reports.js"]
    }
  ]
}
```

## 웹 페이지 ↔ 확장 통신 방식
- `int-shipping/index.html`에 "라벨 자동 출력" 버튼 추가
- 클릭 시 `window.postMessage({ type: "DHL_AUTOMATE", orderNumbers: [...] }, "*")` 발행
- `content-bridge.js`가 이 메시지를 수신해서 `chrome.runtime.sendMessage`로 백그라운드에 전달
- 백그라운드가 새 탭으로 `/orders` 오픈, `content-orders.js`에 주문번호 목록을 `chrome.storage.local`에 저장해두고 전달
- 각 content script는 자기 작업이 끝나면 `chrome.runtime.sendMessage`로 상태를 백그라운드에 보고
- 백그라운드는 진행상황을 다시 `content-bridge.js` 경유로 원래 `int-shipping` 탭에 돌려보내 화면에 진행률 표시

## content-orders.js 로직 (의사코드)
```js
const targetOrderNumbers = await getFromStorage(); // ["#28346", ...]
let remaining = new Set(targetOrderNumbers);

async function processCurrentPage() {
  const rows = document.querySelectorAll("table tbody tr"); // 실제 셀렉터는 DOM 확인 후 조정
  for (const row of rows) {
    const orderNoText = row.querySelector('[class*="order"]')?.textContent?.trim();
    if (remaining.has(orderNoText)) {
      row.querySelector('input[type="checkbox"]')?.click();
      remaining.delete(orderNoText);
    }
  }
}

async function goToNextPageIfNeeded() {
  if (remaining.size === 0) return false;
  const nextBtn = document.querySelector('[aria-label="next page"], .pagination-next');
  if (nextBtn && !nextBtn.disabled) {
    nextBtn.click();
    await waitForTableReload();
    return true;
  }
  return false;
}

// 메인 루프: 현재 페이지 처리 → 남은 게 있으면 다음 페이지로 → 반복
// 다 끝나면 "Print shipping labels" 버튼 클릭
```

**주의**: 실제 DOM 클래스명/셀렉터는 위 스크린샷만으로는 정확히 알 수 없음.
Claude Code에서 개발자도구(F12)로 실제 HTML 구조를 확인하며 셀렉터를 채워야 함.

## content-reports.js 로직 (의사코드)
```js
document.querySelector('button:has-text("GENERATE REPORT")')?.click(); // 실제로는 텍스트 매칭 함수 필요

async function pollForReady() {
  const todayStr = formatDate(new Date()); // "30.07.26" 형식 등, 실제 표시 포맷 확인 필요
  for (let i = 0; i < 30; i++) { // 최대 30회 폴링 (예: 10초 간격 = 5분)
    location.reload(); // 또는 새로고침 버튼이 있으면 그걸 클릭
    await sleep(10000);
    const row = findRowByQueuedDate(todayStr);
    if (row && row.status === "Ready") {
      row.querySelector('button:contains("DOWNLOAD XLSX")')?.click();
      return true;
    }
  }
  return false; // 타임아웃 — 사용자에게 알림
}
```

## 범위 밖(이번 단계에서 하지 않는 것)
- **다운로드된 xlsx 파일을 자동으로 int-shipping 웹 툴에 넣어주는 것**: 크롬 확장이 다운로드 폴더의 파일을
  읽어서 웹 페이지로 전달하려면 `chrome.downloads` API + 파일 읽기 권한이 추가로 필요하고 복잡도가 커짐.
  1단계는 "자동으로 다운로드까지" 만 하고, 웹 툴에 넣는 건 지금처럼 사용자가 파일 하나 드래그하는 걸로 유지.
- **PDF 라벨 자동 저장 경로 지정**: 크롬 기본 다운로드 동작(다운로드 폴더에 저장) 그대로 사용.
- **Pickup(수거예약) 페이지 자동화**: 포장 완료 후 별도 절차라 이번 범위에서 제외.

## 개발 진행 방법 제안
1. Claude Code를 열고 이 문서를 프로젝트에 붙여넣기
2. 먼저 `content-orders.js`부터 — 실제 DHL Express Commerce `/orders` 페이지에서 개발자도구로
   체크박스/버튼의 실제 셀렉터를 확인하며 채워넣기
3. 로컬에서 크롬 "압축해제된 확장 프로그램 로드"로 테스트
4. 되면 `content-reports.js` 진행
5. 마지막으로 `int-shipping`에 "라벨 자동 출력" 버튼 + `content-bridge.js` 연결
