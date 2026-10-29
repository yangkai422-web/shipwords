import { pageHead } from '@shipwords/core/seo';
import { useGeneration } from '@shipwords/jobs/react';
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { m } from '~/paraglide/messages.js';
import { BeforeYouPay, formatPrice, Plans, packName } from '~/site/pricing';
import { ReturnNotice, TinyDeskTool } from '~/site/tool';
import site from '../../site.config';

// Generator home page: face swap any of the 5 slots on stage, same price for 1–5 people. Sign in (Google One Tap), buy credits, then generate; no free trial.
// Upload and generation live in ~/site/tool; the whole clip is swapped in one pass, re-aligned to the original cuts with the song mixed back in, plus a silent copy.
// The generator suggests friends, coworkers and teammates, never uploading celebrity photos.
// Copy lives in messages/home; locale depends on the request, so the constants below hold message functions called at render.

const RESOLUTION = '720p';
const BAND_PRICE = formatPrice(site.products[0]);

// The 4 original shots of the viral clip (shot-*.mp4 in public/media), cut at the original cut points. Swap in real FaceRiff outputs once they exist.
const SHOTS = [
  { time: '0:00', name: m.home_shot_band, who: m.home_shot_band_who, clip: 'shot-band' },
  { time: '0:05', name: m.home_shot_lead, who: m.home_shot_lead_who, clip: 'shot-lead' },
  { time: '0:12', name: m.home_shot_sax, who: m.home_shot_sax_who, clip: 'shot-sax' },
  { time: '0:15', name: m.home_shot_band2, who: m.home_shot_band_who, clip: 'shot-band2' },
];

// Viral wall below the hero: the first two are viral TikToks trimmed at the end of the performance (tutorial ad removed), labeled as trend references, not our usage;
// the third is a real output from this site (lead only: a Georgia coach replaces the Alabama coach, the rest is original). It links back to the product and is the page's VideoObject sample.
// Viral wall: hidden until clips exist (needs viral-warriors, viral-nfl and a real output sample-new-lead in public/media).
const VIRAL: { tag: () => string; label: () => string; hook: () => string; clip: string; note: () => string }[] = [];
/* Previous entries:
const VIRAL = [
  {
    tag: m.home_viral_warriors_tag,
    label: m.home_viral_warriors_label,
    hook: m.home_viral_warriors_hook,
    clip: 'viral-warriors',
    note: m.home_viral_note_tiktok,
  },
  {
    tag: m.home_viral_nfl_tag,
    label: m.home_viral_nfl_label,
    hook: m.home_viral_nfl_hook,
    clip: 'viral-nfl',
    note: m.home_viral_note_tiktok,
  },
  {
    tag: m.home_viral_new_lead_tag,
    label: m.home_viral_new_lead_label,
    hook: m.home_viral_new_lead_hook,
    clip: 'sample-new-lead',
    note: m.home_viral_note_ours,
  },
];
*/

// Meme origin. Dates checked: NPR published 2023-06-05; Outstanding is from The Gap Band IV (1982).
const ORIGIN = [
  { when: m.home_origin_2023_when, text: m.home_origin_2023_text },
  { when: m.home_origin_2026_when, text: m.home_origin_2026_text },
  { when: m.home_origin_now_when, text: m.home_origin_now_text },
];

// Scene entries put celebrities first: the meme itself is about celebrities, so the friends version goes last.
const CREWS = [
  { title: m.home_crew_losers_title, text: m.home_crew_losers_text },
  { title: m.home_crew_rival_title, text: m.home_crew_rival_text },
  { title: m.home_crew_players_title, text: m.home_crew_players_text },
  { title: m.home_crew_you_title, text: m.home_crew_you_text },
  { title: m.home_crew_chat_title, text: m.home_crew_chat_text },
];

const STEPS = [
  { title: m.home_step_cast_title, text: m.home_step_cast_text },
  { title: m.home_step_make_title, text: m.home_step_make_text },
  { title: m.home_step_post_title, text: m.home_step_post_text },
];

