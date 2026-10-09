import { useEffect, useRef, useState, type RefObject } from "react";
import type { Heading } from "./Preview";
import { currentHash, setHash } from "../lib/route";

// Table of contents for the reading view. The active entry is the last heading scrolled past
// the top fifth of the scroll container; the URL hash follows it, so the address bar always
// points at the section being read.
export function Toc({ headings, scrollRoot }: { headings: Heading[]; scrollRoot: RefObject<HTMLElement | null> }) {
  const [active, setActive] = useState<string | null>(null);
  // Set while a TOC click scrolls: the clicked entry stays active even if it is too close to
  // the end of the page to reach the top.
  const pinned = useRef<string | null>(null);
  // The address this TOC last wrote. Its own hash only says where the reader already is: when the
  // headings change (math loaded, back from the editor) that is no section to jump to.
  const wrote = useRef<string | null>(null);

  useEffect(() => {
    const root = scrollRoot.current;
    if (!root || headings.length === 0) return;
    let frame = 0;
    let last: string | null | undefined;
    const show = (id: string | null) => {
      if (id === last) return;
      last = id;
      setActive(id);
      setHash(id);
      wrote.current = location.href;
    };
    const update = () => {
      frame = 0;
      if (pinned.current) return show(pinned.current);
      const line = root.getBoundingClientRect().top + root.clientHeight / 5;
      let current: string | null = null;
      for (const h of headings) {
        const el = document.getElementById(h.id);
        if (el && el.getBoundingClientRect().top <= line) current = h.id;
      }
      show(current);
    };
    const onScroll = () => { frame ||= requestAnimationFrame(update); };
    const unpin = () => { pinned.current = null; };

    // Opened through a link to a section: start there.
    const target = currentHash();
    if (target && location.href !== wrote.current) document.getElementById(target)?.scrollIntoView({ block: "start" });
    update();

    root.addEventListener("scroll", onScroll, { passive: true });
    root.addEventListener("scrollend", unpin);
    for (const ev of ["wheel", "touchstart", "keydown"]) root.addEventListener(ev, unpin, { passive: true });
    return () => {
      root.removeEventListener("scroll", onScroll);
      root.removeEventListener("scrollend", unpin);
      for (const ev of ["wheel", "touchstart", "keydown"]) root.removeEventListener(ev, unpin);
      cancelAnimationFrame(frame);
    };
  }, [headings, scrollRoot]);

  const jump = (id: string) => {
    pinned.current = id;
    setActive(id);
    setHash(id);
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const top = Math.min(...headings.map(h => h.level));
  return (
    <nav aria-label="目录" className="text-[13px] leading-snug">
      <div className="mb-3 pl-3 text-xs font-medium text-fg-subtle">本页目录</div>
      <ul className="border-l border-line">
        {headings.map(h => (
          <li key={h.id}>
            <a
              href={`#${encodeURIComponent(h.id)}`}
              onClick={(e) => { e.preventDefault(); jump(h.id); }}
              style={{ paddingLeft: `${(h.level - top) * 12 + 12}px` }}
              className={
                "-ml-px block border-l-2 py-1.5 pr-2 truncate transition-colors " +
                (active === h.id
                  ? "border-accent text-fg font-medium"
                  : "border-transparent text-fg-muted hover:text-fg")
              }
              title={h.text}
            >{h.text}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
