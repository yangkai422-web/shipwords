import { pageHead } from '@shipwords/core/seo';
import { createFileRoute, Link } from '@tanstack/react-router';
import { m } from '~/paraglide/messages.js';
import { templateFaqJsonLd, TinyDeskTemplateGuide } from '~/site/template-guide';
import site from '../../site.config';

// Shorter "find a template" landing for queries like "tiny desk template",
// "tiny desk outstanding" and "charlie wilson tiny desk ai".
// Does not replace /outstanding-tiny-desk-ai-template; each URL has its own canonical.

const PATH = '/tiny-desk-template';

export const Route = createFileRoute('/tiny-desk-template')({
  head: () =>
    pageHead(site, {
      title: m.guides_template_find_meta_title(),
      description: m.guides_template_find_meta_description(),
      path: PATH,
      jsonLd: [templateFaqJsonLd()],
    }),
  component: TinyDeskTemplatePage,
});

function TinyDeskTemplatePage() {
  return (
    <TinyDeskTemplateGuide
      path={PATH}
      title={m.guides_template_find_title()}
      updated={m.guides_template_find_updated()}
      intro={<p>{m.guides_template_find_intro()}</p>}
      crossLink={
        <p>
          {m.guides_template_find_cross_before()}
          <Link to="/outstanding-tiny-desk-ai-template">{m.guides_template_find_cross_link()}</Link>
          {m.guides_template_find_cross_after()}
        </p>
      }
    />
  );
}
