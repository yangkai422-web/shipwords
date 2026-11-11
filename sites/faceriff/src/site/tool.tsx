import { type PublicJob, uploadReference, type useGeneration } from '@shipwords/jobs/react';
import { getRouteApi } from '@tanstack/react-router';
import {
  type DragEvent,
  type FormEvent,
  type PointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { authClient } from '~/lib/auth';
import { identify, track } from '~/lib/track';
import { m } from '~/paraglide/messages.js';
import { openAccount } from '~/site/account';
import { PhoneHandoff } from '~/site/phone-upload';
import { formatPrice, PricingLink } from '~/site/pricing';
import { openSignIn } from '~/site/sign-in';
import site from '../../site.config';
import models from '../../site.models';

// The generator on the home page: a stage image with a round face slot on each of the 5 musicians. Click one to upload a photo.
// The 5 slots start with 5 dogs (the same cast as the hero dog version; every competitor's sample is people, so dogs set us apart): click a dog to swap in your photo,
// × on your photo puts the dog back, × on a dog keeps the original coach. At least 1 photo of your own; same price for 1–5 people. Sign in (Google One Tap), then buy credits; no free trial. Design: DESIGN.md "Upload area".

const MODEL = models[0];
const SLOTS = MODEL.effect?.slots ?? [];
const PRODUCT = site.products.find((p) => p.kind === 'credits' && p.credits === MODEL.credits);
const PRICE = PRODUCT ? formatPrice(PRODUCT) : '';

/**
 * The stage image public/media/stage.jpg is three frames of the viral clip (left: band at 16.8 s, top right: lead at 9.8 s, bottom right: sax at 14.9 s), 1020×960.
 * stage-ours.jpg is the hero output at the same moments (the output starts at 1.375 s of the original, so each minus 1.375) with the same scale and crop; the slot coordinates fit both images.
 * x and y are each face center as a percent of stage width and height; size is the slot diameter as a percent of stage width. Remeasure if the image changes.
 * stage-dogs.jpg is the dog output cut the same way, except the band frame is at 15.1 s (at 15.425 s the golden retriever raises what looks like a human hand); faces sit in the same places.
 * edge: the face touches the stage's left edge, so the name label is left-aligned and not clipped on narrow screens.
 */
const SEATS: Record<
  string,
  { x: number; y: number; size: number; label: () => string; short: () => string; edge?: boolean }
> = {
  backLeft: {
    x: 8.3,
    y: 20.3,
    size: 9,
    label: m.common_slot_back_left,
    short: m.common_seat_back_left,
    edge: true,
  },
  backRight: { x: 47.1, y: 20.3, size: 9, label: m.common_slot_back_right, short: m.common_seat_back_right },
  keys: { x: 20.6, y: 47.4, size: 9, label: m.common_slot_keys, short: m.common_seat_keys },
  lead: { x: 77.5, y: 28.5, size: 18, label: m.common_slot_lead, short: m.common_seat_lead },
  sax: { x: 77, y: 71, size: 13, label: m.common_slot_sax, short: m.common_seat_sax },
};

const PRESETS = [
  { id: 'lead', label: m.common_preset_lead, slots: ['lead'] },
  { id: 'band', label: m.common_preset_band, slots: ['lead', 'sax', 'keys', 'backLeft', 'backRight'] },
  { id: 'back', label: m.common_preset_back, slots: ['backLeft', 'backRight'] },
];

// The default dogs (public/media/dogs/, the 5 from the hero dog version). The stage shows 192px face crops (*-face.jpg), about 40 KB per home page load;
// the order swaps in the same-named half-body photo (768×1024, the model needs the clothes too).
// The server only accepts /files/uploads/ paths from the upload API, and uploads are cleaned up after 2 days, so fixed files cannot be placed there;
// the browser uploads the slots that are still dogs at order time.
// First version: no default dogs (the dog photos only exist after a real dog generation), so the stage starts with the original performers.
// To restore: put lead/sax/keys/back-left/back-right-face.jpg (+ half-body .jpg) in public/media/dogs/ and refill this map.
// Default cast for the Cats hero tab (public/media/cats/). Stage shows 192px face crops (*-face.jpg);
// at order time the browser uploads the matching half-body photo (same name without -face) so the model gets clothes.
// Knicks faces (public/media/knicks/) are display-only examples for the Knicks tab — treated as open presets, not uploaded.
const CATS: Record<string, string> = {
  lead: '/media/cats/lead-face.jpg',
  sax: '/media/cats/sax-face.jpg',
  keys: '/media/cats/keys-face.jpg',
  backLeft: '/media/cats/back-left-face.jpg',
  backRight: '/media/cats/back-right-face.jpg',
};
const KNICKS: Record<string, string> = {
  lead: '/media/knicks/lead-face.jpg',
  sax: '/media/knicks/sax-face.jpg',
  keys: '/media/knicks/keys-face.jpg',
  backLeft: '/media/knicks/back-left-face.jpg',
  backRight: '/media/knicks/back-right-face.jpg',
};
const CAST: Record<'viral' | 'ours' | 'dogs', Record<string, string>> = {
  viral: {},
  ours: KNICKS,
  dogs: CATS,
};
const isCat = (photo: string | undefined) => Boolean(photo?.startsWith('/media/cats/'));
const isKnicks = (photo: string | undefined) => Boolean(photo?.startsWith('/media/knicks/'));
/** Dog-era path kept for any leftover /media/dogs/ assets. */
const isDog = (photo: string | undefined) => Boolean(photo?.startsWith('/media/dogs/'));
const isPreset = (photo: string | undefined) => isCat(photo) || isKnicks(photo) || isDog(photo);
/** A slot without your own photo yet: empty or still a preset face. */
const isOpen = (photo: string | undefined) => !photo || isPreset(photo);
/** Half-body path for a cat face crop (order upload). */
const catPhoto = (face: string) => face.replace(/-face\.jpg$/, '.jpg');

// Photos from the phone fill open slots in this order (highlighted preset slots first); slots that are still dogs count as open.
const FILL_ORDER = ['lead', 'sax', 'keys', 'backLeft', 'backRight'];

// Drag to move: it is a drag only after the pointer moves DRAG_START px, otherwise a click to pick a photo; it drops on a slot only within DROP_REACH radii of its center.
const DRAG_START = 6;
const DROP_REACH = 1.6;
const ACCEPT = ['image/png', 'image/jpeg', 'image/webp'];
const ACCEPT_ATTR = 'image/png,image/jpeg,image/jpg,image/webp,.png,.jpg,.jpeg,.webp';
const HEIC_RE = /\.heic$|\.heif$/i;

function isAcceptedImage(file: File) {
  if (ACCEPT.includes(file.type)) return true;
  // Some browsers (esp. iOS) leave type empty; allow by extension only for PNG/JPG/WebP.
  const name = file.name || '';
  if (HEIC_RE.test(name) || /image\/hei[cf]/i.test(file.type)) return false;
  return /\.(png|jpe?g|webp)$/i.test(name) && (!file.type || file.type === 'application/octet-stream');
}

const root = getRouteApi('__root__');

// Stage photos and the consent are kept in sessionStorage, so the stage survives leaving for checkout or a reload.
const PHOTOS_KEY = 'faceriff:photos';
const CONSENT_KEY = 'faceriff:consent';
const DISMISSED_KEY = 'faceriff:dismissed-jobs';

function store(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function load<T>(key: string): T | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') as T | null;
  } catch {
    return null;
  }
}

