import { pageHead } from '@shipwords/core/seo';
import { createFileRoute } from '@tanstack/react-router';
import { m } from '~/paraglide/messages.js';
import { LegalPage, SUPPORT_EMAIL } from '~/site/legal';
import site from '../../site.config';

export const Route = createFileRoute('/dmca')({
  head: () =>
    pageHead(site, {
      title: m.legal_dmca_meta_title({ siteName: site.name }),
      description: m.legal_dmca_meta_description({ siteName: site.name }),
      path: '/dmca',
    }),
  component: DmcaPage,
});

function DmcaPage() {
  return (
    <LegalPage title={m.legal_dmca_title()} intro={m.legal_dmca_intro({ siteName: site.name })}>
      <h2>{m.legal_dmca_notice_heading()}</h2>
      <p>
        {m.legal_dmca_notice_body_before()} <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>{' '}
        {m.legal_dmca_notice_body_after()}
      </p>
      <ul>
        <li>{m.legal_dmca_notice_work({ siteName: site.name })}</li>
        <li>{m.legal_dmca_notice_contact()}</li>
        <li>{m.legal_dmca_notice_good_faith()}</li>
        <li>{m.legal_dmca_notice_perjury()}</li>
        <li>{m.legal_dmca_notice_signature()}</li>
      </ul>
      <p>{m.legal_dmca_notice_response()}</p>

      <h2>{m.legal_dmca_likeness_heading()}</h2>
      <p>{m.legal_dmca_likeness_body()}</p>

      <h2>{m.legal_dmca_counter_heading()}</h2>
      <p>{m.legal_dmca_counter_body()}</p>

      <h2>{m.legal_dmca_repeat_heading()}</h2>
      <p>{m.legal_dmca_repeat_body()}</p>
    </LegalPage>
  );
}
