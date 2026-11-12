import { defineModels } from '@shipwords/jobs/models';

// One effect: 1.375–19.063 s of the viral TikTok Tiny Desk clip (skips the opening side view of the singer; 17.688 s, 4 shots). Same price for 1–5 people.
// The whole clip renders in one run: Kling 4.0 edit mode (Edit @video_1) swaps only each filled seat's head/face from the photo;
// original body, clothes, hands and pose stay; empty seats keep the original coaches. Scene and cuts match the original, about $3.06 at 720p, ~8 minutes.
// An earlier full-body replace (animal paws / clothes-from-photo) was dropped in favor of head-only after user feedback.
// Assets live in R2 under assets/tinydesk/: full-17s.mp4 is that span of the viral clip as is (720×1280, 24 fps, with the song),
// used as the reference video, the original for the face check and the base clip.

/** Who sits in each seat of the original, by position and outfit, so the model knows whose head to replace. This order is the @image_1… order. */
const WHO = {
  lead: 'the lead singer in the red cap and black hoodie',
  sax: 'the saxophone player in the navy hoodie',
  keys: 'the keyboard player in the white cap and black pullover',
  backLeft: 'the backing singer standing at the back left in the white pullover',
  backRight: 'the backing singer standing at the back right in the red jacket',
} as const;
type Seat = keyof typeof WHO;

/**
 * The prompt follows the tested run: start with Edit @video_1 (written as Reference it becomes reference-to-video), swap each head/face only,
 * then keep motion, expressions, lip sync, camera, cuts and duration frame by frame. The engine names images @image1; Kling 4.0 wants @image_1 and Yir rejects the wrong name.
 * The stage starts with 5 dogs, so a photo may be a person or a dog and the server cannot tell; the prompt says "person or animal".
 * Head-only: keep the original performer's body, neck-down clothing, hands and arms; do not turn the whole performer into an animal with paws.
 * "No lead singer or new character in the band shots" comes from the tested dog run: without it a second lead appears.
 * A mix of people and dogs in one job is untested.
 */
function editPrompt(images: Readonly<Record<string, string>>) {
  const filled = (Object.keys(WHO) as Seat[]).filter((seat) => images[seat]);
  const swaps = filled.map(
    (seat) =>
      `Completely replace only the head and face of ${WHO[seat]} with the head and face of the person or animal in ${images[seat]!.replace(/^@image(\d+)$/, '@image_$1')}, so none of the original facial features remain visible; keep that performer's original body, neck-down clothing, hands and arms from @video_1.`,
  );
  const others =
    filled.length < Object.keys(WHO).length ? ' Everyone else stays exactly as in @video_1.' : '';
  return [
    'Edit @video_1.',
    ...swaps,
    'The lead singer appears only in the close-up shot; the wide band shots show only the keyboard player and the two backing singers, so do not add the lead singer or any other new character to them.',
    `Each swapped head keeps the original person's head direction, facial expressions, mouth movements and lip-sync timing frame by frame. Keep each performer's original body, pose, gestures, hands and clothes from @video_1; do not change the body into an animal or replace hands with paws.${others}`,
    'Keep everything else unchanged: the room, the shelves, the instruments, the microphones, the camera cuts, the camera movement, the lighting, the timing and the video duration.',
    'Keep the audio exactly identical to the original video. Do not add any new sounds.',
  ].join(' ');
}

const CLIP = 'assets/tinydesk/full-17s.mp4';

export default defineModels([
  {
    id: 'tiny-desk',
    name: 'Tiny Desk video',
    kind: 'video',
    upstream: 'yir',
    upstreamModel: 'klingai/kling-4.0',
    credits: 10,
    guest: false,
    allowedParameters: [],
    maxReferences: 0,
    // Quoted at $3.06 (billed as 18 s), capped at 3.40. A missed swap is not rerun: the job fails with a full refund.
    maxCost: '3.40',
    // Usually about 8 minutes (6 to generate, 2 for the face check and compose), with room for upstream queues.
    timeoutMinutes: 30,
    // Not a clear face-check pass, or compose failed: hold for the owner's review queue (/admin/review) instead of refunding or auto-delivering.
    manualReview: true,
    effect: {
      slots: [
        { id: 'lead', label: 'Lead vocals', required: false },
        { id: 'sax', label: 'Sax', required: false },
        { id: 'keys', label: 'Keys', required: false },
        { id: 'backLeft', label: 'Backing vocals (left)', required: false },
        { id: 'backRight', label: 'Backing vocals (right)', required: false },
      ],
      segments: [
        {
          id: 'full',
          referenceVideo: CLIP,
          slots: ['lead', 'sax', 'keys', 'backLeft', 'backRight'],
          prompt: editPrompt,
          // duration must be a whole number: the 17.688 s reference asks for 18 s, which comes back as 18.04 s with each cut 1–2 frames late; compose re-aligns shot by shot.
          // generate_audio can only be on with Yir; compose swaps the original song back in.
          parameters: { duration: 18, resolution: '720p', aspect_ratio: 'auto' },
          maxCost: '3.40',
          target: 17.688,
          cuts: [5.333, 11.625, 15.0],
          base: CLIP,
          // Original face centers, taken at the start of each one's shot (band 0 s, lead 5.4 s, sax 11.67 s).
          // Threshold 0.55 for head-only: full-body swaps scored ≤0.28; head-only animal faces can leave residual similarity ~0.49; originals still score 0.78–0.94.
          check: {
            original: CLIP,
            faces: {
              keys: [0.395, 0.496, 0],
              backLeft: [0.073, 0.204, 0],
              backRight: [0.859, 0.224, 0],
              lead: [0.793, 0.323, 5.4],
              sax: [0.186, 0.287, 11.67],
            },
            maxSimilarity: 0.55,
          },
        },
      ],
      // Output: the original song from 1.375–19.063 s of the viral clip, 720×1280, 24 fps.
      compose: {
        audio: 'assets/tinydesk/song.m4a',
        audioStart: 1.375,
        audioDuration: 17.688,
        width: 720,
        height: 1280,
        fps: 24,
      },
    },
  },
]);