// FAQ in our own words, covering the follow-ups ChatGPT asked in tests: price, number of photos, model, wait time, CapCut, whether it can be posted, whether it is real.
const FAQ: { q: () => string; a: () => string }[] = [
  { q: m.home_faq_what_q, a: () => m.home_faq_what_a({ name: site.name }) },
  { q: m.home_faq_people_q, a: m.home_faq_people_a },
  {
    q: m.home_faq_cost_q,
    a: () =>
      m.home_faq_cost_a({ plans: site.products.map((p) => `${packName(p)} ${formatPrice(p)}`).join(', ') }),
  },
  { q: m.home_faq_free_q, a: m.home_faq_free_a },
  { q: m.home_faq_model_q, a: () => m.home_faq_model_a({ resolution: RESOLUTION }) },
  { q: m.home_faq_time_q, a: m.home_faq_time_a },
  { q: m.home_faq_format_q, a: () => m.home_faq_format_a({ resolution: RESOLUTION }) },
  { q: m.home_faq_song_q, a: m.home_faq_song_a },
  { q: m.home_faq_capcut_q, a: m.home_faq_capcut_a },
  { q: m.home_faq_photo_q, a: m.home_faq_photo_a },
  { q: m.home_faq_celebrity_q, a: m.home_faq_celebrity_a },
  { q: m.home_faq_real_q, a: m.home_faq_real_a },
  { q: m.home_faq_post_q, a: m.home_faq_post_a },
  { q: m.home_faq_fail_q, a: m.home_faq_fail_a },
  { q: m.home_faq_photos_q, a: m.home_faq_photos_a },
  { q: m.home_faq_npr_q, a: () => m.home_faq_npr_a({ name: site.name }) },
];

export const Route = createFileRoute('/')({
  head: () =>
    pageHead(site, {
      title: m.home_title(),
      description: m.home_description({ price: BAND_PRICE }),
      path: '/',
      jsonLd: [
        {
          '@type': 'WebApplication',
          name: site.name,
          url: site.url,
          applicationCategory: 'MultimediaApplication',
          operatingSystem: 'Web',
          offers: site.products.map((p) => ({
            '@type': 'Offer',
            name: p.name,
            price: (p.price.amount / 100).toFixed(2),
            priceCurrency: p.price.currency.toUpperCase(),
          })),
        },
        {
          '@type': 'FAQPage',
          mainEntity: FAQ.map((item) => ({
            '@type': 'Question',
            name: item.q(),
            acceptedAnswer: { '@type': 'Answer', text: item.a() },
          })),
        },
      ],
    }),
  component: HomePage,
});

// Only one video plays sound at a time: unmuting a new one mutes the previous.
let muteCurrent: (() => void) | null = null;

