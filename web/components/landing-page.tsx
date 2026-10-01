'use client';
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  sceneProgress,
  frameAt,
  raceClock,
  featureAt,
  cursorAt,
  rollAt,
} from '@/lib/landing-race.mjs';
import './landing.css';

const START = '/workspace?create=1';

type Key = { t: number; k?: string; x?: number; y?: number; press?: boolean };
// 모니터 속 화면별 커서 경로. k는 data-k 요소의 가운데, 없으면 x·y(화면 기준 %).
const CURSOR: Key[][] = [
  [
    { t: 0, x: 62, y: 96 },
    { t: 0.62, k: 'start' },
    { t: 0.78, k: 'start', press: true },
    { t: 1, k: 'start' },
  ],
  [
    { t: 0, x: 80, y: 96 },
    { t: 0.26, k: 'assign' },
    { t: 0.3, k: 'assign', press: true },
    { t: 0.5, k: 'harin' },
    { t: 0.56, k: 'harin', press: true },
    { t: 0.85, x: 86, y: 92 },
  ],
  [
    { t: 0, x: 70, y: 96 },
    { t: 0.45, k: 'day5' },
    { t: 1, k: 'day5' },
  ],
];

// "0,2,0.35,0.5|2,-1,0.68,0.8" → [[0,2,0.35,0.5],[2,-1,0.68,0.8]]
const parseRoll = (s: string) =>
  s.split('|').map((seg) => seg.split(',').map(Number));
