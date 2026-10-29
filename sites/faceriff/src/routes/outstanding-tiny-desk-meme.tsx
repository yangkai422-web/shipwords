import { pageHead } from '@shipwords/core/seo';
import { createFileRoute, Link } from '@tanstack/react-router';
import { m } from '~/paraglide/messages.js';
import { Faq, type FaqItem, faqJsonLd, GuidePage } from '~/site/guide';
import site from '../../site.config';

// Meme origin page: targets "outstanding tiny desk meme" and "is the tiny desk coaches video real".
// Checked facts only: NPR published Charlie Wilson's Tiny Desk on 2023-06-05; Outstanding is from The Gap Band IV (1982);
// in 2026-10 the coach face swap went viral on TikTok (the hero clip, College Football Week 8, about 288K likes); US Google Trends rose from 10-21.

const PATH = '/outstanding-tiny-desk-meme';

const timeline = () => [
  { when: '1982', text: m.guides_meme_timeline_1982() },
  { when: m.guides_meme_timeline_2023_when(), text: m.guides_meme_timeline_2023() },
  { when: m.guides_meme_timeline_2026_when(), text: m.guides_meme_timeline_2026() },
  { when: m.guides_meme_timeline_late_when(), text: m.guides_meme_timeline_late() },
];

const faq = (): FaqItem[] => [
  { q: m.guides_meme_faq1_q(), a: m.guides_meme_faq1_a() },
  { q: m.guides_meme_faq2_q(), a: m.guides_meme_faq2_a() },
  { q: m.guides_meme_faq3_q(), a: m.guides_meme_faq3_a() },
  { q: m.guides_meme_faq4_q(), a: m.guides_meme_faq4_a() },
  { q: m.guides_meme_faq5_q(), a: m.guides_meme_faq5_a({ site: site.name }) },
];

export const Route = createFileRoute('/outstanding-tiny-desk-meme')({
  head: () =>
    pageHead(site, {
      title: m.guides_meme_meta_title(),
      description: m.guides_meme_meta_description(),
      path: PATH,
      jsonLd: [
        {
          '@type': 'Article',
          headline: m.guides_meme_title(),
          datePublished: '2026-10-27',
          dateModified: '2026-10-27',
          author: { '@type': 'Organization', name: site.name, url: site.url },
        },
        faqJsonLd(faq()),
      ],
    }),
  component: MemePage,
});

function MemePage() {
  return (
    <GuidePage
      path={PATH}
      title={m.guides_meme_title()}
      updated={m.guides_meme_updated()}
      intro={<p>{m.guides_meme_intro()}</p>}
    >
      <h2>{m.guides_meme_source_heading()}</h2>
      <p>{m.guides_meme_source_text()}</p>

      <h2>{m.guides_meme_timeline_heading()}</h2>
      <ol className="guide-timeline">
        {timeline().map((item) => (
          <li key={item.when}>
            <span className="mono">{item.when}</span>
            <p>{item.text}</p>
          </li>
        ))}
      </ol>

      <h2>{m.guides_meme_why_heading()}</h2>
      <ul>
        <li>{m.guides_meme_why_laugh()}</li>
        <li>{m.guides_meme_why_five()}</li>
        <li>{m.guides_meme_why_short()}</li>
        <li>{m.guides_meme_why_weekly()}</li>
      </ul>

      <h2>{m.guides_meme_real_heading()}</h2>
      <p>{m.guides_meme_real_text()}</p>

      <h2>{m.guides_meme_make_heading()}</h2>
      <p>
        {m.guides_meme_make_before({ site: site.name })}{' '}
        <Link to="/how-to-make-outstanding-tiny-desk-ai-video">{m.guides_meme_make_howto_link()}</Link>
        {m.guides_meme_make_and()}{' '}
        <Link to="/outstanding-tiny-desk-ai-template">{m.guides_meme_make_template_link()}</Link>
        {m.guides_meme_make_after()}
      </p>
      <p className="muted">{m.guides_meme_disclaimer({ site: site.name })}</p>

      <Faq title={m.guides_meme_faq_title()} items={faq()} />
    </GuidePage>
  );
}
