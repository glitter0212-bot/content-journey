# 보험 콘텐츠 여정 (Vercel 배포용)

오가닉 콘텐츠(유튜브·블로그·카페·인스타·꿀팁게시판) → 보험 랜딩 → 상담 신청까지의 흐름을 보여 주는 웹 대시보드입니다.
페이지를 열 때마다 Mixpanel과 구글 시트 '콘텐츠 보드'를 읽습니다(같은 기간은 30분 캐시).

| 화면 | 내용 |
|---|---|
| 흐름 | 핵심 숫자 4개, 채널 → 콘텐츠 → 상담 신청/미신청 흐름도 |
| 채널 성과 | 채널별 합계 표, 주별 랜딩 유저 추이 |
| 콘텐츠 성과 | Mixpanel 키가 있는 콘텐츠별 조회수·유저·상담·CPA |
| 제작 파이프라인 | 콘텐츠 보드의 단계별 카드 |
| 단어 정의 | 숫자 정의 |

## 구조

```
index.html, assets/       화면 (정적 파일)
api/data.py               GET /api/data?start=YYYY-MM-DD&end=YYYY-MM-DD
api/login.py              GET/POST/DELETE /api/login (비밀번호 로그인)
api/_core.py              Mixpanel·시트 읽기, 로그인 토큰
dev_server.py, dev/       로컬 미리보기 전용 (배포에서 빠짐)
```

## 배포 순서

### 1. 키 준비 (한 번만)

1. **Mixpanel 서비스 계정**: Mixpanel → Organization Settings → Service Accounts → Add.
   프로젝트 AJD(3970973)에 Analyst 이상 권한을 주고 username·secret을 받아 둡니다.
2. **구글 서비스 계정**: Google Cloud 콘솔에서 서비스 계정을 만들고 Google Sheets API를 켠 뒤 JSON 키를 내려받습니다.
   콘텐츠 운영 보드 시트를 그 서비스 계정 이메일(`...@...iam.gserviceaccount.com`)에 **뷰어**로 공유합니다.
   (insurance-mk-dashboard에서 이미 쓰는 서비스 계정이 있으면 같은 계정에 이 시트만 추가로 공유해도 됩니다.)

### 2. Vercel에 올리기

GitHub 저장소로 올리는 방법(권장) 또는 Vercel CLI 중 하나를 씁니다.

- **GitHub**: 이 `content-journey` 폴더를 저장소로 올리고 Vercel → Add New → Project에서 가져옵니다.
  Framework Preset은 **Other**, Root Directory는 저장소 안에서 이 폴더가 있는 위치로 둡니다.
- **CLI**: Node.js 설치 후 이 폴더에서 `npx vercel` → 안내대로 프로젝트를 만들고, 마지막에 `npx vercel --prod`.

### 3. 환경 변수 (Vercel → Project → Settings → Environment Variables)

| 이름 | 값 |
|---|---|
| `DASHBOARD_PASSWORD` | 팀이 쓸 비밀번호. 비우면 로그인 없이 누구나 열 수 있으니 꼭 넣으세요. |
| `SESSION_SECRET` | 32자 이상 아무 문자열 |
| `MIXPANEL_SA_USERNAME` / `MIXPANEL_SA_SECRET` | 1-1에서 받은 값 |
| `MIXPANEL_PROJECT_ID` | `3970973` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 1-2의 JSON 파일 내용 전체 (한 줄로) |
| `BOARD_SHEET_ID` | `11VR6Ft82By0vtfosHL5Fb9ofrvz52vBMw6dna1WCP_w` |

넣은 뒤 Deployments에서 **Redeploy** 해야 반영됩니다.

### 4. 확인

배포 주소를 열고 비밀번호로 들어가 흐름 화면에 숫자가 나오는지 봅니다.
오류가 나면 화면 위 빨간 줄에 원인이 그대로 나옵니다(예: 서비스 계정 권한, 시트 공유 누락, 머리글 이름 변경).

## 로컬 미리보기

```
python dev_server.py
```

http://localhost:8765 . `.env.example`을 `.env`로 복사해 키를 채우면 실제 데이터를, 키가 없으면 `dev/snapshot.json`(2026-10-28 값)을 보여 줍니다.

## 알아 둘 점

- **랜딩 유저·상담 신청**은 Mixpanel Segmentation API의 일별 고유 사용자 수를 기간만큼 더한 값입니다.
  같은 사람이 여러 날 오면 여러 번 셉니다. claude.ai 대시보드(기간 전체 고유 사용자)보다 조금 클 수 있습니다.
- **콘텐츠 보드 열**은 머리글 이름(채널, 콘텐츠 주제, 현재 단계, 담당자, 발행일, Mixpanel 키 (utm_content 일부), 조회수, 비용(원))으로 찾습니다.
  이 이름을 바꾸면 화면에 어떤 머리글이 없는지 오류로 나옵니다. 다른 열을 추가하는 것은 괜찮습니다.
- 데이터 파일은 배포에 포함되지 않고, 숫자는 로그인한 사람의 요청에만 응답합니다.