const signed = (v: number, unit: string) =>
  (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + unit;

export function LandingPage() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current!;
    const hero = root.querySelector<HTMLElement>('.hero')!;
    const rules = root.querySelector<HTMLElement>('#rules')!;
    const setup = root.querySelector<HTMLElement>('#setup')!;
    const setupStage = setup.querySelector<HTMLElement>('.stage')!;
    const screen = setup.querySelector<HTMLElement>('.screen')!;
    const cursor = screen.querySelector<SVGElement>('.cursor')!;
    const items = [...setup.querySelectorAll<HTMLElement>('.feat-list li')];
    const panes = [...setup.querySelectorAll<HTMLElement>('.pane')];
    const menu = [...setup.querySelectorAll<HTMLElement>('.app-side [data-pane]')];
    // 고정 구간(data-pin)마다 진행률 --p를 주고, 안쪽 [data-on] 요소를 켜고 끈다.
    const pins = [...root.querySelectorAll<HTMLElement>('[data-pin]')];
    const checkin = root.querySelector<HTMLElement>('#checkin')!;
    const finish = root.querySelector<HTMLElement>('#finish')!;
    const hud = root.querySelector<HTMLElement>('.hud')!;
    const hudDay = hud.querySelector<HTMLElement>('.hud-day')!;
    const hudClock = hud.querySelector<HTMLElement>('.hud-clock')!;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const phone = matchMedia('(max-width: 767px)');
    const finePointer = matchMedia('(pointer: fine)');
    const videos = [...root.querySelectorAll<HTMLVideoElement>('video[data-src]')];
    // 휴대폰·동작 줄이기에서는 영상을 받지 않고 포스터만 보여 준다.
    if (!reduced.matches && !phone.matches) {
      for (const v of videos) v.src = v.dataset.src!;
    }
    // 영상별 목표 시각. 탐색이 끝나면(seeked) 그사이 바뀐 목표로 다시 맞춘다.
    const targets = new Map<HTMLVideoElement, number>();
    let frame = 0;

    function scrub(v: HTMLVideoElement, progress?: number) {
      if (progress !== undefined) targets.set(v, frameAt(progress, v.duration));
      const t = targets.get(v) ?? 0;
      if (!v.seeking && v.readyState >= 2 && Math.abs(v.currentTime - t) > 0.03)
        v.currentTime = t;
    }
    const onSeeked = (e: Event) => scrub(e.target as HTMLVideoElement);
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const stageOf = (sec: HTMLElement) => sec.firstElementChild as HTMLElement;
    const progressOf = (sec: HTMLElement, vh: number) =>
      reduced.matches
        ? 1
        : sceneProgress(
          sec.getBoundingClientRect().top,
          sec.offsetHeight,
          stageOf(sec).offsetHeight,
          vh,
        );
    const toggleOn = (el: HTMLElement, p: number) =>
      el.classList.toggle(
        'on',
        p >= Number(el.dataset.on) && !(el.dataset.off && p >= Number(el.dataset.off)),
      );
    // 화면(.screen) 안에서 요소 가운데의 위치(%). 3D 기울기와 무관한 배치 좌표를 쓴다.
    function spot(k: string) {
      let el = screen.querySelector<HTMLElement>(`[data-k="${k}"]`);
      if (!el) return { x: 50, y: 50 };
      let x = el.offsetWidth / 2;
      let y = el.offsetHeight / 2;
      while (el && el !== screen) {
        x += el.offsetLeft;
        y += el.offsetTop;
        el = el.offsetParent as HTMLElement | null;
      }
      return {
        x: (x / screen.offsetWidth) * 100,
        y: (y / screen.offsetHeight) * 100,
      };
    }
    function syncSetup(vh: number) {
      const rect = setup.getBoundingClientRect();
      setupStage.style.setProperty('--enter', String(clamp(1 - rect.top / vh)));
      const { item, t } = featureAt(
        sceneProgress(rect.top, setup.offsetHeight, setupStage.offsetHeight, vh),
        panes.length,
      );
      items.forEach((li, i) => {
        li.classList.toggle('active', i === item);
        li.style.setProperty('--t', i < item ? '1' : i === item ? String(t) : '0');
      });
      menu.forEach((m) => m.classList.toggle('on', Number(m.dataset.pane) === item));
      panes.forEach((pane, i) => {
        pane.classList.toggle('active', i === item);
        pane
          .querySelectorAll<HTMLElement>('[data-on]')
          .forEach((el) =>
            toggleOn(el, i < item || reduced.matches ? 1 : i === item ? t : -1),
          );
      });
      const keys = CURSOR[item].map((key) => ({
        t: key.t,
        press: key.press,
        ...(key.k ? spot(key.k) : { x: key.x!, y: key.y! }),
      }));
      const c = cursorAt(t, keys);
      cursor.style.left = c.x + '%';
      cursor.style.top = c.y + '%';
      cursor.classList.toggle('press', c.press);
    }
    function syncPin(sec: HTMLElement, vh: number) {
      const p = progressOf(sec, vh);
      stageOf(sec).style.setProperty('--p', String(p));
      sec.querySelectorAll<HTMLElement>('[data-on]').forEach((el) => toggleOn(el, p));
      sec.querySelectorAll<HTMLElement>('[data-roll]').forEach((el) => {
        const v = rollAt(p, parseRoll(el.dataset.roll!));
        const unit = el.dataset.unit ?? '';
        el.textContent = el.dataset.sign === undefined ? v + unit : signed(v, unit);
      });
      const v = sec.querySelector<HTMLVideoElement>('video[data-src]');
      if (v) {
        const [a, b] = (v.dataset.range ?? '0,1').split(',').map(Number);
        scrub(v, clamp((p - a) / (b - a)));
      }
    }
    function sync() {
      frame = 0;
      const vh = innerHeight;
      const heroP = sceneProgress(
        hero.getBoundingClientRect().top,
        hero.offsetHeight,
        vh,
        vh,
      );
      root.style.setProperty('--hero', String(clamp(heroP)));
      syncSetup(vh);
      for (const sec of pins) syncPin(sec, vh);
      // 시계는 규칙 섹션에서 168:00:00으로 나타나고, 모니터 속으로 들어간 뒤(체크인)부터 흐른다.
      const top = (el: HTMLElement) => el.getBoundingClientRect().top + scrollY;
      const start = top(checkin);
      const end = top(finish) + finish.offsetHeight - vh;
      const lap = (scrollY - start) / (end - start);
      const clock = raceClock(lap);
      hud.classList.toggle('show', scrollY > top(rules) - vh * 0.5);
      hud.classList.toggle('done', lap >= 1);
      hud.style.setProperty('--lap', String(clamp(lap)));
      hudDay.textContent = `DAY ${String(clock.day).padStart(2, '0')} / 07`;
      hudClock.textContent = lap >= 1 ? `완주 · ${clock.text} 남김` : clock.text;
    }
    function onScroll() {
      if (!frame) frame = requestAnimationFrame(sync);
    }
    // 모니터가 마우스를 따라 살짝 기운다(마우스가 있는 기기만).
    function onPointer(e: PointerEvent) {
      if (!finePointer.matches || reduced.matches) return;
      root.style.setProperty('--mx', String((e.clientX / innerWidth) * 2 - 1));
      root.style.setProperty('--my', String((e.clientY / innerHeight) * 2 - 1));
    }
    for (const v of videos) {
      v.addEventListener('loadeddata', sync);
      v.addEventListener('seeked', onSeeked);
    }
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll);
    addEventListener('pointermove', onPointer, { passive: true });
    sync();
    return () => {
      cancelAnimationFrame(frame);
      for (const v of videos) {
        v.removeEventListener('loadeddata', sync);
        v.removeEventListener('seeked', onSeeked);
      }
      removeEventListener('scroll', onScroll);
      removeEventListener('resize', onScroll);
      removeEventListener('pointermove', onPointer);
    };
  }, []);

  return (
    <div className="rl" ref={rootRef}>
      <header className="rl-top">
        <a className="rl-brand" href="#top">
          ProjectMate
        </a>
        <Link className="rl-btn small" href={START} prefetch={false}>
          7일 시작하기
        </Link>
      </header>

      <main>
        <section className="hero" id="top">
          <div className="hero-stage">
            {/* 배경: 아래 구간에 나올 화면 조각들을 미리 흩뿌린다. 마우스를 따라 깊이별로 움직인다. */}
            <div className="hero-cards" aria-hidden="true">
              <div className="hc hc-cmp">
                <small>브릿지랩 · 백엔드 개발자</small>
                <b>하린의 이력서와 비교</b>
                <div className="cmp-row cmp-ok">
                  <b>Java</b>
                  <small>필수</small>
                  <span className="cmp-tag">근거 있음</span>
                </div>
                <div className="cmp-row cmp-gap">
                  <b>REST API</b>
                  <small>필수</small>
                  <span className="cmp-tag">근거 없음</span>
                </div>
              </div>
              <div className="hc hc-team">
                <small>팀 매칭</small>
                <div className="hc-avs">
                  {['민', '수', '하', '준'].map((a) => (
                    <span className="mt-av" key={a}>
                      {a}
                    </span>
                  ))}
                </div>
                <b>4인 팀 매칭 완료</b>
              </div>
              <div className="hc hc-task">
                <small>프로젝트 업무 · DAY 05</small>
                <b>참가 신청 API</b>
                <span>하린 · 진행 중 · 18:00 마감</span>
              </div>
              <div className="hc hc-clock">
                <span>DAY 03 / 07</span>
                <i />
                <b>112:14:05</b>
              </div>
              <div className="hc hc-done">
                <b>완주</b>
                <small>31시간 남기고</small>
              </div>
            </div>
            <div className="hero-copy">
              <p className="kicker">취준생을 위한 7일 프로젝트 스프린트</p>
              <h1>
                <span className="line">이력서와 프로젝트 관리를</span>
                <span className="line">한 곳에.</span>
              </h1>
              <p className="lead">
                공고가 원하는 경험, 7일 팀 프로젝트로 채웁니다.
                <br />기한은 7일. 목표는 고정, 연장은 없습니다.
              </p>
              <div className="hero-actions">
                <Link className="rl-btn" href={START} prefetch={false}>
                  7일 시작하기
                </Link>
                <a className="rl-link" href="#diagnose">
                  스크롤해서 출발 ↓
                </a>
              </div>
            </div>
            <p className="hero-end" aria-hidden="true">
              출발 전에,
              <br />
              <em>무엇이 부족한지부터.</em>
            </p>
          </div>
        </section>

        <section className="pin duo" id="diagnose" data-pin>
          <div className="pin-stage duo-stage">
            <div className="duo-copy">
              <p className="kicker">진단</p>
              <h2>
                무엇이 부족한지,
                <br />
                공고가 알려줍니다.
              </h2>
              <p className="lead">
                관심 공고와 내 이력서를 나란히. 요구 역량마다 이력서 속 근거를
                찾아 보여줍니다.
              </p>
            </div>
            <div className="cmp">
              <div className="cmp-head" data-on="0.02">
                <small>브릿지랩 · 백엔드 개발자</small>
                <b>하린의 이력서와 비교</b>
              </div>
              {[
                ['Java', '필수', '자료구조 과제를 Java로 구현'],
                ['Spring', '필수', 'Spring 게시판 개인 프로젝트'],
                ['SQL', '필수', '데이터베이스 수업 팀 과제'],
                ['REST API', '필수', ''],
                ['Docker', '우대', ''],
              ].map(([skill, kind, quote], i) => (
                <div
                  className={`cmp-row ${quote ? 'cmp-ok' : 'cmp-gap'}`}
                  data-on={(0.1 + i * 0.1).toFixed(2)}
                  key={skill}
                >
                  <b>{skill}</b>
                  <small>{kind}</small>
                  <span className="cmp-tag">{quote ? '근거 있음' : '근거 없음'}</span>
                  <q>{quote || '이력서에서 근거를 찾지 못했습니다'}</q>
                </div>
              ))}
              <p className="cmp-sum" data-on="0.68">
                부족 역량 2개 · REST API, Docker <span>→ 다음 7일의 목표</span>
              </p>
            </div>
          </div>
        </section>

        <section className="pin duo" id="match" data-pin>
          <div className="pin-stage duo-stage">
            <div className="duo-copy">
              <p className="kicker">팀 매칭</p>
              <h2>
                빈자리는,
                <br />
                팀으로 채웁니다.
              </h2>
              <p className="lead">
                이력서에서 기술스택과 포지션을 읽어, 서로의 빈자리를 채우는 2–4인
                팀으로 묶습니다.
              </p>
            </div>
            <div className="mt">
              <div className="mt-me" data-on="0.02">
                <small>하린의 이력서에서 읽은 것</small>
                <div className="mt-chips">
                  {['포지션 · 백엔드', 'Java', 'Spring', 'SQL'].map((c, i) => (
                    <span data-on={(0.08 + i * 0.06).toFixed(2)} key={c}>
                      {c}
                    </span>
                  ))}
                  <span className="mt-want" data-on="0.34">
                    채울 역량 · REST API, Docker
                  </span>
                </div>
              </div>
              <div className="mt-team">
                {[
                  ['민', '민서', '기획 · PM', '서비스 기획 · Figma', 0.5],
                  ['수', '수빈', '프론트엔드', 'React · TypeScript', 0.58],
                  ['하', '하린', '백엔드', 'Java · Spring', 0.44],
                  ['준', '준호', '인프라 · QA', 'Docker · 테스트 자동화', 0.66],
                ].map(([av, name, pos, stack, on], i) => (
                  <div
                    className={`mt-card m${i}`}
                    data-on={on as number}
                    key={name as string}
                  >
                    <span className="mt-av">{av}</span>
                    <b>{name}</b>
                    <small>{pos}</small>
                    <span className="mt-stack">{stack}</span>
                  </div>
                ))}
              </div>
              <p className="mt-done" data-on="0.8">
                4인 팀 매칭 완료 · 포지션 겹침 없음
              </p>
            </div>
          </div>
        </section>

        <section className="pin cine" id="launch" data-pin>
          <div className="pin-stage">
            <video
              data-src="/landing/race.mp4"
              data-range="0,0.8"
              poster="/landing/car.jpg"
              muted
              playsInline
              preload="auto"
              aria-hidden="true"
            />
            <div className="cine-copy">
              <p className="kicker">스프린트</p>
              <p className="cine-line">
                <span data-on="0.45">팀이 모이면,</span>
                <span data-on="0.7">이제, 스프린트.</span>
              </p>
            </div>
          </div>
        </section>

        <section className="pin rules" id="rules" data-pin>
          <div className="pin-stage">
            <div className="rules-body">
              <p className="kicker">규칙</p>
              <h2>
                출발하면,
                <br />
                멈출 수 없습니다.
              </h2>
              <ol className="rule-list">
                <li data-on="0.06">
                  <strong>
                    <span data-roll="0,168,0.06,0.3">168</span>시간
                  </strong>
                  <span>
                    출발을 누른 시각부터 정확히 7일.
                    <br />
                    준비하는 동안은 시간이 흐르지 않습니다.
                  </span>
                </li>
                <li data-on="0.38">
                  <strong>목표 잠금</strong>
                  <span>
                    출발 후에는 목표·범위·결과물을
                    <br />
                    누구도, 어떤 경로로도 바꿀 수 없습니다.
                  </span>
                </li>
                <li data-on="0.66">
                  <strong>연장 없음</strong>
                  <span>
                    기한이 지나면 자동으로 종료.
                    <br />
                    다음 스프린트 이월도 없습니다.
                  </span>
                </li>
              </ol>
            </div>
          </div>
        </section>

        <section className="feat" id="setup">
          <div className="stage">
            <div className="feat-copy">
              <p className="kicker">출발 전 설계</p>
              <h2>
                스프린트 전,
                <br />
                7일을 설계합니다.
              </h2>
              <ol className="feat-list">
                <li>
                  <b>전원이 동의해야 출발</b>
                  <p>
                    목표와 결과물에 팀 전원이 동의하고 팀장이 시작을 누르는 순간,
                    168시간이 흐릅니다.
                  </p>
                  <i className="bar" />
                </li>
                <li>
                  <b>빈칸 없는 배정</b>
                  <p>업무마다 담당자와 마감. 미정으로 남은 칸은 바로 드러납니다.</p>
                  <i className="bar" />
                </li>
                <li>
                  <b>7일 마감 캘린더</b>
                  <p>승인된 마감을 일차별로. 오늘 끝내야 할 일이 먼저 보입니다.</p>
                  <i className="bar" />
                </li>
              </ol>
            </div>
            <div className="monitor">
              {/* eslint-disable-next-line @next/next/no-img-element -- 장식용 모니터 */}
              <img src="/landing/monitor.jpg" alt="" />
              <div className="screen" aria-hidden="true">
                <div className="app">
                  <aside className="app-side">
                    <strong>ProjectMate</strong>
                    <span data-pane="2">스프린트 현황</span>
                    <span data-pane="1">프로젝트 업무</span>
                    <span>내 할 일</span>
                    <span>변경안 검토</span>
                    <span data-pane="0">완주 확인</span>
                  </aside>
                  <div className="app-main">
                    <div className="pane">
                      <small className="s-eyebrow">시작 전 확인</small>
                      <h3>시작 준비</h3>
                      <div className="goal">
                        <small>목표</small>
                        <b>우리 동네 러닝 모임 찾기 MVP</b>
                        <small>필수 결과물 2개 · 작동하는 웹, 3분 데모</small>
                      </div>
                      {[
                        ['민', '민서', '팀장', 0.12],
                        ['수', '수빈', '팀원', 0.24],
                        ['하', '하린', '팀원', 0.36],
                        ['준', '준호', '팀원', 0.48],
                      ].map(([a, name, role, on]) => (
                        <div className="s-member" key={name as string}>
                          <span className="av">{a}</span>
                          <b>{name}</b>
                          <small>{role}</small>
                          <span className="s-agree swap" data-on={on as number}>
                            <span className="before">동의 대기</span>
                            <span className="after">목표 v1 동의</span>
                          </span>
                        </div>
                      ))}
                      <div className="pane-foot">
                        <small className="ready" data-on="0.5">
                          전원 동의 · 시작할 수 있습니다
                        </small>
                        <span className="s-btn swap" data-k="start" data-on="0.8">
                          <span className="before">스프린트 시작</span>
                          <span className="after">진행 중 · 168:00:00</span>
                        </span>
                      </div>
                    </div>
                    <div className="pane">
                      <small className="s-eyebrow">러닝크루 MVP</small>
                      <h3>프로젝트 업무</h3>
                      <div className="s-row head">
                        <span>업무</span>
                        <span>담당자</span>
                        <span>상태</span>
                        <span>승인된 마감</span>
                      </div>
                      <div className="s-row">
                        <span>로그인 구현</span>
                        <span>민서</span>
                        <span>진행 중</span>
                        <span>Day 3 · 18:00</span>
                      </div>
                      <div className="s-row">
                        <span>모임 검색 화면</span>
                        <span>수빈</span>
                        <span>진행 중</span>
                        <span>Day 4 · 18:00</span>
                      </div>
                      <div className="s-row s-target" data-on="0.58">
                        <span>참가 신청 API</span>
                        <span className="select" data-k="assign">
                          <span className="swap" data-on="0.58">
                            <span className="before">미정 ▾</span>
                            <span className="after">하린 ▾</span>
                          </span>
                          <span className="menu" data-on="0.31" data-off="0.58">
                            <span>민서</span>
                            <span>수빈</span>
                            <span className="opt" data-k="harin" data-on="0.45">
                              하린
                            </span>
                            <span>준호</span>
                          </span>
                        </span>
                        <span>시작 전</span>
                        <span>Day 5 · 18:00</span>
                      </div>
                      <p className="toast" data-on="0.62">
                        하린에게 배정했습니다. 캘린더에도 반영됐습니다.
                      </p>
                    </div>
                    <div className="pane">
                      <small className="s-eyebrow">러닝크루 MVP · 최종 마감 D-4</small>
                      <h3>우리 팀의 7일</h3>
                      <div className="cal">
                        {[
                          ['목표 합의', '전원 ✓'],
                          ['화면 설계', '수빈 ✓'],
                          ['로그인', '민서 18:00'],
                          ['모임 검색', '수빈 18:00'],
                          ['참가 신청', '하린 18:00'],
                          ['통합 테스트', '준호 16:00'],
                          ['결과물 확인', '최종 마감'],
                        ].map(([task, who], i) => (
                          <div
                            className={`s-day ${i === 2 ? 's-today' : ''}`}
                            data-k={i === 4 ? 'day5' : undefined}
                            data-on={(0.06 + i * 0.05).toFixed(2)}
                            key={task}
                          >
                            <small>DAY {String(i + 1).padStart(2, '0')}</small>
                            <b>{task}</b>
                            <span>{who}</span>
                          </div>
                        ))}
                      </div>
                      <p className="tip" data-on="0.5">
                        DAY 05 · 참가 신청 API · 하린 · 승인된 마감 18:00
                      </p>
                    </div>
                  </div>
                </div>
                <svg className="cursor" viewBox="0 0 24 24">
                  <path d="M4 2l16 9-7 2-3 7z" />
                </svg>
              </div>
            </div>
          </div>
        </section>

        <section className="pin dive" id="dive" data-pin aria-hidden="true">
          <div className="pin-stage">
            <video
              data-src="/landing/dive.mp4"
              poster="/landing/dive.jpg"
              muted
              playsInline
              preload="auto"
            />
          </div>
        </section>

        <section className="pin cine" id="checkin" data-pin>
          <div className="pin-stage">
            <video
              data-src="/landing/checkin.mp4"
              data-range="0,0.8"
              poster="/landing/checkin.jpg"
              muted
              playsInline
              preload="auto"
              aria-hidden="true"
            />
            <div className="cine-copy center">
              <p className="kicker">체크인</p>
              <p className="cine-line big">
                <span data-on="0.15">일정이 밀리는 순간,</span>
                <span data-on="0.4">바로 경고</span>
              </p>
              <p className="lead" data-on="0.6">
                체크인 한 번이면 남은 공수로 일정이 다시 계산됩니다.
              </p>
            </div>
          </div>
        </section>

        <section className="pin tele" id="telemetry" data-pin>
          <div className="pin-stage tele-stage">
            <div className="tele-copy">
              <p className="kicker">일정 재계산</p>
              <h2>
                &ldquo;거의 다 했어요&rdquo;는
                <br />
                기록이 아닙니다.
              </h2>
              <p className="lead">
                남은 시간을 남기면 일정이 즉시 다시 계산됩니다. 목표를 줄여서
                맞추는 일은 없습니다.
              </p>
            </div>
            <div className="tele-field">
              <div className="tcard t1 hot" data-on="0.04">
                <small>민서 · 로그인 구현</small>
                <b>남은 공수 6h</b>
                <span>마감까지 쓸 수 있는 시간 4h</span>
              </div>
              <div className="tcard t2" data-on="0.1">
                <small>수빈 · 모임 검색 화면</small>
                <b>남은 공수 3h</b>
                <span>마감 안</span>
              </div>
              <div className="tcard t3" data-on="0.16">
                <small>하린 · 참가 신청 API</small>
                <b>남은 공수 4h</b>
                <span>마감 안</span>
              </div>
              <div className="tcard t4" data-on="0.22">
                <small>준호 · 통합 테스트</small>
                <b className="swap" data-on="0.62">
                  <span className="before">남은 공수 2h</span>
                  <span className="after">+ 오류 화면 3h</span>
                </b>
                <span>여유 5h</span>
              </div>
              <div className="tele-big" data-on="0.35">
                <small>로그인 구현 · 마감 대비</small>
                <strong data-roll="0,2,0.35,0.5|2,-1,0.66,0.8" data-unit="h" data-sign>
                  0h
                </strong>
                <span className="verdict swap" data-on="0.8">
                  <span className="before">마감보다 2시간 초과 · 배치 불가</span>
                  <span className="after">재배정 후 마감 1시간 전 도착</span>
                </span>
              </div>
              <p className="tele-chip" data-on="0.62">
                담당 재배정 · 오류 화면 → 준호
              </p>
            </div>
          </div>
        </section>

        <section className="pin radio" id="radio" data-pin>
          <div className="pin-stage radio-stage">
            <div className="cine-copy">
              <p className="kicker">
                회의 정리 <span className="pilot">파일럿</span>
              </p>
              <p className="cine-line">
                <span data-on="0.02">회의는 끝났습니다.</span>
                <span data-on="0.1">할 일만 남깁니다.</span>
              </p>
            </div>
            <div className="radio-field">
              <p className="bubble b1" data-on="0.18">
                <b>준호</b>참가 신청 API 누가 맡아요?
              </p>
              <p className="bubble b2 key" data-on="0.22">
                <b>하린</b>제가 맡을게요. 4시간이면 돼요.
              </p>
              <p className="bubble b3" data-on="0.26">
                <b>민서</b>API 나오면 화면에 붙일게요.
              </p>
              <p className="bubble b4" data-on="0.3">
                <b>수빈</b>검색 필터는 내일 오전까지요.
              </p>
              <p className="bubble b5" data-on="0.34">
                <b>준호</b>그럼 통합 테스트는 목요일!
              </p>
              <div className="proposal2" data-on="0.72">
                <small>변경안 · 원문 근거 있음</small>
                <b>참가 신청 API</b>
                <div>
                  <span>담당자</span>미정 → 하린
                </div>
                <div>
                  <span>남은 공수</span>미정 → 4시간
                </div>
                <q>제가 맡을게요. 4시간이면 돼요.</q>
                <p className="stamp swap" data-on="0.86">
                  <span className="before">승인 대기</span>
                  <span className="after">팀장 승인 · 반영됨</span>
                </p>
              </div>
              <p className="radio-note" data-on="0.72">
                단톡방 대화를 붙여넣으면 바뀔 업무만 골라 제안합니다. 적용은 사람이
                승인해야만 됩니다.
              </p>
            </div>
          </div>
        </section>

        <section className="scene" id="finish" data-pin>
          <div className="stage">
            <div className="copy">
              <p className="kicker">완주</p>
              <h2>
                끝냈다는 말은,
                <br />
                결과물로.
              </h2>
              <p className="lead">
                처음 약속한 결과물마다 근거를 남기고, 팀장이 확인하면 완주.
              </p>
            </div>
            <div className="panel finish">
              <video
                data-src="/landing/finish.mp4"
                poster="/landing/car.jpg"
                muted
                playsInline
                preload="auto"
                aria-hidden="true"
              />
              <div className="flag" data-on="0.75" />
              <ul>
                <li data-on="0.25">모임 검색 · 참가 신청 작동</li>
                <li data-on="0.5">저장소 · 실행 방법 · 3분 데모</li>
              </ul>
              <p className="result" data-on="0.75">
                완주 <small>31시간 남기고</small>
              </p>
            </div>
          </div>
        </section>

        <section className="pin duo" id="proof" data-pin>
          <div className="pin-stage duo-stage">
            <div className="duo-copy">
              <p className="kicker">증명</p>
              <h2>
                완주한 결과물이,
                <br />
                이력서의 다음 줄.
              </h2>
              <p className="lead">
                팀장이 확인한 결과물과 근거가 그대로 이력서 항목이 됩니다. 같은
                공고와 다시 비교하면 빈칸이 줄어듭니다.
              </p>
            </div>
            <div className="pf">
              <div className="pf-out" data-on="0.04">
                <small>완주 · 러닝크루 MVP</small>
                <b>참가 신청 API · 하린</b>
                <span>저장소 · 실행 방법 · 3분 데모</span>
              </div>
              <div className="pf-cv">
                <small>하린의 이력서</small>
                <p>Spring 게시판 개인 프로젝트</p>
                <p>데이터베이스 수업 팀 과제</p>
                <p className="pf-new" data-on="0.36">
                  참가 신청 REST API 설계·구현 · 4인 팀 7일 스프린트 완주
                </p>
              </div>
              <div className="cmp-row cmp-gap pf-row" data-on="0.58">
                <b>REST API</b>
                <small>브릿지랩 · 백엔드 개발자 · 다시 비교</small>
                <span className="cmp-tag swap" data-on="0.76">
                  <span className="before">근거 없음</span>
                  <span className="after">근거 있음</span>
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className="pin mosaic" id="closing" data-pin>
          <div className="pin-stage">
            <div className="mosaic-grid">
              {[
                ['a', 'm1', 0.08],
                ['b', 'm4', 0.14],
                ['c', 'm3', 0.2],
                ['d', 'm2', 0.12],
                ['e', 'm5', 0.18],
                ['f', 'm6', 0.1],
                ['g', 'm7', 0.16],
                ['i', 'm8', 0.22],
              ].map(([area, img, on]) => (
                <figure className={`tile ${area}`} data-on={on} key={area as string}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- 장식용 모자이크 */}
                  <img src={`/landing/${img}.jpg`} alt="" loading="lazy" />
                </figure>
              ))}
              <div className="tile h text" data-on="0.24">
                <small>출발부터 결승까지</small>
                <strong>168:00:00</strong>
                <i className="days" aria-hidden="true" />
              </div>
              <div className="tile j text" data-on="0.26">
                <small>목표 잠금 · 이월 없음</small>
                <strong>연장 0회</strong>
              </div>
              <div className="tile cta">
                <h2>
                  다음 7일,
                  <br />
                  <em>출발선에 서세요.</em>
                </h2>
                <div className="hero-actions">
                  <Link className="rl-btn" href={START} prefetch={false}>
                    7일 시작하기
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <div className="hud" aria-hidden="true">
        <span className="hud-day">DAY 01 / 07</span>
        <span className="hud-bar" />
        <span className="hud-clock">168:00:00</span>
      </div>

      <footer className="rl-foot">
        <span>ProjectMate · 2–4인 팀의 7일 스프린트</span>
        <span>
          화면 속 팀·업무·시간은 예시입니다. AI 변경안은 파일럿 단계입니다.
        </span>
      </footer>
    </div>
  );
}
