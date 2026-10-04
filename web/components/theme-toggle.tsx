'use client';
import { Moon, Sun } from 'lucide-react';
import { useSyncExternalStore } from 'react';

// <html>의 .dark 클래스가 기준이다(layout.tsx 스크립트가 그리기 전에 붙인다). 서버 렌더는 기본값 다크.
function subscribe(onChange: () => void) {
  const o = new MutationObserver(onChange);
  o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => o.disconnect();
}
const isDark = () => document.documentElement.classList.contains('dark');

// 다크가 기본. 값은 이 브라우저에만 기억한다(서버에 저장하지 않음). 저장소가 막혀도 전환은 된다.
export function ThemeToggle() {
  const dark = useSyncExternalStore(subscribe, isDark, () => true);
  function toggle() {
    document.documentElement.classList.toggle('dark', !dark);
    try {
      localStorage.setItem('pm-theme', dark ? 'light' : 'dark');
    } catch {
      /* 시크릿 창 등: 이번 화면에만 적용 */
    }
  }
  return (
    <button
      type="button"
      className="icon-btn theme-toggle"
      onClick={toggle}
      aria-label={dark ? '라이트 모드로 바꾸기' : '다크 모드로 바꾸기'}
      title={dark ? '라이트 모드' : '다크 모드'}
    >
      {dark ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}