// Video with original audio: muted autoplay by default; click the frame or the top-right toggle for sound.
// Switching clips keeps the same video element: if sound is on it stays on and the new clip keeps playing.
function SoundClip({ clip, tag, label }: { clip: string; tag: string; label: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the src changes with clip; keep playing when sound is on
  useEffect(() => {
    const el = video.current;
    if (el && !el.muted) void el.play().catch(() => undefined);
  }, [clip]);
  const mute = () => {
    if (video.current) video.current.muted = true;
    setMuted(true);
  };
  const toggle = () => {
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
    void el.play();
    setMuted(false);
  };
  return (
    <div className="clip-frame">
      <span className="poster-tag">{tag}</span>
      <video
        ref={video}
        src={`/media/${clip}.mp4`}
        poster={`/media/${clip}.jpg`}
        autoPlay
        muted
        loop
        playsInline
        preload="metadata"
        aria-label={label}
        onClick={toggle}
      />
      <button
        type="button"
        className="sound-toggle"
        onClick={toggle}
        aria-pressed={!muted}
        aria-label={muted ? m.home_sound_on() : m.home_sound_mute()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M11 5 6 9H3v6h3l5 4z" />
          {muted ? (
            <path d="m16 9 5 6m0-6-5 6" />
          ) : (
            <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" />
          )}
        </svg>
      </button>
    </div>
  );
}

// Hero compare: original viral coaches clip (before) next to the Knicks Tiny Desk cut (after),
// same idea as tinydeskai.io's sample area but always shown side by side. Dog / ours tabs stay hidden.
const COMPARE = {
  before: {
    clip: 'viral-coaches',
    tag: m.home_viral_coaches_tag,
    label: m.home_viral_coaches_label,
    chip: m.home_compare_before,
  },
  after: {
    clip: 'viral-knicks',
    tag: m.home_viral_knicks_tag,
    label: m.home_viral_knicks_label,
    chip: m.home_compare_after,
  },
} as const;

function HeroCompare() {
  return (
    <figure className="sample-card sample-compare">
      <div className="compare-pair">
        {(Object.keys(COMPARE) as (keyof typeof COMPARE)[]).map((side) => {
          const item = COMPARE[side];
          return (
            <div key={side} className={`compare-col compare-${side}`}>
              <span className="compare-chip">{item.chip()}</span>
              <SoundClip clip={item.clip} tag={item.tag()} label={item.label()} />
            </div>
          );
        })}
      </div>
      <figcaption>
        <strong>{m.home_compare_caption()}</strong>
        <span className="mono">{m.home_compare_note()}</span>
      </figcaption>
    </figure>
  );
}
const root = getRouteApi('__root__');

function HomePage() {
  const config = root.useLoaderData();
  const generation = useGeneration({ recaptchaSiteKey: config.recaptchaSiteKey });
  return (
    <>
      <section className="hero" id="make">
        <div className="hero-head">
          <ReturnNotice jobs={generation.jobs} />
          <p className="rec mono">{m.home_hero_rec()}</p>
          <h1>{m.home_hero_title()}</h1>
          <p className="lead">{m.home_hero_lead()}</p>
        </div>
        <HeroCompare />
        <div className="hero-tool">
          <TinyDeskTool generation={generation} stage="viral" />
        </div>
      </section>

      {VIRAL.length > 0 && (
      <section className="band" id="fyp">
        <p className="kicker">{m.home_fyp_kicker()}</p>
        <h2>{m.home_fyp_title()}</h2>
        <ul className="viral">
          {VIRAL.map((item) => (
            <li key={item.clip}>
              <SoundClip clip={item.clip} tag={item.tag()} label={item.label()} />
              <strong>{item.hook()}</strong>
              <span className="mono muted">{item.note()}</span>
            </li>
          ))}
        </ul>
      </section>
      )}

      <div className="ticker" aria-hidden="true">
        <div className="ticker-track">
          {[0, 1].map((k) => (
            <span key={k}>
              {['Tiny Desk AI 🎤', 'Rumpelstiltskin ✨', 'Burning Bridges 🔥', 'Gas station dance 🕺', 'Zombie AI 🧟', 'AI hamster dance 🐹', 'AI dog meme 🐶'].map((t) => (
                <b key={t}>{t}</b>
              ))}
            </span>
          ))}
        </div>
      </div>
      <section className="band" id="whats-in">
        <p className="kicker">{m.home_cut_kicker()}</p>
        <h2>{m.home_cut_title()}</h2>
        <p className="muted">{m.home_cut_text()}</p>
        <ol className="shots">
          {SHOTS.map((shot) => (
            <li key={shot.time}>
              <video
                src={`/media/${shot.clip}.mp4`}
                poster={`/media/${shot.clip}.jpg`}
                autoPlay
                muted
                loop
                playsInline
                preload="none"
                aria-label={m.home_shot_label({ name: shot.name() })}
              />
              <span className="mono">{shot.time}</span>
              <strong>{shot.name()}</strong>
              <span className="muted">{shot.who()}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="sheet" id="how">
        <h2>{m.home_how_title()}</h2>
        <ol className="steps">
          {STEPS.map((step) => (
            <li key={step.title()}>
              <h3>{step.title()}</h3>
              <p>{step.text()}</p>
            </li>
          ))}
        </ol>
        <p className="steps-more">
          <Link to="/how-to-make-outstanding-tiny-desk-ai-video">{m.home_how_guide_link()}</Link>
        </p>
      </section>

      <section className="band" id="pricing">
        <h2>{m.home_pricing_title()}</h2>
        <Plans />
        <BeforeYouPay />
      </section>

      <section className="band" id="crews">
        <p className="kicker">{m.home_crews_kicker()}</p>
        <h2>{m.home_crews_title()}</h2>
        <ul className="lineup">
          {CREWS.map((crew) => (
            <li key={crew.title()}>
              <h3>{crew.title()}</h3>
              <p className="muted">{crew.text()}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="band" id="meme">
        <h2>{m.home_meme_title()}</h2>
        <ol className="origin">
          {ORIGIN.map((item) => (
            <li key={item.when()}>
              <span className="mono">{item.when()}</span>
              <p className="origin-text">{item.text()}</p>
            </li>
          ))}
        </ol>
        <p className="muted">
          <Link to="/outstanding-tiny-desk-meme">{m.home_meme_story_link()}</Link>
          {m.home_meme_or_original()}{' '}
          <a href="https://www.rollingstone.com/music/music-news/charlie-wilson-gap-band-tiny-desk-1234759558/">
            {m.home_meme_original_link()}
          </a>
        </p>
      </section>

      <section className="sheet faq" id="faq">
        <h2>{m.home_faq_title()}</h2>
        {FAQ.map((item) => (
          <details key={item.q()}>
            <summary>{item.q()}</summary>
            <p>{item.a()}</p>
          </details>
        ))}
      </section>

      <section className="band closer">
        <h2>{m.home_closer_title()}</h2>
        <p className="muted">{m.home_closer_text({ price: BAND_PRICE })}</p>
        <a className="button primary closer-cta" href="#make">
          {m.home_closer_cta()}
        </a>
      </section>
    </>
  );
}