function loadDismissed(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown;
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function saveDismissed(ids: string[]) {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(0, 100)));
  } catch {}
}


// The home page's return banner and the generator share one job list, so the home page calls useGeneration and passes it in.
export function TinyDeskTool({
  generation,
  stage = 'viral',
}: {
  generation: ReturnType<typeof useGeneration>;
  /** The stage image follows the hero sample: coaches for the original, the swapped-in faces for our output (stage-ours.jpg), five dogs for the dog version (stage-dogs.jpg); all three share the slot coordinates. */
  stage?: 'viral' | 'ours' | 'dogs';
}) {
  const config = root.useLoaderData();
  const auth = authClient(config.googleClientId);
  const session = auth.useSession();
  const { jobs, generate, submitting, error } = generation;
  const [photos, setPhotos] = useState<Record<string, string>>(CATS);
  const [uploading, setUploading] = useState<string | null>(null);
  // While the dog photos upload before ordering, the button shows "Starting…" so it is not clicked twice.
  const [preparing, setPreparing] = useState(false);
  // Each dog uploads once per page; later orders reuse its path.
  const dogUploads = useRef(new Map<string, string>());
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [highlight, setHighlight] = useState<string[]>([]);
  const [needConsent, setNeedConsent] = useState(false);
  const [resumed, setResumed] = useState(false);
  // Generating again while a job runs needs a confirm: output takes minutes, and a user who thinks nothing happened would spend another video's credits.
  const [confirmAnother, setConfirmAnother] = useState(false);
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    setDismissed(loadDismissed());
  }, []);
  function dismissJob(id: string) {
    setDismissed((current) => {
      if (current.includes(id)) return current;
      const next = [id, ...current].slice(0, 100);
      saveDismissed(next);
      return next;
    });
  }
  const visibleJobs = jobs.filter((job) => !dismissed.includes(job.id));
  const rendering = jobs.some((job) => job.status === 'queued' || job.status === 'submitted');
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const photosRef = useRef(photos);
  photosRef.current = photos;
  const highlightRef = useRef(highlight);
  highlightRef.current = highlight;
  const desk = useRef<HTMLFieldSetElement>(null);
  // Avatar being dragged: from is the start slot, x and y are the pointer's pixel position in the stage, target is where it would drop.
  const [drag, setDrag] = useState<{ from: string; x: number; y: number; target: string | null } | null>(
    null,
  );
  // Shown once after Generate: a video takes minutes, so tell the user they can walk away and get an email.
  const started = useRef<HTMLDialogElement>(null);
  const press = useRef<{ from: string; x: number; y: number } | null>(null);
  const dragged = useRef(false);
  // Slot under the pointer while a file is dragged in from the desktop: dropping uploads the photo here.
  const [fileTarget, setFileTarget] = useState<string | null>(null);

  useEffect(() => {
    const saved = load<Record<string, string>>(PHOTOS_KEY);
    if (saved) setPhotos(saved);
    if (load<boolean>(CONSENT_KEY)) setConsent(true);
    // Back from checkout (RESUME_PATH in pricing.tsx): show a notice, then drop resume from the URL so a reload does not repeat it.
    const url = new URL(window.location.href);
    // ?started opens the "generation started" dialog directly, to check it without placing an order.
    if (url.searchParams.has('started')) showStarted(started.current);
    if (url.searchParams.has('resume')) {
      setResumed(Boolean(saved && Object.keys(saved).length));
      url.searchParams.delete('resume');
      window.history.replaceState(window.history.state, '', url);
    }
  }, []);

  const userId = session.data?.user.id;
  useEffect(() => {
    if (userId) identify(userId);
  }, [userId]);

  // Results: only jobs seen going from running to done/failed on this page; jobs already finished on load are not recorded again.
  const statuses = useRef(new Map<string, PublicJob['status']>());
  useEffect(() => {
    for (const job of jobs) {
      const before = statuses.current.get(job.id);
      statuses.current.set(job.id, job.status);
      if (before !== 'queued' && before !== 'submitted') continue;
      const seconds = job.finishedAt ? Math.round((job.finishedAt - job.createdAt) / 1000) : 0;
      if (job.status === 'succeeded') track('video_ready', { seconds });
      else if (job.status === 'failed' || job.status === 'canceled')
        track('video_failed', { status: job.status });
    }
  }, [jobs]);

  useEffect(() => {
    if (error) track('generate_failed', { code: error.code ?? 'unknown' });
  }, [error]);

  function changePhotos(update: (current: Record<string, string>) => Record<string, string>) {
    setPhotos((current) => {
      const next = update(current);
      store(PHOTOS_KEY, next);
      return next;
    });
  }

  // When the hero tab changes, swap preset faces to that cast (cats / knicks / empty for original).
  // Keep any slot that already holds a user upload (/files/uploads/ or other non-preset path).
  useEffect(() => {
    const cast = CAST[stage];
    changePhotos((current) => {
      const next: Record<string, string> = { ...current };
      for (const slot of SLOTS) {
        const cur = current[slot.id];
        if (cur && !isPreset(cur)) continue; // user upload - keep
        if (cast[slot.id]) next[slot.id] = cast[slot.id]!;
        else delete next[slot.id];
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-sync when the hero stage tab changes
  }, [stage]);

  useEffect(() => {
    if (!rendering) setConfirmAnother(false);
  }, [rendering]);

  const filled = SLOTS.filter((slot) => photos[slot.id]).map((slot) => slot.id);
  const own = filled.filter((id) => !isOpen(photos[id]));

  async function onPick(slotId: string, file: File | undefined, via: 'picker' | 'drop') {
    if (!file) return;
    if (!isAcceptedImage(file)) {
      setUploadError(m.common_tool_file_type());
      return;
    }
    setUploadError(null);
    setUploading(slotId);
    try {
      const path = await uploadReference(file);
      changePhotos((current) => ({ ...current, [slotId]: path }));
      setHighlight((current) => current.filter((id) => id !== slotId));
      track('photo_added', { slot: slotId, via });
    } catch (e) {
      track('photo_upload_failed', { via });
      setUploadError(e instanceof Error ? e.message : m.common_tool_upload_failed());
    } finally {
      setUploading(null);
    }
  }

  function placeFromPhone(paths: string[]): number {
    const current = photosRef.current;
    const order = [...highlightRef.current, ...FILL_ORDER.filter((id) => !highlightRef.current.includes(id))];
    const empty = order.filter((id) => isOpen(current[id]) && SLOTS.some((slot) => slot.id === id));
    const placed = Object.fromEntries(empty.slice(0, paths.length).map((id, i) => [id, paths[i]!]));
    const ids = Object.keys(placed);
    if (!ids.length) return 0;
    photosRef.current = { ...current, ...placed };
    changePhotos((latest) => ({ ...latest, ...placed }));
    setHighlight((list) => list.filter((id) => !ids.includes(id)));
    for (const id of ids) track('photo_added', { slot: id, via: 'phone' });
    return ids.length;
  }

  function seatAt(x: number, y: number, width: number, height: number): string | null {
    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const slot of SLOTS) {
      const seat = SEATS[slot.id]!;
      const distance = Math.hypot(x - (seat.x / 100) * width, y - (seat.y / 100) * height);
      // Face slots have a 2.75rem minimum width (~44px); on narrow screens the radius uses that floor.
      const radius = Math.max((seat.size / 100) * width, 44) / 2;
      if (distance <= radius * DROP_REACH && distance < bestDistance) {
        best = slot.id;
        bestDistance = distance;
      }
    }
    return best;
  }

  function onFaceDown(slotId: string, event: PointerEvent<HTMLLabelElement>) {
    dragged.current = false;
    if (!photos[slotId] || event.button !== 0) return;
    // Keep the browser from starting text selection or native drag, which fires pointercancel and breaks the drag; clicks still pick photos.
    event.preventDefault();
    press.current = { from: slotId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onFaceMove(event: PointerEvent<HTMLLabelElement>) {
    const start = press.current;
    const rect = desk.current?.getBoundingClientRect();
    if (!start || !rect) return;
    if (!dragged.current && Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_START) return;
    dragged.current = true;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setDrag({ from: start.from, x, y, target: seatAt(x, y, rect.width, rect.height) });
  }

  function onFaceUp(event: PointerEvent<HTMLLabelElement>) {
    const from = press.current?.from;
    const rect = desk.current?.getBoundingClientRect();
    // Recompute the target from the release point: when drag and release land in the same frame, drag state has not updated yet.
    const to =
      dragged.current && rect
        ? seatAt(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height)
        : null;
    press.current = null;
    setDrag(null);
    // Dropping on an empty slot moves the photo, on a filled slot swaps the two; dropping back or outside the stage does nothing.
    if (!from || !to || to === from) return;
    changePhotos((current) => {
      const next = { ...current, [to]: current[from]! };
      if (current[to]) next[from] = current[to];
      else delete next[from];
      return next;
    });
    setHighlight((list) => list.filter((id) => id !== to));
  }

  function onFaceCancel() {
    press.current = null;
    setDrag(null);
  }

  function fileSeat(event: DragEvent<HTMLFieldSetElement>): string | null {
    const rect = event.currentTarget.getBoundingClientRect();
    return seatAt(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
  }

  function onFileOver(event: DragEvent<HTMLFieldSetElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    // The whole stage accepts dropped files, so a drop on empty space does not make the browser open the image.
    event.preventDefault();
    const target = uploading ? null : fileSeat(event);
    event.dataTransfer.dropEffect = target ? 'copy' : 'none';
    setFileTarget(target);
  }

  function onFileLeave(event: DragEvent<HTMLFieldSetElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFileTarget(null);
  }

  function onFileDrop(event: DragEvent<HTMLFieldSetElement>) {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setFileTarget(null);
    const target = fileSeat(event);
    if (!target || uploading) return;
    const file = [...event.dataTransfer.files].find((f) => isAcceptedImage(f));
    if (file) void onPick(target, file, 'drop');
    else setUploadError(m.common_tool_file_type());
  }

  function applyPreset(slotIds: string[]) {
    // A preset only hints which slots to fill: highlight them and open the picker for the first open one (still a dog counts as open).
    const empty = slotIds.filter((id) => isOpen(photos[id]));
    setHighlight(empty);
    if (empty[0]) inputs.current.get(empty[0])?.click();
  }

  /** Replaces slots that are still cat presets with upload paths (half-body); knicks/empty presets stay out of the order. Returns null on upload failure. */
  async function uploadDogs(current: Record<string, string>): Promise<Record<string, string> | null> {
    const slots = { ...current };
    for (const [slotId, photo] of Object.entries(current)) {
      if (!isCat(photo) && !isDog(photo)) continue;
      let path = dogUploads.current.get(photo);
      if (!path) {
        try {
          const blob = await (await fetch(catPhoto(photo))).blob();
          path = await uploadReference(new File([blob], `${slotId}.jpg`, { type: 'image/jpeg' }));
        } catch (e) {
          setUploadError(e instanceof Error ? e.message : m.common_tool_upload_failed());
          return null;
        }
        dogUploads.current.set(photo, path);
      }
      slots[slotId] = path;
    }
    return slots;
  }

  async function start() {
    setUploadError(null);
    setPreparing(true);
    const slots = await uploadDogs(photosRef.current);
    setPreparing(false);
    if (!slots) return;
    const job = await generate({ modelId: MODEL.id, slots });
    if (!job) return;
    track('generate_started', { faces: own.length, dogs: filled.length - own.length, another: rendering });
    showStarted(started.current);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    // blocked records which step this click stopped at; none means generation starts.
    const click = (blocked: string) => track('generate_click', { faces: own.length, blocked });
    // The button stays enabled: with no photo of your own (all dogs or all empty) it opens the lead's picker, without consent it asks to tick it, rather than looking disabled.
    if (own.length === 0) {
      click('no_photo');
      applyPreset(['lead']);
      return;
    }
    if (!consent) {
      click('no_consent');
      setNeedConsent(true);
      return;
    }
    // Confirm before sign-in: if the session expires midway, resuming after sign-in must not skip the confirm and spend again.
    if (rendering && !confirmAnother) {
      click('confirm_another');
      setConfirmAnother(true);
      return;
    }
    setConfirmAnother(false);
    if (!session.data) {
      click('sign_in');
      // Sign in with a dialog in place, keeping the photos on the stage; generation continues after sign-in.
      openSignIn(() => void start(), 'generate');
      return;
    }
    click('none');
    await start();
  }

  return (
    <form className="tool" onSubmit={onSubmit}>
      <div className="presets">
        {PRESETS.map((preset) => (
          <button
            type="button"
            key={preset.id}
            className="preset"
            data-rybbit-event="preset_click"
            data-rybbit-prop-preset={preset.id}
            onClick={() => applyPreset(preset.slots)}
          >
            {preset.label()}
          </button>
        ))}
      </div>

      <fieldset
        className={[
          'desk',
          stage === 'ours' && 'desk-ours',
          stage === 'dogs' && 'desk-dogs',
          drag && 'desk-dragging',
        ]
          .filter(Boolean)
          .join(' ')}
        ref={desk}
        onDragOver={onFileOver}
        onDragLeave={onFileLeave}
        onDrop={onFileDrop}
      >
        <legend className="sr-only">{m.common_tool_legend()}</legend>
        {SLOTS.map((slot) => {
          const seat = SEATS[slot.id]!;
          const photo = photos[slot.id];
          const member = seat.label();
          // × on your own photo puts this stage's preset face back; × on a preset clears it (stage background shows through).
          const dogBack = isPreset(photo) ? undefined : CAST[stage][slot.id];
          return (
            <div
              key={slot.id}
              className={`member${seat.edge ? ' member-edge' : ''}${highlight.includes(slot.id) ? ' member-hint' : ''}${drag?.from === slot.id ? ' member-from' : ''}${(drag?.target === slot.id && drag.from !== slot.id) || fileTarget === slot.id ? ' member-target' : ''}`}
              style={{ left: `${seat.x}%`, top: `${seat.y}%`, width: `${seat.size}%` }}
            >
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: onClick only blocks the extra click after a drag; keyboard use goes through the file input inside. */}
              <label
                className={photo ? 'face face-on' : 'face'}
                title={m.common_tool_swap({ member })}
                onPointerDown={(e) => onFaceDown(slot.id, e)}
                onPointerMove={onFaceMove}
                onPointerUp={onFaceUp}
                onPointerCancel={onFaceCancel}
                onClick={(e) => {
                  // After a drag the browser fires one more click; block it so the picker does not open.
                  // Bubbled input clicks (preset buttons, keyboard) are not blocked: touch drags fire no click, so dragged stays until the next press.
                  if (dragged.current && !(e.target instanceof HTMLInputElement)) {
                    e.preventDefault();
                    dragged.current = false;
                  }
                }}
              >
                {photo ? (
                  <img
                    src={photo}
                    alt={m.common_tool_new({ member: member.toLowerCase() })}
                    draggable={false}
                  />
                ) : (
                  <span className="face-add">{uploading === slot.id ? '…' : '+'}</span>
                )}
                <input
                  ref={(el) => {
                    if (el) inputs.current.set(slot.id, el);
                    else inputs.current.delete(slot.id);
                  }}
                  type="file"
                  accept={ACCEPT_ATTR}
                  className="sr-only"
                  disabled={uploading !== null}
                  onChange={(e) => void onPick(slot.id, e.target.files?.[0], 'picker')}
                />
              </label>
              <span className="member-name">{seat.short()}</span>
              {photo && (
                <button
                  type="button"
                  className="face-clear"
                  aria-label={
                    dogBack ? m.common_tool_dog_back() : m.common_tool_keep({ member: member.toLowerCase() })
                  }
                  onClick={() =>
                    changePhotos(({ [slot.id]: _, ...rest }) =>
                      dogBack ? { ...rest, [slot.id]: dogBack } : rest,
                    )
                  }
                >
                  ×
                </button>
              )}
            </div>
          );
        })}
        {drag && photos[drag.from] && (
          <img className="face-ghost" src={photos[drag.from]} alt="" style={{ left: drag.x, top: drag.y }} />
        )}
      </fieldset>

      <p className="desk-status mono">
        {m.common_tool_status({ filled: own.length, total: SLOTS.length, price: PRICE })}
      </p>
      <p className="muted tips">{m.common_tool_tips()}</p>
      <PhoneHandoff place={placeFromPhone} />

      <label className={needConsent && !consent ? 'consent consent-needed' : 'consent'}>
        <input
          type="checkbox"
          checked={consent}
          onChange={(e) => {
            setConsent(e.target.checked);
            store(CONSENT_KEY, e.target.checked);
            setNeedConsent(false);
          }}
        />
        {m.common_tool_consent()}
      </label>

      <div className="hero-actions">
        <button type="submit" className="primary" disabled={submitting || preparing}>
          {submitting || preparing ? (
            m.common_tool_starting()
          ) : (
            <>
              {confirmAnother ? m.common_tool_submit_another() : m.common_tool_submit()}
              <span className="cta-price">{PRICE}</span>
            </>
          )}
        </button>
      </div>
      <p className="tool-hint mono">{m.common_tool_hint()}</p>
      {resumed && !error && jobs.length === 0 && <p className="notice">{m.common_tool_resumed()}</p>}
      {confirmAnother && <p className="notice">{m.common_tool_confirm_another({ price: PRICE })}</p>}
      {uploadError && <p className="error">{uploadError}</p>}
      {error && <GenerationError code={error.code} message={error.message} />}
      {visibleJobs.length > 0 && (
        <div className="results" id="my-videos">
          {visibleJobs.slice(0, SHOWN).map((job) => (
            <JobCard
              key={job.id}
              job={job}
              email={session.data?.user.email}
              onDismiss={
                job.status === 'failed' || job.status === 'canceled' || job.status === 'succeeded'
                  ? () => dismissJob(job.id)
                  : undefined
              }
            />
          ))}
        </div>
      )}
      {visibleJobs.length > SHOWN && (
        <p className="results-more">
          <button type="button" className="link-button" onClick={openAccount}>
            {m.common_tool_see_all({ count: jobs.length })}
          </button>
        </p>
      )}
      <StartedDialog dialog={started} email={session.data?.user.email} />
    </form>
  );
}

// Focus the dialog itself: by default focus lands on "Got it" and the button opens with a focus ring.
function showStarted(dialog: HTMLDialogElement | null) {
  dialog?.showModal();
  dialog?.focus();
}

function StartedDialog({ dialog, email }: { dialog: RefObject<HTMLDialogElement | null>; email?: string }) {
  const close = () => dialog.current?.close();
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: clicking the backdrop is only a mouse shortcut; keyboards close it with the native Esc.
    <dialog
      ref={dialog}
      className="sign-in-dialog started-dialog"
      aria-labelledby="started-title"
      tabIndex={-1}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <svg className="started-cup" viewBox="0 0 48 48" aria-hidden="true">
        <path className="steam" d="M17 5c-2 3 2 5 0 8" />
        <path className="steam" d="M23 3c-2 3 2 5 0 8" />
        <path className="steam" d="M29 5c-2 3 2 5 0 8" />
        <path d="M10 19h26v10a10 10 0 0 1-10 10h-6a10 10 0 0 1-10-10z" />
        <path d="M36 22h2a5 5 0 0 1 0 10h-2.5" />
        <path d="M7 44h32" />
      </svg>
      <h2 id="started-title">{m.common_started_title()}</h2>
      <p>{m.common_started_body()}</p>
      <p>{email ? m.common_started_email({ email }) : m.common_started_email_generic()}</p>
      <p className="muted started-return">{m.common_started_return()}</p>
      <button type="button" className="primary" onClick={close}>
        {m.common_started_ok()}
      </button>
    </dialog>
  );
}

// The home page shows at most 3 result cards; the rest are under "My videos" in the account dialog.
const SHOWN = 3;
const RECENT_MS = 24 * 3600_000;

/** Return banner above the fold: when a video is generating or finished within a day, a click jumps to the results below the generator. */
export function ReturnNotice({ jobs }: { jobs: PublicJob[] }) {
  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    setDismissed(loadDismissed());
  }, [jobs]);
  const visible = jobs.filter((job) => !dismissed.includes(job.id));
  const rendering = visible.some((job) => job.status === 'queued' || job.status === 'submitted');
  const latest = visible[0];
  const ready =
    latest?.status === 'succeeded' &&
    latest.finishedAt !== null &&
    Date.now() - latest.finishedAt < RECENT_MS;
  if (!rendering && !ready) return null;
  return (
    <a
      className="notice return-notice"
      href="#my-videos"
      data-rybbit-event="return_notice_click"
      data-rybbit-prop-state={rendering ? 'rendering' : 'ready'}
    >
      {rendering ? m.common_return_rendering() : m.common_return_ready()}
    </a>
  );
}

