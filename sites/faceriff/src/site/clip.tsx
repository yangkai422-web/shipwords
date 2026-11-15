import { useEffect, useRef, useState } from 'react';
import { m } from '~/paraglide/messages.js';

// Poster first: the mp4 is requested only after a click (no autoplay, no preload on first paint).
// Only one clip plays sound at a time.
let muteCurrent: (() => void) | null = null;

function posterSrc(clip: string) {
  return `/media/${clip}.webp`;
}

export function ClickToPlayClip({
  clip,
  tag,
  label,
  sound = false,
}: {
  clip: string;
  tag?: string;
  label: string;
  sound?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    if (!playing) return;
    const el = video.current;
    if (!el) return;
    el.muted = muted;
    void el.play().catch(() => undefined);
  }, [clip, playing, muted]);

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
    setPlaying(true);
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

  return (
    <div className="clip-frame">
      {tag ? <span className="poster-tag">{tag}</span> : null}
      {playing ? (
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
        />
      ) : (
        <>
          <img className="clip-poster" src={posterSrc(clip)} alt="" width={720} height={1280} />
          <button type="button" className="clip-play" onClick={play} aria-label={m.home_clip_play()}>
            <span className="clip-play-icon" />
          </button>
        </>
      )}
      {playing && sound ? (
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
