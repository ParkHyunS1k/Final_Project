'use client';
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  sceneProgress,
  stepAt,
  frameAt,
  raceClock,
  featureAt,
  cursorAt,
  countUp,
} from '@/lib/landing-race.mjs';
import './landing.css';

const START = '/workspace?create=1';
// 첫 화면 영상은 스크롤의 앞 78% 동안 재생되고, 나머지 구간에서 둥근 카드로 줄어든다.
const HERO_VIDEO_SHARE = 0.78;
// 설계 섹션 첫 항목(출발)에서 커서가 "스프린트 시작"을 누르는 지점. 레이스 시계가 여기서 흐른다.
const START_CLICK = 0.78;

type Key = { t: number; k?: string; x?: number; y?: number; press?: boolean };
// 모니터 속 화면별 커서 경로. k는 data-k 요소의 가운데, 없으면 x·y(화면 기준 %).
const CURSOR: Key[][] = [
  [
    { t: 0, x: 62, y: 96 },
    { t: 0.62, k: 'start' },
    { t: START_CLICK, k: 'start', press: true },
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

export function LandingPage() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current!;
    const hero = root.querySelector<HTMLElement>('.hero')!;
    const video = root.querySelector<HTMLVideoElement>('.hero video')!;
    const finishVideo = root.querySelector<HTMLVideoElement>('.finish video')!;
    const scenes = [...root.querySelectorAll<HTMLElement>('[data-steps]')];
    const rules = root.querySelector<HTMLElement>('#rules')!;
    const setup = root.querySelector<HTMLElement>('#setup')!;
    const setupStage = setup.querySelector<HTMLElement>('.stage')!;
    const screen = setup.querySelector<HTMLElement>('.screen')!;
    const cursor = screen.querySelector<SVGElement>('.cursor')!;
    const items = [...setup.querySelectorAll<HTMLElement>('.feat-list li')];
    const panes = [...setup.querySelectorAll<HTMLElement>('.pane')];
    const menu = [...setup.querySelectorAll<HTMLElement>('.app-side [data-pane]')];
    const counters = [...root.querySelectorAll<HTMLElement>('[data-count]')];
    const finish = root.querySelector<HTMLElement>('#finish')!;
    const hud = root.querySelector<HTMLElement>('.hud')!;
    const hudDay = hud.querySelector<HTMLElement>('.hud-day')!;
    const hudClock = hud.querySelector<HTMLElement>('.hud-clock')!;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const phone = matchMedia('(max-width: 767px)');
    const finePointer = matchMedia('(pointer: fine)');
    if (!reduced.matches && !phone.matches) {
      video.src = '/landing/race.mp4';
      finishVideo.src = '/landing/finish.mp4';
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
        pane.querySelectorAll<HTMLElement>('[data-on]').forEach((el) => {
          const on =
            i < item ||
            (i === item &&
              (reduced.matches || t >= Number(el.dataset.on)) &&
              !(el.dataset.off && t >= Number(el.dataset.off)));
          el.classList.toggle('on', on);
        });
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
    function sync() {
      frame = 0;
      const vh = innerHeight;
      const heroP = sceneProgress(
        hero.getBoundingClientRect().top,
        hero.offsetHeight,
        vh,
        vh,
      );
      const videoP = Math.min(1, heroP / HERO_VIDEO_SHARE);
      root.style.setProperty('--hero', String(videoP));
      root.style.setProperty(
        '--shrink',
        String(clamp((heroP - HERO_VIDEO_SHARE) / (1 - HERO_VIDEO_SHARE))),
      );
      scrub(video, videoP);
      syncSetup(vh);
      for (const scene of scenes) {
        const stage = scene.firstElementChild as HTMLElement;
        const max = Number(scene.dataset.steps);
        const progress = sceneProgress(
          scene.getBoundingClientRect().top,
          scene.offsetHeight,
          stage.offsetHeight,
          vh,
        );
        const step = reduced.matches ? max : stepAt(progress, max);
        if (scene.id === 'finish') scrub(finishVideo, progress);
        scene
          .querySelectorAll<HTMLElement>('[data-at]')
          .forEach((el) =>
            el.classList.toggle('on', Number(el.dataset.at) <= step),
          );
      }
      for (const el of counters) {
        const p = reduced.matches
          ? 1
          : clamp((vh * 0.9 - el.getBoundingClientRect().top) / (vh * 0.45));
        el.textContent = String(countUp(Number(el.dataset.count), p));
      }
      // 시계는 규칙 섹션에서 168:00:00으로 나타나고, 출발을 누른 뒤부터 흐른다.
      const top = (el: HTMLElement) => el.getBoundingClientRect().top + scrollY;
      const start =
        top(setup) +
        (setup.offsetHeight - setupStage.offsetHeight) * (START_CLICK / panes.length);
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
    for (const v of [video, finishVideo]) {
      v.addEventListener('loadeddata', sync);
      v.addEventListener('seeked', onSeeked);
    }
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll);
    addEventListener('pointermove', onPointer, { passive: true });
    sync();
    return () => {
      cancelAnimationFrame(frame);
      for (const v of [video, finishVideo]) {
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
            <video
              muted
              playsInline
              preload="auto"
              poster="/landing/poster.jpg"
              aria-hidden="true"
            />
            {/* eslint-disable-next-line @next/next/no-img-element -- 모바일 정지 화면, 최적화 경로 불필요 */}
            <img className="hero-still" src="/landing/car.jpg" alt="" />
            <div className="hero-copy">
              <p className="kicker">7일 프로젝트 스프린트</p>
              <h1>
                <span className="line">이번엔,</span>
                <span className="line">끝까지 간다.</span>
              </h1>
              <p className="lead">
                기한은 7일. 목표는 잠그고, 연장은 없다.
                <br />팀 전체를 한 번에 결승선까지.
              </p>
              <div className="hero-actions">
                <Link className="rl-btn" href={START} prefetch={false}>
                  7일 시작하기
                </Link>
                <a className="rl-link" href="#rules">
                  스크롤해서 출발 ↓
                </a>
              </div>
            </div>
            <p className="hero-end" aria-hidden="true">
              계획은 끝났다.
              <br />
              <em>이제, 달린다.</em>
            </p>
          </div>
        </section>

        <section className="rules" id="rules">
          <p className="kicker">REGULATION</p>
          <h2>
            출발하면,
            <br />
            멈출 수 없다.
          </h2>
          <ol className="rule-list">
            <li>
              <strong>
                <span data-count="168">168</span>시간
              </strong>
              <span>
                출발을 누른 시각부터 정확히 7일.
                <br />
                준비하는 동안은 시간이 흐르지 않는다.
              </span>
            </li>
            <li>
              <strong>목표 잠금</strong>
              <span>
                출발 후에는 목표·범위·결과물을
                <br />
                누구도, 어떤 경로로도 바꿀 수 없다.
              </span>
            </li>
            <li>
              <strong>연장 없음</strong>
              <span>
                기한이 지나면 자동으로 종료.
                <br />
                다음 스프린트 이월도 없다.
              </span>
            </li>
          </ol>
        </section>

        <section className="feat" id="setup">
          <div className="stage">
            <div className="feat-copy">
              <p className="kicker">PRE-RACE</p>
              <h2>
                출발 전에,
                <br />
                7일을 설계한다.
              </h2>
              <ol className="feat-list">
                <li>
                  <b>전원이 동의해야 출발</b>
                  <p>
                    목표와 결과물에 팀 전원이 동의하고 팀장이 시작을 누르는 순간,
                    168시간이 흐른다.
                  </p>
                  <i className="bar" />
                </li>
                <li>
                  <b>빈칸 없는 배정</b>
                  <p>업무마다 담당자와 마감. 미정으로 남은 칸은 바로 드러난다.</p>
                  <i className="bar" />
                </li>
                <li>
                  <b>7일 마감 캘린더</b>
                  <p>승인된 마감을 일차별로. 오늘 끝내야 할 일이 먼저 보인다.</p>
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

        <section className="scene" id="telemetry" data-steps="4">
          <div className="stage">
            <div className="copy">
              <p className="kicker">TELEMETRY</p>
              <h2>
                밀리는 순간,
                <br />
                바로 뜬다.
              </h2>
              <p className="lead">
                &ldquo;거의 다 했어요&rdquo; 대신 남은 시간을 남긴다. 일정은 즉시
                다시 계산되고, 목표를 줄여서 맞추는 일은 없다.
              </p>
            </div>
            <div className="panel tele">
              <div className="tele-head">
                <span>로그인 구현 · 민서</span>
                <span>DAY 03</span>
              </div>
              <div className="tele-metrics">
                <div>
                  <small>남은 공수</small>
                  <strong className="swap" data-at="4">
                    <span className="before">6h</span>
                    <span className="after">3h</span>
                  </strong>
                </div>
                <div>
                  <small>마감까지 쓸 수 있는 시간</small>
                  <strong>4h</strong>
                </div>
              </div>
              <div className="tele-bar" data-at="1">
                <span className="swap" data-at="4">
                  <i className="before" />
                  <i className="after" />
                </span>
              </div>
              <ul className="tele-log">
                <li data-at="1">체크인 · 남은 공수 6시간</li>
                <li className="bad" data-at="2">
                  마감보다 2시간 초과 · 배치 불가
                </li>
                <li data-at="3">담당 재배정 · 오류 화면 → 준호</li>
                <li className="good" data-at="4">
                  재계산 완료 · 마감 1시간 전 도착
                </li>
              </ul>
            </div>
          </div>
        </section>

        <section className="scene" id="radio" data-steps="3">
          <div className="stage">
            <div className="copy">
              <p className="kicker">
                TEAM RADIO <span className="pilot">파일럿</span>
              </p>
              <h2>
                회의는 끝났다.
                <br />할 일만 남긴다.
              </h2>
              <p className="lead">
                단톡방 대화를 붙여넣으면 바뀔 업무를 골라 제안한다. 적용은
                사람이 승인해야만 된다.
              </p>
            </div>
            <div className="panel radio">
              <div className="chat">
                <p data-at="1">
                  <b>준호</b>참가 신청 API 누가 맡아요?
                </p>
                <p data-at="1">
                  <b>하린</b>
                  <mark>제가 맡을게요. 4시간이면 돼요.</mark>
                </p>
              </div>
              <div className="proposal" data-at="2">
                <small>변경안 · 원문 근거 있음</small>
                <b>참가 신청 API</b>
                <div>
                  <span>담당자</span>미정 → 하린
                </div>
                <div>
                  <span>남은 공수</span>미정 → 4시간
                </div>
                <p className="stamp swap" data-at="3">
                  <span className="before">승인 대기</span>
                  <span className="after">팀장 승인 · 반영됨</span>
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="scene" id="finish" data-steps="3">
          <div className="stage">
            <div className="copy">
              <p className="kicker">CHEQUERED FLAG</p>
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
                muted
                playsInline
                preload="auto"
                poster="/landing/car.jpg"
                aria-hidden="true"
              />
              <div className="flag" data-at="3" />
              <ul>
                <li data-at="1">모임 검색 · 참가 신청 작동</li>
                <li data-at="2">저장소 · 실행 방법 · 3분 데모</li>
              </ul>
              <p className="result" data-at="3">
                완주 <small>31시간 남기고</small>
              </p>
            </div>
          </div>
        </section>


        <section className="closing">
          <h2>
            다음 7일,
            <br />
            출발선에 서라.
          </h2>
          <div className="hero-actions">
            <Link className="rl-btn" href={START} prefetch={false}>
              7일 시작하기
            </Link>
            <Link className="rl-link" href="/workspace" prefetch={false}>
              내 프로젝트
            </Link>
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
