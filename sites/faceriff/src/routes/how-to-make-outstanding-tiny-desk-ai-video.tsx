import { pageHead } from '@shipwords/core/seo';
import { createFileRoute } from '@tanstack/react-router';
import { m } from '~/paraglide/messages.js';
import { Faq, type FaqItem, faqJsonLd, GuidePage } from '~/site/guide';
import { formatPrice } from '~/site/pricing';
import site from '../../site.config';

// Tutorial page: user-facing steps, photo requirements, output notes and what to do when it goes wrong. Internals (shot split, parameters, test data) stay private.
// Copy follows the request locale, so the arrays below are functions called at render.

const PATH = '/how-to-make-outstanding-tiny-desk-ai-video';

const steps = () => [
  { name: m.guides_howto_step1_name(), text: m.guides_howto_step1_text() },
  { name: m.guides_howto_step2_name(), text: m.guides_howto_step2_text() },
  { name: m.guides_howto_step3_name(), text: m.guides_howto_step3_text() },
  { name: m.guides_howto_step4_name(), text: m.guides_howto_step4_text() },
];

const faq = (): FaqItem[] => [
  { q: m.guides_howto_faq1_q(), a: m.guides_howto_faq1_a() },
  { q: m.guides_howto_faq2_q(), a: m.guides_howto_faq2_a() },
  { q: m.guides_howto_faq3_q(), a: m.guides_howto_faq3_a() },
  { q: m.guides_howto_faq4_q(), a: m.guides_howto_faq4_a() },
  { q: m.guides_howto_faq5_q(), a: m.guides_howto_faq5_a() },
  { q: m.guides_howto_faq6_q(), a: m.guides_howto_faq6_a() },
];

export const Route = createFileRoute('/how-to-make-outstanding-tiny-desk-ai-video')({
  head: () =>
    pageHead(site, {
      title: m.guides_howto_meta_title(),
      description: m.guides_howto_meta_description(),
      path: PATH,
      jsonLd: [
        {
          '@type': 'HowTo',
          name: m.guides_howto_title(),
          totalTime: 'PT10M',
          estimatedCost: {
            '@type': 'MonetaryAmount',
            currency: site.products[0].price.currency.toUpperCase(),
            value: (site.products[0].price.amount / 100).toFixed(2),
          },
          step: steps().map((step, i) => ({
            '@type': 'HowToStep',
            position: i + 1,
            name: step.name,
            text: step.text,
          })),
        },
        faqJsonLd(faq()),
      ],
    }),
  component: HowToPage,
});

function HowToPage() {
  return (
    <GuidePage
      path={PATH}
      title={m.guides_howto_title()}
      updated={m.guides_howto_updated()}
      intro={<p>{m.guides_howto_intro()}</p>}
    >
      <h2>{m.guides_howto_need_heading()}</h2>
      <ul>
        <li>{m.guides_howto_need_photos()}</li>
        <li>{m.guides_howto_need_people()}</li>
        <li>
          {m.guides_howto_need_price({ price: formatPrice(site.products[0]) })}
          <a href="/#pricing">{m.guides_howto_need_price_link()}</a>
          {m.guides_howto_need_price_after()}
        </li>
      </ul>

      {steps().map((step, i) => (
        <section key={step.name}>
          <h2>{m.guides_howto_step_heading({ n: i + 1, name: step.name })}</h2>
          <p>{step.text}</p>
        </section>
      ))}

      <h2>{m.guides_howto_photo_heading()}</h2>
      <ul>
        <li>{m.guides_howto_photo_one_face()}</li>
        <li>{m.guides_howto_photo_light()}</li>
        <li>{m.guides_howto_photo_no_cover()}</li>
        <li>{m.guides_howto_photo_no_filter()}</li>
        <li>{m.guides_howto_photo_plain()}</li>
      </ul>

      <h2>{m.guides_howto_expect_heading()}</h2>
      <ul>
        <li>{m.guides_howto_expect_video()}</li>
        <li>{m.guides_howto_expect_silent()}</li>
        <li>{m.guides_howto_expect_time()}</li>
        <li>{m.guides_howto_expect_lipsync()}</li>
      </ul>

      <h2>{m.guides_howto_fix_heading()}</h2>
      <p>{m.guides_howto_fix_intro()}</p>
      <ul>
        <li>{m.guides_howto_fix_unlike()}</li>
        <li>{m.guides_howto_fix_logo()}</li>
        <li>{m.guides_howto_fix_not_swapped()}</li>
        <li>{m.guides_howto_fix_broken()}</li>
      </ul>

      <h2>{m.guides_howto_timing_heading()}</h2>
      <p>{m.guides_howto_timing_text()}</p>

      <Faq title={m.guides_howto_faq_title()} items={faq()} />
    </GuidePage>
  );
}