function GenerationError({ code, message }: { code: string | undefined; message: string }) {
  if (code === 'login_required') {
    return (
      <p className="notice">
        <button type="button" className="link-button" onClick={() => openSignIn(undefined, 'login_required')}>
          {m.common_tool_sign_in()}
        </button>{' '}
        {m.common_tool_sign_in_after()}
      </p>
    );
  }
  if (code === 'insufficient_credits') {
    return (
      <p className="notice">
        {m.common_tool_need_credits()}{' '}
        <PricingLink source="insufficient_credits">{m.common_tool_get_pack()}</PricingLink>
        {m.common_tool_need_credits_after()}
      </p>
    );
  }
  return <p className="error">{message}</p>;
}

// Output order: with original audio, then silent (composeOutputs in packages/jobs).
const DOWNLOADS = [m.common_job_download_song, m.common_job_download_silent];
// Download file names: the R2 keys are 0.mp4 / 1.mp4, which are indistinguishable once saved to a phone.
const VERSIONS = ['song', 'silent'];

const STAGES = [
  { after: 0, text: m.common_job_stage_setup },
  { after: 120, text: m.common_job_stage_swap },
  { after: 360, text: m.common_job_stage_mix },
];
// Only say it is slower than usual one minute past the 10-minute estimate.
const OVERTIME_AFTER = 660;
/** Expected total render time in seconds. Tune from the runner's timing logs. */
const EXPECTED_SECONDS = 420;

