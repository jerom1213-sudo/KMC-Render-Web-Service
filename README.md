# 휴대폰용 반경 상권분석 앱

## 구조
- 휴대폰: PWA 앱(홈 화면 설치 가능)
- 서버: Node.js 백엔드
- 인증키: 서버 환경변수 `PUBLIC_DATA_SERVICE_KEY`에만 저장
- 지도: Leaflet + OpenStreetMap(지도 키 불필요)

## 주요 기능
- 주소 입력 및 50~2,000m 반경 조회
- 공공데이터포털 상가(상권)정보 API 연동
- 업종 대분류별 서로 다른 색상 마커
- 업종별 점포 수 및 업종 필터
- 상호·업종·주소 검색
- CSV 저장
- Android/iPhone 홈 화면 설치

## 서버에서 실행
Node.js 18 이상에서 다음과 같이 실행함.

### Windows PowerShell
```powershell
$env:PUBLIC_DATA_SERVICE_KEY="본인의_공공데이터_인증키"
node server.mjs
```

### Linux/macOS
```bash
PUBLIC_DATA_SERVICE_KEY='본인의_공공데이터_인증키' node server.mjs
```

브라우저에서 `http://localhost:3000`으로 접속함.

## 휴대폰에서 독립 앱으로 사용
PWA의 서비스워커와 설치 기능은 HTTPS 환경에서 가장 안정적으로 동작함. 이 프로젝트를 Render, Railway, Fly.io, VPS, NAS 리버스프록시 등 HTTPS 서버에 배포한 뒤 해당 주소를 휴대폰에서 열면 됨.

### Android
Chrome으로 앱 주소 접속 → 메뉴 → `앱 설치` 또는 화면의 `앱 설치` 버튼을 선택함.

### iPhone/iPad
Safari로 앱 주소 접속 → 공유 버튼 → `홈 화면에 추가`를 선택함.

## 중요 보안 원칙
`PUBLIC_DATA_SERVICE_KEY`를 `public/` 폴더의 HTML/JS 파일 또는 모바일 앱 소스에 직접 넣으면 안 됨. 인증키는 서버의 환경변수/Secret에만 저장해야 함.

## 기본 분석값
- 주소: 광주광역시 서구 풍암동 1074
- 반경: 500m
