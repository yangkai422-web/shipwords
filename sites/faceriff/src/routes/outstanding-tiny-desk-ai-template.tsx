import { pageHead } from '@shipwords/core/seo';
import { createFileRoute, Link } from '@tanstack/react-router';
import { m } from '~/paraglide/messages.js';
import { templateFaqJsonLd, TinyDeskTemplateGuide } from '~/site/template-guide';
import site from '../../site.config';

// Template page: targets searches like "outstanding tiny desk ai template" and "capcut".
// Body is shared with /tiny-desk-template; this URL keeps its own canonical and title.

const PATH = '/outstanding-tiny-desk-ai-template';

export const Route = createFileRoute('/outstanding-tiny-desk-ai-template')({
  head: () =>
    pageHead(site, {
      title: m.guides_template_meta_title(),
      description: m.guides_template_meta_description(),
      path: PATH,
      jsonLd: [templateFaqJsonLd()],
    }),
  component: TemplatePage,
});

function TemplatePage() {
  return (
    <TinyDeskTemplateGuide
      path={PATH}
      title={m.guides_template_title()}
      updated={m.guides_template_updated()}
      intro={<p>{m.guides_template_intro()}</p>}
      crossLink={
        <p>
          {m.guides_template_long_cross_before()}
          <Link to="/tiny-desk-template">{m.guides_template_long_cross_link()}</Link>
          {m.guides_template_long_cross_after()}
        </p>
      }
    />
  );
}
