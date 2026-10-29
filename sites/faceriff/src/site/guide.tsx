import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { m } from '~/paraglide/messages.js';

// Shared by the guide pages (tutorial, template, meme origin, free comparison): long poster-paper card (DESIGN.md "Content pages"), FAQ and footer links.
// Each page answers one sub-question; that is the kind of page ChatGPT cited in tests. Register new guides in GUIDES; sitemap, llms.txt and footer read from it.

export const GUIDES = [
  {
    path: '/how-to-make-outstanding-tiny-desk-ai-video',
    title: m.common_guide_howto_title,
    description: m.common_guide_howto_description,
  },
  {
    path: '/outstanding-tiny-desk-ai-template',
    title: m.common_guide_template_title,
    description: m.common_guide_template_description,
  },
  {
    path: '/outstanding-tiny-desk-meme',
    title: m.common_guide_meme_title,
    description: m.common_guide_meme_description,
  },
  {
    path: '/tiny-desk-ai-free',
    title: m.common_guide_free_title,
    description: m.common_guide_free_description,
  },
] as const;

export interface FaqItem {
  q: string;
  a: string;
}

export function faqJsonLd(items: FaqItem[]) {
  return {
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
}

export function Faq({ title, items }: { title: string; items: FaqItem[] }) {
  return (
    <div className="faq">
      <h2>{title}</h2>
      {items.map((item) => (
        <details key={item.q}>
          <summary>{item.q}</summary>
          <p>{item.a}</p>
        </details>
      ))}
    </div>
  );
}

export function GuidePage({
  path,
  title,
  intro,
  updated,
  children,
}: {
  path: string;
  title: string;
  intro: ReactNode;
  updated: string;
  children: ReactNode;
}) {
  return (
    <article className="sheet guide">
      <p className="kicker">{m.common_guide_kicker()}</p>
      <h1>{title}</h1>
      <p className="muted mono">{m.common_guide_updated({ date: updated })}</p>
      <div className="guide-intro">{intro}</div>
      {children}
      <div className="guide-cta">
        <a className="button primary" href="/#make">
          {m.common_guide_cta()}
        </a>
        <span className="muted">{m.common_guide_cta_note()}</span>
      </div>
      <nav className="guide-more" aria-label={m.common_guide_more_label()}>
        <h2>{m.common_guide_more_heading()}</h2>
        <ul>
          {GUIDES.filter((guide) => guide.path !== path).map((guide) => (
            <li key={guide.path}>
              <Link to={guide.path}>{guide.title()}</Link>
              <span className="muted"> — {guide.description()}</span>
            </li>
          ))}
          <li>
            <a href="/#pricing">{m.common_guide_pricing_link()}</a>
            <span className="muted"> — {m.common_guide_pricing_description()}</span>
          </li>
        </ul>
      </nav>
    </article>
  );
}
