"""Clearly labelled, fictional job postings for testing the local UI offline."""
from __future__ import annotations

from datetime import date, timedelta


def demo_jobs() -> tuple[tuple[str, dict], ...]:
    """Return stable demo postings associated with their interest category."""
    rows = (
        ("ai_data", "ai-data-analyst", "데이터포레스트 (가상)", "데이터 분석가", "서울 · 경력 무관",
         "SQL과 Python으로 고객 행동 데이터를 정리하고 핵심 지표를 분석합니다. 대시보드와 데이터 시각화를 만들고 실험 결과를 제품팀에 설명합니다. 통계 분석 경험을 우대합니다."),
        ("ai_data", "ml-engineer", "뉴런웍스 (가상)", "머신러닝 엔지니어", "서울 · 경력 2년 이상",
         "Python과 PyTorch로 추천·분류 모델을 개발하고 성능을 평가합니다. Docker와 AWS 환경에 추론 API를 배포합니다. 데이터 파이프라인 및 모델 모니터링 경험을 우대합니다."),
        ("ai_data", "rag-engineer", "리프AI (가상)", "생성형 AI 엔지니어", "경기 · 신입 지원 가능",
         "Python, FastAPI, RAG를 활용해 사내 문서 검색 서비스를 만듭니다. LangChain으로 검색 파이프라인을 구성하고 SQL 기반 평가 데이터를 관리합니다. Git 협업과 Docker 사용 경험을 우대합니다."),
        ("software", "frontend-engineer", "파도소프트 (가상)", "프론트엔드 개발자", "서울 · 경력 1~3년",
         "React와 TypeScript로 웹 서비스를 개발하고 접근성과 화면 성능을 개선합니다. Next.js, REST API, Git 협업 경험이 필요하며 사용자 행동 분석과 디자인 시스템 운영 경험을 우대합니다."),
        ("software", "backend-engineer", "브릿지랩 (가상)", "백엔드 개발자", "서울 · 경력 2년 이상",
         "Java와 Spring으로 REST API 및 서비스 기능을 개발합니다. SQL 데이터베이스 설계와 테스트 자동화를 담당합니다. AWS, Docker, Kubernetes 기반 배포 경험을 우대합니다."),
        ("software", "mobile-engineer", "모바일온 (가상)", "모바일 앱 개발자", "원격 · 경력 무관",
         "Kotlin 또는 Swift로 모바일 앱의 신규 기능을 개발합니다. REST API 연동, 오류 분석, 앱 성능 개선을 맡습니다. React Native와 자동화 테스트 경험이 있으면 좋습니다."),
        ("product", "service-planner", "오늘의발견 (가상)", "서비스 기획자", "서울 · 경력 1년 이상",
         "사용자 조사와 데이터 분석을 바탕으로 서비스 기획 및 요구사항 정의를 합니다. 화면 흐름과 정책을 문서화하고 개발·디자인 일정과 우선순위를 조정합니다. Figma와 SQL 활용 경험을 우대합니다."),
        ("product", "product-manager", "클리어패스 (가상)", "프로덕트 매니저", "서울 · 경력 3년 이상",
         "제품 로드맵과 분기 목표를 관리하고 A/B 테스트 결과로 우선순위를 결정합니다. 제품 지표를 분석해 개선안을 제안하고 엔지니어·디자이너와 협업합니다. SQL, GA4, 애자일 프로젝트 관리 경험을 우대합니다."),
        ("product", "business-planner", "그로우메이트 (가상)", "사업 기획 담당자", "대전 · 신입 지원 가능",
         "시장 및 경쟁사 자료를 조사해 신규 사업 기획과 실행 계획을 작성합니다. Excel로 비용과 핵심 지표를 정리하고 유관 부서의 일정을 조율합니다. 데이터 분석과 프레젠테이션 경험을 우대합니다."),
        ("design", "uxui-designer", "모아앱 (가상)", "UX/UI 디자이너", "서울 · 경력 1~3년",
         "사용자 인터뷰와 사용성 테스트를 진행해 문제를 정의합니다. Figma로 와이어프레임과 프로토타입을 만들고 개발팀과 화면 품질을 확인합니다. 접근성 및 디자인 시스템 경험을 우대합니다."),
        ("design", "ux-researcher", "사람과제품 (가상)", "UX 리서처", "서울 · 경력 2년 이상",
         "정성·정량 사용자 조사와 사용성 테스트를 설계하고 결과를 분석합니다. 리서치 근거를 제품 로드맵과 서비스 기획에 연결합니다. 인터뷰 진행 및 데이터 시각화 경험을 우대합니다."),
        ("design", "brand-designer", "오렌지스튜디오 (가상)", "브랜드 디자이너", "부산 · 경력 무관",
         "브랜드 캠페인과 디지털 콘텐츠의 시각 디자인을 담당합니다. Figma와 Adobe 도구로 시안을 제작하고 마케팅팀과 카피라이팅·콘텐츠 기획 방향을 맞춥니다. 편집 디자인 경험을 우대합니다."),
        ("marketing", "content-marketer", "페이지앤코 (가상)", "콘텐츠 마케터", "서울 · 경력 무관",
         "고객 인터뷰와 검색어 분석을 바탕으로 콘텐츠 기획과 카피라이팅을 합니다. 블로그 SEO 성과를 추적하고 GA4로 유입·전환 지표를 분석합니다. 뉴스레터와 브랜드 문서 작성 경험을 우대합니다."),
        ("marketing", "performance-marketer", "픽셀웨이브 (가상)", "퍼포먼스 마케터", "서울 · 경력 1년 이상",
         "검색·소셜 광고 캠페인을 운영하고 전환율과 광고비를 관리합니다. GA4와 Excel로 퍼포먼스 마케팅 데이터를 분석하고 A/B 테스트를 설계합니다. CRM 및 SQL 경험을 우대합니다."),
        ("marketing", "community-marketer", "함께성장 (가상)", "커뮤니티 마케터", "원격 · 경력 무관",
         "온라인 커뮤니티 운영과 SNS 콘텐츠 제작을 맡습니다. 콘텐츠 캘린더를 관리하고 고객 피드백을 요약해 제품팀에 전달합니다. 이벤트 기획과 카피라이팅, 고객 관리 경험을 우대합니다."),
        ("sales", "b2b-sales", "클라우드브릿지 (가상)", "B2B 영업 담당자", "서울 · 경력 1년 이상",
         "기업 고객을 발굴하고 요구사항에 맞는 SaaS 솔루션을 제안합니다. 영업 파이프라인과 CRM 기록을 관리하며 협상 및 계약 일정을 조율합니다. 사업개발과 발표 경험을 우대합니다."),
        ("sales", "business-development", "로컬링크 (가상)", "사업개발 매니저", "서울 · 경력 2년 이상",
         "시장 조사를 통해 신규 파트너십과 사업개발 기회를 찾습니다. B2B 제휴 제안, 조건 협상, 출시 일정 관리를 맡습니다. 데이터 분석과 프로젝트 관리 경험을 우대합니다."),
        ("sales", "customer-success", "안심클라우드 (가상)", "고객 성공 매니저", "경기 · 신입 지원 가능",
         "도입 고객의 온보딩과 사용 교육을 지원하고 문의를 해결합니다. 고객 관리 지표를 정리해 이탈 위험을 알리고 제품팀과 개선을 조율합니다. SQL, CRM, B2B 커뮤니케이션 경험을 우대합니다."),
        ("business", "recruiter", "좋은동료들 (가상)", "채용 담당자", "서울 · 경력 무관",
         "채용 계획에 따라 공고 작성, 후보자 소통, 면접 일정 조율을 담당합니다. 채용 데이터를 정리해 채용 현황을 공유합니다. 인터뷰 운영, 문서화, 커뮤니케이션 경험을 우대합니다."),
        ("business", "people-ops", "팀포레스트 (가상)", "인사 운영 담당자", "서울 · 경력 1년 이상",
         "입퇴사와 인사 운영 프로세스를 관리하고 구성원 문의에 답합니다. Excel로 인사 데이터를 점검하고 급여 및 노무 업무를 지원합니다. HR 시스템과 개인정보 보호 경험을 우대합니다."),
        ("business", "finance-assistant", "작은성장 (가상)", "경영지원·회계 담당자", "인천 · 신입 지원 가능",
         "지출 증빙과 월별 회계 자료를 정리하고 재무 보고를 지원합니다. Excel과 회계 도구로 자료를 대조하며 부서별 운영 요청을 처리합니다. 예산 관리와 문서화 경험을 우대합니다."),
    )
    today = date.today()
    return tuple((category, {
        "source": "demo",
        "source_id": source_id,
        "source_name": "CareerFlow 추천",
        "company": company.removesuffix(" (가상)"),
        "position": position,
        "description": description,
        "source_url": "",
        "location": location.split(" · ", 1)[0],
        "job_type": "정규직",
        "salary": "회사 내규에 따름",
        "career": location.split(" · ", 1)[-1],
        "deadline": (today + timedelta(days=14 + index % 14)).isoformat(),
        "posted_at": (today - timedelta(days=index % 6)).isoformat(),
    }) for index, (category, source_id, company, position, location, description) in enumerate(rows))


def seed_demo_jobs(store) -> int:
    """Insert or refresh the local fixture catalogue without duplicate records."""
    grouped: dict[str, list[dict]] = {}
    for category, job in demo_jobs():
        grouped.setdefault(category, []).append(job)
    return sum(store.upsert_catalog(items, category) for category, items in grouped.items())
