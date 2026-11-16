import { pageHead } from '@shipwords/core/seo';
import { useGeneration } from '@shipwords/jobs/react';
import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { getGenerationCount } from '~/lib/generation-stats';
import { track } from '~/lib/track';
import { m } from '~/paraglide/messages.js';
import { ClickToPlayClip } from '~/site/clip';
import { BeforeYouPay, formatPrice, Plans, packName } from '~/site/pricing';
import { ReturnNotice, TinyDeskTool } from '~/site/tool';
import site from '../../site.config';

// Generator home page: face swap any of the 5 slots on stage, same price for 1–5 people. Render starts a free preview; checkout still needs sign-in. A one-time $2.99 trial unlocks one full video; $9.88 stays the 1-video price.
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
  loader: () => getGenerationCount(),
  head: () =>
    pageHead(site, {
      title: m.home_title(),
      description: m.home_description({ price: BAND_PRICE }),
      path: '/',
      image: `${site.url}/og.jpg`,
      imageWidth: 1200,
      imageHeight: 630,
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
                        acceptedAnswer: {
              '@type': 'Answer',
              text:
                item.q === m.home_faq_free_q
                  ? `${item.a()} For what the free routes (CapCut, free credits, other generators) can and can't do, see https://faceriff.com/tiny-desk-ai-free.`
                  : item.a(),
            },
          })),
        },
      ],
    }),
  component: HomePage,
});


// Real user quotes or social screenshots only. Leave empty until authentic material exists.
const TESTIMONIALS: { quote: string; name: string; source?: string; image?: string }[] = [];

function generatedLabel(count: number) {
  return count === 1 ? m.home_generated_count_one() : m.home_generated_count({ count });
}

// Hero sample: side-by-side original viral clip (coaches) → finished real-person cut (Knicks).
// The finished clip autoplays muted after first paint; its WebP poster is the LCP fallback.
// The original mp4 loads only after the finished clip starts (or a short fallback delay).
// Cats stay as a secondary example and are not the default first-screen sample or seat presets.
type HeroView = 'compare' | 'cats';

const CATS_CLIP = {
  clip: 'sample-cats',
  tab: m.home_hero_tab_cats,
  tag: m.home_cats_band_tag,
  label: m.home_cats_band_label,
  hook: m.home_cats_band_hook,
  note: m.home_cats_band_note,
} as const;

function HeroClip({ view, onPick }: { view: HeroView; onPick: (view: HeroView) => void }) {
  const [loadOriginal, setLoadOriginal] = useState(false);
  // Prefetch WebP posters only (no mp4) so a tab switch does not flash black.
  useEffect(() => {
    for (const clip of ['viral-knicks', 'viral-coaches', 'sample-cats']) {
      new Image().src = `/media/${clip}.webp`;
    }
  }, []);
  useEffect(() => {
    if (view !== 'compare') return;
    const timer = window.setTimeout(() => setLoadOriginal(true), 2000);
    return () => window.clearTimeout(timer);
  }, [view]);
  return (
    <figure className={view === 'compare' ? 'sample-card sample-compare' : 'sample-card'}>
      <fieldset className="clip-switch" aria-label={m.home_hero_tab_label()}>
        <button type="button" aria-pressed={view === 'compare'} onClick={() => onPick('compare')}>
          {m.home_hero_tab_compare()}
        </button>
        <button type="button" aria-pressed={view === 'cats'} onClick={() => onPick('cats')}>
          {CATS_CLIP.tab()}
        </button>
      </fieldset>
      {view === 'compare' ? (
        <>
          <div className="compare-pair">
            <div className="compare-col compare-before">
              <span className="compare-chip">{m.home_compare_before()}</span>
              <ClickToPlayClip
                clip="viral-coaches"
                tag={m.home_viral_coaches_tag()}
                label={m.home_viral_coaches_label()}
                sound
                autoPlayMuted={loadOriginal}
              />
            </div>
            <div className="compare-col compare-after">
              <span className="compare-chip">{m.home_compare_after()}</span>
              <ClickToPlayClip
                clip="viral-knicks"
                tag={m.home_viral_knicks_tag()}
                label={m.home_viral_knicks_label()}
                sound
                autoPlayMuted
                priority
                onPlaying={() => setLoadOriginal(true)}
              />
            </div>
          </div>
          <figcaption>
            <strong>{m.home_compare_caption()}</strong>
            <span className="mono">{m.home_compare_note()}</span>
          </figcaption>
        </>
      ) : (
        <>
          <ClickToPlayClip
            clip={CATS_CLIP.clip}
            tag={CATS_CLIP.tag()}
            label={CATS_CLIP.label()}
            sound
            autoPlayMuted
          />
          <figcaption>
            <strong>{CATS_CLIP.hook()}</strong>
            <span className="mono">{CATS_CLIP.note()}</span>
          </figcaption>
        </>
      )}
    </figure>
  );
}
const root = getRouteApi('__root__');

