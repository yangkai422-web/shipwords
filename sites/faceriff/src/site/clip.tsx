import { useEffect, useRef, useState } from 'react';
import { m } from '~/paraglide/messages.js';

// Poster first: click-to-play clips request the mp4 only after a click (no autoplay, no preload on first paint).
// Hero autoplay clips still paint the WebP poster first (LCP fallback), then attach the mp4 after the first
// frame and play it muted on a loop. Only the clips the parent opts in are loaded, so the other large
// samples are not preloaded. Only one clip plays sound at a time.
let muteCurrent: (() => void) | null = null;

function posterSrc(clip: string) {
  return `/media/${clip}.webp`;
}

export function ClickToPlayClip({
  clip,
  tag,
  label,
  sound = false,
  autoPlayMuted = false,
  priority = false,
  onPlaying,
}: {
  clip: string;
  tag?: string;
  label: string;
  sound?: boolean;
  /** After first paint, load this mp4 and play it muted in a loop. Poster stays until playback starts. */
  autoPlayMuted?: boolean;
  /** Mark the poster as a likely LCP image (default finished hero clip only). */
  priority?: boolean;
  onPlaying?: () => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [mounted, setMounted] = useState(false);
  const [started, setStarted] = useState(false);
  const [muted, setMuted] = useState(true);
  const onPlayingRef = useRef(onPlaying);
  onPlayingRef.current = onPlaying;

  useEffect(() => {
    setMounted(false);
    setStarted(false);
    setMuted(true);
  }, [clip]);

  useEffect(() => {
    if (!autoPlayMuted) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = requestAnimationFrame(() => {
      setMuted(true);
      setMounted(true);
    });
    return () => cancelAnimationFrame(id);
  }, [autoPlayMuted, clip]);

  useEffect(() => {
    if (!mounted) return;
    const el = video.current;
    if (!el) return;
    el.muted = muted;
    void el.play().catch(() => undefined);
  }, [clip, mounted, muted]);

  const mute = () => {
    if (video.current) video.current.muted = true;
    setMuted(true);
  };

  function play() {
    if (sound) {
      muteCurrent?.();
      muteCurrent = mute;
      setMuted(false);
    } else {
      setMuted(true);
    }
    setMounted(true);
  }

  const toggleSound = () => {
    const el = video.current;
    if (!el) return;
    if (!muted) {
      mute();
      muteCurrent = null;
      return;
    }
    muteCurrent?.();
    muteCurrent = mute;
    el.muted = false;
    setMuted(false);
    void el.play();
  };

  const showPoster = !started;

  return (
    <div className="clip-frame">
      {tag ? <span className="poster-tag">{tag}</span> : null}
      {mounted ? (
        <video
          ref={video}
          key={clip}
          src={`/media/${clip}.mp4`}
          poster={posterSrc(clip)}
          muted={muted}
          loop
          playsInline
          preload="auto"
          aria-label={label}
          onPlaying={() => {
            setStarted(true);
            onPlayingRef.current?.();
          }}
        />
      ) : null}
      {showPoster ? (
        <>
          <img
            className={mounted ? 'clip-poster clip-poster-pending' : 'clip-poster'}
            src={posterSrc(clip)}
            alt=""
            width={720}
            height={1280}
            decoding={priority ? 'sync' : 'async'}
            {...(priority ? { fetchPriority: 'high' as const } : {})}
          />
          {!mounted ? (
            <button type="button" className="clip-play" onClick={play} aria-label={m.home_clip_play()}>
              <span className="clip-play-icon" />
            </button>
          ) : null}
        </>
      ) : null}
      {mounted && sound ? (
        <button
          type="button"
          className="sound-toggle"
          onClick={toggleSound}
          aria-pressed={!muted}
          aria-label={muted ? m.home_sound_on() : m.home_sound_mute()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M11 5 6 9H3v6h3l5 4z" />
            {muted ? <path d="m16 9 5 6m0-6-5 6" /> : <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />}
          </svg>
        </button>
      ) : null}
    </div>
  );
}
