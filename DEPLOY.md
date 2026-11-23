# 보험 콘텐츠 여정 — 배포 안내 (Vercel)

이 폴더를 Vercel에 올리면 **비밀번호로 들어가는 웹 대시보드**가 됩니다.
페이지를 열 때마다 서버가 Mixpanel과 구글 시트 '콘텐츠 보드'를 읽습니다(같은 기간은 30분 캐시). 보는 사람에게 커넥터가 없어도 최신 값이 나옵니다.

- 대시보드: `https://<프로젝트>.vercel.app/`
- 주간 보고서: `https://<프로젝트>.vercel.app/report/weekly-report.html` (로그인 없이 열림, 아래 '유의' 참고)

배포 파일 묶음: `content-journey-deploy.zip` (이 폴더에서 로컬 전용 파일과 데이터를 뺀 것)

> 가장 빠른 길: eta-bay(손익/장기보험 실적 대시보드)를 올린 담당자에게 zip과 아래 환경 변수 표를 넘기세요. 키를 이미 갖고 있고 Vercel도 익숙합니다.

---

## 1. 키 준비 (한 번만)

1. **Mixpanel 서비스 계정**: Mixpanel → Organization Settings → Service Accounts.
   프로젝트 AJD(3970973)에 Analyst 이상 권한이 있는 계정의 username·secret. eta-bay가 쓰는 것을 재사용해도 됩니다.
2. **구글 서비스 계정 JSON**: Google Sheets API가 켜진 서비스 계정의 JSON 키. eta-bay 것을 재사용해도 됩니다.
3. **시트 공유**: JSON 안의 `client_email`(`...@...iam.gserviceaccount.com`)을 아래 시트에 **뷰어**로 공유합니다.
   - 콘텐츠 운영 보드 `11VR6Ft82By0vtfosHL5Fb9ofrvz52vBMw6dna1WCP_w` (필수)
   - 상담 DB(접수) `14jsEGRKFuigYEoC61vk57KcrBBAxAzQ9V9VslKyMQY4` (선택. 없으면 접수 현황만 빠지고 나머지는 정상)

## 2. Vercel에 올리기 (git 없이 가능한 방법)

1. GitHub에서 **비공개(Private)** 저장소를 새로 만듭니다.
2. 저장소 화면 → **Add file → Upload files** → `content-journey-deploy.zip`을 푼 폴더 안의 파일·폴더를 모두 끌어다 놓고 Commit.
3. Vercel → **Add New → Project** → 방금 만든 저장소 Import.
   - Framework Preset: **Other**
   - Root Directory: 저장소 맨 위(그대로)
   - Build·Output 설정은 비워 둡니다.
4. Deploy 전에(또는 직후) 아래 3번 환경 변수를 넣고 **Redeploy** 합니다.

Node.js가 있으면 CLI도 됩니다: zip을 푼 폴더에서 `npx vercel` → 안내대로 → `npx vercel --prod`.

## 3. 환경 변수 (Vercel → Project → Settings → Environment Variables)

| 이름 | 값 |
|---|---|
| `DASHBOARD_PASSWORD` | 팀이 쓸 비밀번호. **비우면 누구나 열 수 있으니 꼭 넣으세요.** |
| `SESSION_SECRET` | 32자 이상 아무 문자열 |
| `MIXPANEL_SA_USERNAME` | 1-1의 username |
| `MIXPANEL_SA_SECRET` | 1-1의 secret |
| `MIXPANEL_PROJECT_ID` | `3970973` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | 1-2의 JSON 파일 내용 전체(한 줄) |
| `BOARD_SHEET_ID` | `11VR6Ft82By0vtfosHL5Fb9ofrvz52vBMw6dna1WCP_w` |
| `INTAKE_SHEET_ID` | `14jsEGRKFuigYEoC61vk57KcrBBAxAzQ9V9VslKyMQY4` |

넣은 뒤 Deployments에서 **Redeploy** 해야 반영됩니다.

## 4. 확인

배포 주소 → 비밀번호로 로그인 → 흐름 화면에 숫자가 나오면 성공입니다.
오류가 나면 화면 위 빨간 줄에 원인이 그대로 나옵니다(예: Mixpanel 401 = 서비스 계정 키·권한, Google Sheets 403 = 시트 공유 누락, 머리글을 찾지 못함 = 콘텐츠 보드 머리글 이름 변경).

## 유의

- 서버는 측정 시작일(8/24)부터 오늘까지를 **한 번에** 받아 한 시간 동안 재사용하고, 기간 버튼은 화면에서 잘라 계산합니다. 그래서 기간을 바꿔도 Mixpanel을 다시 부르지 않습니다.
- 새로 받을 때 Mixpanel 조회가 9번 나갑니다. Mixpanel 조회 한도는 **프로젝트당 시간당 60회·동시 5회**이고 eta-bay와 같이 씁니다. 한도에 걸리면 서버가 잠깐 쉬었다 두 번 다시 시도하고, 그래도 안 되면 "조회 한도를 넘었습니다" 안내가 나옵니다(몇 분 뒤 새로고침).
- **주간 보고서(`/report/weekly-report.html`)와 `홈.html`은 로그인 없이 열리는 정적 페이지**입니다. 주소를 아는 사람은 누구나 볼 수 있으니 외부에 주소를 공유하지 마세요. 꼭 막아야 하면 Vercel의 Deployment Protection(Pro)을 켜세요.
- 계산 규칙은 PC 파일(`dev/refresh_snapshot.py`)·claude.ai 페이지(`assets/live.js`)와 같습니다. 셋 중 하나를 고치면 나머지도 같이 고쳐야 숫자가 맞습니다.
- `dev/`(스냅샷·원본 데이터), `dist/`, `dev_server.py`, `build_html.py`는 배포에 넣지 않습니다.
