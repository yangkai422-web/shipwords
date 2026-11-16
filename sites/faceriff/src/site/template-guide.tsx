import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { m } from '~/paraglide/messages.js';
import { ClickToPlayClip } from '~/site/clip';
import { Faq, type FaqItem, faqJsonLd, GuidePage } from '~/site/guide';
import { getAnchorProduct } from '~/site/packs';
import { formatPrice } from '~/site/pricing';
import site from '../../site.config';

// Shared body for /tiny-desk-template and /outstanding-tiny-desk-ai-template.
// Each route keeps its own title, description, intro, canonical path and cross-link.

const ANCHOR_PRICE = formatPrice(getAnchorProduct());

export const templateShots = () => [
  {
    time: '0:00?0:05',
    name: m.guides_template_shot_band(),
    seats: m.guides_template_seats_band(),
    clip: 'shot-band',
  },
  {
    time: '0:05?0:12',
    name: m.guides_template_shot_lead(),
    seats: m.guides_template_seats_lead(),
    clip: 'shot-lead',
  },
  {
    time: '0:12?0:15',
    name: m.guides_template_shot_sax(),
    seats: m.guides_template_seats_sax(),
    clip: 'shot-sax',
  },
  {
    time: '0:15?0:18',
    name: m.guides_template_shot_band2(),
    seats: m.guides_template_seats_band(),
    clip: 'shot-band2',
  },
];

export const templateFaq = (): FaqItem[] => [
  {
    q: m.guides_template_faq1_q(),
    a: m.guides_template_faq1_a({ site: site.name, price: ANCHOR_PRICE }),
  },
  { q: m.guides_template_faq2_q(), a: m.guides_template_faq2_a() },
  { q: m.guides_template_faq3_q(), a: m.guides_template_faq3_a() },
  { q: m.guides_template_faq4_q(), a: m.guides_template_faq4_a() },
  { q: m.guides_template_faq5_q(), a: m.guides_template_faq5_a() },
];

export function templateFaqJsonLd() {
  return faqJsonLd(templateFaq());
}

export function TinyDeskTemplateGuide({
  path,
  title,
  updated,
  intro,
  crossLink,
}: {
  path: string;
  title: string;
  updated: string;
  intro: ReactNode;
  crossLink: ReactNode;
}) {
  const shotList = templateShots();
  return (
    <GuidePage path={path} title={title} updated={updated} intro={intro}>
      {crossLink}
      <h2>{m.guides_template_shots_heading()}</h2>
      <p>{m.guides_template_shots_intro()}</p>
      <ol className="shots guide-shots">
        {shotList.map((shot) => (
          <li key={shot.time}>
            <ClickToPlayClip clip={shot.clip} label={m.guides_template_shot_aria({ shot: shot.name })} />
            <span className="mono">{shot.time}</span>
            <strong>{shot.name}</strong>
          </li>
        ))}
      </ol>

      <h2>{m.guides_template_spots_heading()}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{m.guides_template_spots_col_time()}</th>
              <th>{m.guides_template_spots_col_shot()}</th>
              <th>{m.guides_template_spots_col_who()}</th>
            </tr>
          </thead>
          <tbody>
            {shotList.map((shot) => (
              <tr key={shot.time}>
                <td className="mono">{shot.time}</td>
                <td>{shot.name}</td>
                <td>{shot.seats}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>{m.guides_template_spots_outro()}</p>

      <h2>{m.guides_template_start_heading()}</h2>
      <p>{m.guides_template_start_text()}</p>

      <h2>{m.guides_template_vs_heading()}</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th />
              <th>{m.guides_template_vs_col_capcut()}</th>
              <th>{site.name}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>{m.guides_template_vs_cuts()}</td>
              <td>{m.guides_template_vs_cuts_capcut()}</td>
              <td>{m.guides_template_vs_cuts_us()}</td>
            </tr>
            <tr>
              <td>{m.guides_template_vs_face()}</td>
              <td>{m.guides_template_vs_face_capcut()}</td>
              <td>{m.guides_template_vs_face_us()}</td>
            </tr>
            <tr>
              <td>{m.guides_template_vs_people()}</td>
              <td>{m.guides_template_vs_people_capcut()}</td>
              <td>{m.guides_template_vs_people_us()}</td>
            </tr>
            <tr>
              <td>{m.guides_template_vs_editing()}</td>
              <td>{m.guides_template_vs_editing_capcut()}</td>
              <td>{m.guides_template_vs_editing_us()}</td>
            </tr>
            <tr>
              <td>{m.guides_template_vs_price()}</td>
              <td>{m.guides_template_vs_price_capcut()}</td>
              <td>{m.guides_template_vs_price_us({ price: ANCHOR_PRICE })}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p>
        {m.guides_template_more_before()}{' '}
        <Link to="/how-to-make-outstanding-tiny-desk-ai-video">{m.guides_template_more_link()}</Link>
        {m.guides_template_more_after()}
      </p>

      <Faq title={m.guides_template_faq_title()} items={templateFaq()} />
    </GuidePage>
  );
}
