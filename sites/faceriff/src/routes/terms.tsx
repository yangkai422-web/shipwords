import { pageHead } from '@shipwords/core/seo';
import { createFileRoute, Link } from '@tanstack/react-router';
import { m } from '~/paraglide/messages.js';
import { LegalPage } from '~/site/legal';
import site from '../../site.config';

export const Route = createFileRoute('/terms')({
  head: () =>
    pageHead(site, {
      title: m.legal_terms_meta_title({ siteName: site.name }),
      description: m.legal_terms_meta_description({ siteName: site.name }),
      path: '/terms',
    }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <LegalPage title={m.legal_terms_title()} intro={m.legal_terms_intro({ siteName: site.name })}>
      <h2>{m.legal_terms_service_heading()}</h2>
      <p>{m.legal_terms_service_body({ siteName: site.name })}</p>

      <h2>{m.legal_terms_photos_heading()}</h2>
      <ul>
        <li>{m.legal_terms_photos_public_figures()}</li>
        <li>{m.legal_terms_photos_no_minors()}</li>
        <li>{m.legal_terms_photos_rights()}</li>
      </ul>

      <h2>{m.legal_terms_usage_heading()}</h2>
      <ul>
        <li>{m.legal_terms_usage_personal()}</li>
        <li>{m.legal_terms_usage_restrictions()}</li>
        <li>{m.legal_terms_usage_platforms()}</li>
      </ul>

      <h2>{m.legal_terms_credits_heading()}</h2>
      <p>
        {m.legal_terms_credits_body_before()} <Link to="/refunds">{m.legal_terms_credits_refund_link()}</Link>
        {m.legal_terms_credits_body_after()}
      </p>

      <h2>{m.legal_terms_ai_heading()}</h2>
      <p>{m.legal_terms_ai_body()}</p>

      <h2>{m.legal_terms_refusal_heading()}</h2>
      <p>
        {m.legal_terms_refusal_body_before()} <Link to="/dmca">{m.legal_terms_refusal_dmca_link()}</Link>
        {m.legal_terms_refusal_body_after()}
      </p>

      <h2>{m.legal_terms_warranty_heading()}</h2>
      <p>{m.legal_terms_warranty_body()}</p>

      <h2>{m.legal_terms_changes_heading()}</h2>
      <p>{m.legal_terms_changes_body()}</p>
    </LegalPage>
  );
}