function HomePage() {
  const config = root.useLoaderData();
  const generatedCount = Route.useLoaderData();
  const generation = useGeneration({ recaptchaSiteKey: config.recaptchaSiteKey });
  const [heroView, setHeroView] = useState<HeroView>('compare');
  useEffect(() => {
    track('home_view');
  }, []);
  return (
    <>
      <section className="hero" id="make">
        <div className="hero-head">
          <ReturnNotice jobs={generation.jobs} />
          <p className="rec mono">{m.home_hero_rec()}</p>
          <h1>{m.home_hero_title()}</h1>
          <p className="hero-hook">{m.home_hero_hook()}</p>
          <p className="lead">{m.home_hero_lead()}</p>
          <p className="social-count mono">{generatedLabel(generatedCount)}</p>
          <p className="muted mono">{m.common_guide_updated({ date: m.home_updated_date() })}</p>
        </div>
        <HeroClip view={heroView} onPick={setHeroView} />
        <div className="hero-tool">
          <TinyDeskTool generation={generation} stage={heroView === 'cats' ? 'dogs' : 'ours'} />
        </div>
      </section>

      {TESTIMONIALS.length > 0 && (
        <section className="band social-proof" id="proof">
          <p className="social-count mono">{generatedLabel(generatedCount)}</p>
          <ul className="testimonials">
            {TESTIMONIALS.map((item) => (
              <li key={`${item.name}-${item.quote.slice(0, 24)}`}>
                {item.image ? <img src={item.image} alt="" /> : null}
                <blockquote>{item.quote}</blockquote>
                <p className="mono muted">
                  {item.name}
                  {item.source ? ` · ${item.source}` : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {VIRAL.length > 0 && (
      <section className="band" id="fyp">
        <p className="kicker">{m.home_fyp_kicker()}</p>
        <h2>{m.home_fyp_title()}</h2>
        <ul className="viral">
          {VIRAL.map((item) => (
            <li key={item.clip}>
              <ClickToPlayClip clip={item.clip} tag={item.tag()} label={item.label()} sound />
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
              {['Tiny Desk AI 🎤', 'Outstanding encore 🎷', 'Tiny Desk meme ✨', 'AI face swap 🎭', 'Your cast on desk 🪑'].map((t) => (
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
              <ClickToPlayClip clip={shot.clip} label={m.home_shot_label({ name: shot.name() })} />
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
          {' · '}
          <a href="/tiny-desk-ai-free">Free vs paid options</a>
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
                        <p>
              {item.a()}
              {item.q === m.home_faq_free_q && (
                <>
                  {' '}For what the free routes (CapCut, free credits, other generators) can and can't do, see{' '}
                  <a href="/tiny-desk-ai-free">what the free Tiny Desk AI options actually do</a>.
                </>
              )}
            </p>
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
