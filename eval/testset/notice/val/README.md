# Val-notice (공고문 추출 개발셋)

**여기 있는 공고문은 Val이다. Test가 아니다.**
추출 규칙·프롬프트를 고칠 때 보는 건 이 폴더뿐이다. eval.md: "Test로 튜닝하면 그 순간 Test가 아니다."

| 파일 | 출처 | Stage 0 (전사) | 난이도 태그 |
|---|---|---|---|
| hana_ai_video.txt | 하나손해보험 AI 영상 광고 공모전 (이미지 1장) | 사람 수기 전사 | `date_no_day`(시상식 10월 예정), `two_column`, `phone_number_noise` |
| kamp_6th.txt | 제6회 K-인공지능 제조데이터 분석 경진대회 (포스터) | 사람 수기 전사 | `header_value_split`(접수기간), `schedule_table`, `person_count_in`(3인), `prize_table_noise` |

전사는 Gemini가 아니라 사람이 했다. Gemini 전사본으로 교체하면 이 표에 기록하고,
전사 오류가 섞이면 추출 성능과 분리해서 봐야 한다.

정답 라벨(anchors)은 아직 붙이지 않았다. F1을 재려면 `*.gold.json`이 필요하다.
