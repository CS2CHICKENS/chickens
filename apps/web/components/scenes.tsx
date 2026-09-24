"use client";
import { LinkArrow } from "./link-arrow";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMotionPreference } from "./motion-preference";
import { assetBase } from "./data";

export function Scene({
  kind,
  children,
  foreground = true,
}: {
  kind: "nest" | "kitchen";
  children?: ReactNode;
  foreground?: boolean;
}) {
  const src = assetBase + "/" + kind + "-1024.webp";
  return (
    <div className={"scene scene-" + kind} aria-hidden="true">
      <img
        className="scene-backdrop"
        src={src}
        alt=""
        width="1672"
        height="941"
      />
      {children}
      {foreground && (
        <img
          className="scene-foreground"
          src={src}
          alt=""
          width="1672"
          height="941"
        />
      )}
    </div>
  );
}
export function SceneEgg() {
  return (
    <img
      className="scene-source-egg"
      src={assetBase + "/egg-512.webp"}
      alt=""
      width="512"
      height="512"
    />
  );
}
export function NestPreview() {
  return (
    <Scene kind="nest">
      <div className="scene-nest-egg">
        <SceneEgg />
      </div>
    </Scene>
  );
}
export function KitchenScene({ animate = false }: { animate?: boolean }) {
  const reduced = useMotionPreference(),
    root = useRef<HTMLDivElement>(null);
  const [run, setRun] = useState(0),
    [phase, setPhase] = useState("ready");
  useEffect(() => {
    if (!animate || reduced || !root.current) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setRun(1);
          observer.disconnect();
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(root.current);
    return () => observer.disconnect();
  }, [animate, reduced]);
  useEffect(() => {
    if (!run || reduced) {
      setPhase("ready");
      return;
    }
    setPhase("drop");
    const cooking = setTimeout(() => setPhase("cooking"), 1200);
    const cooked = setTimeout(() => setPhase("cooked"), 5200);
    return () => {
      clearTimeout(cooking);
      clearTimeout(cooked);
    };
  }, [run, reduced]);
  return (
    <div
      ref={root}
      className={"kitchen-cinematic " + (animate ? "interactive" : "")}
      data-phase={phase}
    >
      <Scene kind="kitchen">
        <div
          key={run}
          className={"pan-egg " + (run && !reduced ? "is-cooking" : "")}
        >
          {["left-shell", "right-shell", "yolk"].map((part) => (
            <div className={"cook-part " + part} key={part}>
              <img
                src={assetBase + "/cook-egg-512.webp"}
                alt=""
                width="512"
                height="512"
              />
            </div>
          ))}
        </div>
        <img
          className="pan-heat"
          src={assetBase + "/egg-glow.webp"}
          alt=""
          width="256"
          height="256"
        />
        <img
          className="pan-steam"
          src={assetBase + "/kitchen-1024.webp"}
          alt=""
          width="1672"
          height="941"
        />
      </Scene>
      {animate && (
        <div className="cook-controls">
          <span className="eyebrow">
            {reduced
              ? "ON THE HEAT"
              : phase === "drop"
                ? "INTO THE PAN"
                : phase === "cooking"
                  ? "FEEL THE HEAT"
                  : phase === "cooked"
                    ? "COOKED. GONE FOR GOOD."
                    : "THE PAN IS READY"}
          </span>
          {!reduced && (
            <button className="button" onClick={() => setRun((v) => v + 1)}>
              {run ? (
                "REPLAY COOK ↺"
              ) : (
                <>
                  PLAY COOK <LinkArrow />
                </>
              )}
            </button>
          )}
          <small>VISUAL PREVIEW</small>
        </div>
      )}
    </div>
  );
}
