# MQ Watcher

ActiveMQ Persistent Store와 Temp Store를 브라우저에서 읽기 전용으로 탐색하는 로컬 forensic viewer입니다. 장애 원인을 자동 판정하지 않고, 파일에서 직접 확인되는 문자열·ID·메타데이터와 다음 소스 조사 방향을 연결합니다.

이 프로젝트는 특정 제품 공급사와 제휴하거나 공식 지원을 받는 도구가 아닙니다. 저장 형식과 동작은 제품 버전에 따라 달라질 수 있으므로, 화면에 표시되는 패턴 해석은 반드시 해당 버전의 소스·운영 자료와 대조해야 합니다.

## Runtime

- Node.js 22.13 이상
- Chrome 또는 Edge 최신 버전
- 로컬 주소(`localhost`)에서 File System Access API 사용

## Development

```bash
npm install
npm run dev
```

기본 개발 주소는 `http://localhost:3000`입니다.

## Interface

- 한국어와 영어를 전환할 수 있으며 메뉴, 설명, 필드명과 상태 문구가 함께 바뀝니다.
- 목적지, 구독자, 메시지, 파일 목록은 각 열 제목으로 오름차순·내림차순 정렬할 수 있습니다.
- 목록은 페이지당 25·50·100개 단위로 탐색할 수 있습니다.
- 제품 버전에 따라 달라질 수 있는 클래스 정보는 고정 사전으로 제공하지 않고, 선택한 증거의 상세 화면에서 관련 소스 확인 후보만 안내합니다.

## Build and test

```bash
npm run build
npm run lint
```

## Data handling

- 브라우저에는 디렉터리의 읽기 핸들만 요청합니다.
- Broker 연결, Store recovery, 메시지 삭제, 파일 수정·rename을 수행하지 않습니다.
- 파일은 Worker에서 4MB 청크로 읽으며 전체 파일을 DOM 또는 메인 스레드 메모리에 적재하지 않습니다.
- 스캔 결과 캐시는 브라우저 IndexedDB에 저장되며 원본 Store와 분리됩니다.
- 선택한 파일과 분석 결과를 서버나 외부 서비스로 전송하는 애플리케이션 코드는 없습니다.
- 분석 결과에는 목적지명, Consumer ID와 printable 문자열 등 운영 식별자가 포함될 수 있습니다. 공용 PC에서는 사용하지 말고, 화면 캡처나 내보낸 결과를 공유하기 전에 민감정보를 확인하세요.
- 브라우저 사이트 데이터를 지우면 IndexedDB에 저장된 분석 캐시도 제거할 수 있습니다.
- 해석할 수 없는 값은 `Unknown`으로 유지합니다.

## Main files

- `app/components/StoreExplorer.tsx`: 탐색 UI와 디렉터리 선택
- `app/lib/i18n.tsx`: 한국어·영어 UI 문자열과 언어 상태
- `public/store-scanner.worker.js`: 청크 스캔과 MQ 엔터티 후보 추출
- `app/lib/scan-cache.ts`: 브라우저 로컬 스캔 결과 캐시
- `app/globals.css`: 밝은/어두운 운영 도구 테마

## Parsing boundary

현재 구현은 파일 배치, 파일명, printable ASCII 문자열, Consumer ID 형태 및 제한된 HEX 문맥을 분석합니다. 제품 JAR 로딩, OpenWire 전체 역직렬화, bytecode 분석 및 자동 RCA는 범위에 포함하지 않습니다.

## License

[MIT License](LICENSE)
