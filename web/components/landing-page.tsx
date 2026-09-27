'use client';
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  sceneProgress,
  stepAt,
  frameAt,
  raceClock,
} from '@/lib/landing-race.mjs';
import './landing.css';

const START = '/workspace?create=1';

export function LandingPage() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current!;
    const hero = root.querySelector<HTMLElement>('.hero')!;
    const video = root.querySelector<HTMLVideoElement>('.hero video')!;
    const finishVideo = root.querySelector<HTMLVideoElement>('.finish video')!;
    const scenes = [...root.querySelectorAll<HTMLElement>('[data-steps]')];
    const rules = root.querySelector<HTMLElement>('#rules')!;
    const lights = root.querySelector<HTMLElement>('#lights')!;
    const finish = root.querySelector<HTMLElement>('#finish')!;
    const hud = root.querySelector<HTMLElement>('.hud')!;
    const hudDay = hud.querySelector<HTMLElement>('.hud-day')!;
    const hudClock = hud.querySelector<HTMLElement>('.hud-clock')!;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const phone = matchMedia('(max-width: 767px)');
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
    function sync() {
      frame = 0;
      const vh = innerHeight;
      const heroP = sceneProgress(
        hero.getBoundingClientRect().top,
        hero.offsetHeight,
        vh,
        vh,
      );
      root.style.setProperty('--hero', String(heroP));
      scrub(video, heroP);
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
      // 시계는 규칙 섹션에서 168:00:00으로 나타나고, 신호등이 꺼진 뒤부터 흐른다.
      const top = (el: HTMLElement) => el.getBoundingClientRect().top + scrollY;
      // 출발(5단계 중 마지막)은 고정 구간의 5/6 지점에서 켜진다.
      const start = top(lights) + (lights.offsetHeight - vh) * (5 / 6);
      const end = top(finish) + finish.offsetHeight - vh;
      const lap = (scrollY - start) / (end - start);
      const clock = raceClock(lap);
      hud.classList.toggle('show', scrollY > top(rules) - vh * 0.5);
      hud.classList.toggle('done', lap >= 1);
      hud.style.setProperty('--lap', String(Math.max(0, Math.min(1, lap))));
      hudDay.textContent = `DAY ${String(clock.day).padStart(2, '0')} / 07`;
      hudClock.textContent = lap >= 1 ? `완주 · ${clock.text} 남김` : clock.text;
    }
    function onScroll() {
      if (!frame) frame = requestAnimationFrame(sync);
    }
    for (const v of [video, finishVideo]) {
      v.addEventListener('loadeddata', sync);
      v.addEventListener('seeked', onSeeked);
    }
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      for (const v of [video, finishVideo]) {
        v.removeEventListener('loadeddata', sync);
        v.removeEventListener('seeked', onSeeked);
      }
      removeEventListener('scroll', onScroll);
      removeEventListener('resize', onScroll);
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
                이번엔,
                <br />
                끝까지 간다.
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
              <strong>168시간</strong>
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

        <section className="scene" id="lights" data-steps="5">
          <div className="stage">
            <div className="copy">
              <p className="kicker">LIGHTS OUT</p>
              <h2>
                전원이 동의해야,
                <br />
                불이 꺼진다.
              </h2>
              <p className="lead">
                목표와 결과물에 팀 전원이 동의하고 팀장이 출발을 누르는 순간,
                168시간이 흐르기 시작한다.
              </p>
            </div>
            <div className="panel lights">
              <div className="pods">
                {['민서', '수빈', '하린', '준호'].map((name, i) => (
                  <div className="pod" data-at={i + 1} key={name}>
                    <i />
                    <i />
                    <span>
                      {name}
                      <b>동의</b>
                    </span>
                  </div>
                ))}
              </div>
              <p className="go" data-at="5">
                출발 <small>168:00:00부터 카운트다운</small>
              </p>
            </div>
          </div>
        </section>

        <section className="scene" id="laps" data-steps="4">
          <div className="stage">
            <div className="copy">
              <p className="kicker">LAP CHART</p>
              <h2>
                7일을 쪼갠다.
                <br />
                빈칸은 없다.
              </h2>
              <p className="lead">
                업무마다 담당자와 마감. 누가 어디서 멈췄는지 팀 전원에게
                보인다.
              </p>
            </div>
            <div className="panel laps">
              {[
                ['목표 합의', '전원', 1],
                ['화면 설계', '수빈 · 18:00', 1],
                ['로그인', '민서 · 18:00', 2],
                ['모임 검색', '수빈 · 18:00', 2],
                ['참가 신청', null, 3],
                ['통합 테스트', '준호 · 16:00', 3],
                ['결과물 확인', '최종 마감', 3],
              ].map(([task, who, at], i) => (
                <div
                  className={`lap ${i === 2 ? 'today' : ''}`}
                  data-at={at as number}
                  key={task as string}
                >
                  <small>DAY {String(i + 1).padStart(2, '0')}</small>
                  <b>{task}</b>
                  {who ? (
                    <span>{who}</span>
                  ) : (
                    <span className="swap" data-at="4">
                      <span className="before">담당자 미정</span>
                      <span className="after">하린 · 18:00</span>
                    </span>
                  )}
                </div>
              ))}
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