/** Estimated percent: linear to 90% at EXPECTED_SECONDS, then eases toward 95% and holds. */
function estimatedProgress(elapsed: number) {
  if (elapsed < EXPECTED_SECONDS) return (90 * elapsed) / EXPECTED_SECONDS;
  return 95 - 5 * Math.exp(-(elapsed - EXPECTED_SECONDS) / 120);
}

function formatElapsed(seconds: number) {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function JobCard({
  job,
  email,
  onDismiss,
}: {
  job: PublicJob;
  email?: string;
  onDismiss?: () => void;
}) {
  const active = job.status === 'queued' || job.status === 'submitted';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  const elapsed = Math.max(0, (now - job.createdAt) / 1000);
  const stage = STAGES.filter((s) => elapsed >= s.after).at(-1)!;
  const overtime = elapsed >= OVERTIME_AFTER;
    const percent = Math.round(estimatedProgress(elapsed));
  const minutesLeft = Math.max(1, Math.ceil((EXPECTED_SECONDS - elapsed) / 60));
  const remaining =
    elapsed < EXPECTED_SECONDS ? m.common_job_left({ minutes: String(minutesLeft) }) : m.common_job_almost();

  return (
    <article className={`job${job.outputs[0] ? ' job-done' : ''}${job.status === 'failed' && !job.outputs[0] ? ' job-failed' : ''}`}>
      {onDismiss && (
        <button
          type="button"
          className="job-dismiss"
          onClick={onDismiss}
          aria-label={m.common_job_dismiss_aria()}
          title={m.common_job_dismiss()}
        >
          ×
        </button>
      )}
      {active && (
        <div className="job-pending">
          <p>
            <span className="rec-dot" aria-hidden="true" />
            {stage.text()}
          </p>
          {/* Elapsed time comes from the client clock, so it always differs from the server-rendered value */}
            <div
            className="job-progress"
            role="progressbar"
            aria-label={m.common_job_progress_aria()}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={`${percent}% · ${remaining}`}
            suppressHydrationWarning
          >
            <span className="job-progress-bar" style={{ width: `${percent}%` }} suppressHydrationWarning />
          </div>
          <p className="mono" suppressHydrationWarning>
            {formatElapsed(elapsed)} · {percent}% · {remaining}
          </p>
          {overtime && <p className="muted">{m.common_job_overtime()}</p>}
          <p className="muted">{email ? m.common_job_email({ email }) : m.common_job_email_generic()}</p>
        </div>
      )}
      {job.outputs[0] && (
        <>
          {/* biome-ignore lint/a11y/useMediaCaption: generated videos have no caption track. */}
          <video src={job.outputs[0].url} controls playsInline />
          <div className="job-body">
          <div className="job-downloads">
            {job.outputs.map((output, i) => (
              <a
                key={output.url}
                className="button"
                href={output.url}
                download={`tiny-desk-ai-${job.id.slice(-6)}-${VERSIONS[i] ?? i}.mp4`}
                data-rybbit-event="video_download"
                data-rybbit-prop-version={VERSIONS[i] ?? i}
              >
                {(DOWNLOADS[i] ?? m.common_job_download)()}
              </a>
            ))}
          </div>
          {job.outputs.length > 1 && <p className="muted job-tip">{m.common_job_silent_tip()}</p>}
          </div>
        </>
      )}
      {job.status === 'succeeded' && job.error?.code === 'quality_review' && (
        <p className="notice">
          Your video is ready, but some faces may need checking. Please preview it and contact support if the swap is not right.
        </p>
      )}
      {job.status === 'failed' && <p className="error job-failed-text">{m.common_job_failed()}</p>}
      {job.status === 'canceled' && <p className="muted">{m.common_job_canceled()}</p>}
    </article>
  );
}
