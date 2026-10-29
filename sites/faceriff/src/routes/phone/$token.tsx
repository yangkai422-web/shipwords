import { pageHead } from '@shipwords/core/seo';
import { createFileRoute } from '@tanstack/react-router';
import { m } from '~/paraglide/messages.js';
import { PhoneUploadPage } from '~/site/phone-upload';
import site from '../../../site.config';

// Phone upload page opened by scanning the QR code on the desktop stage; see site/phone-upload.tsx.
export const Route = createFileRoute('/phone/$token')({
  head: ({ params }) =>
    pageHead(site, {
      title: m.common_phone_meta_title({ name: site.name }),
      description: m.common_phone_body(),
      path: `/phone/${params.token}`,
      noindex: true,
    }),
  component: PhoneRoute,
});

function PhoneRoute() {
  return <PhoneUploadPage token={Route.useParams().token} />;
}
