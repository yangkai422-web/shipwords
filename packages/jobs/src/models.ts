// Sites declare available models in site.models.ts: public ID, upstream model, credit price, whether guests can try it.
// Prices are defined only here; frontend display and server-side charging read the same source.

export interface ModelDefinition {
  /** The site's model ID, used in URLs and requests. */
  id: string;
  name: string;
  kind: 'image' | 'video';
  upstream: 'yir';
  upstreamModel: string;
  /** Credits charged per job; pass a function for parameter-based pricing. */
  credits: number | ((parameters: Record<string, unknown>) => number);
  /** Whether guests can try this model for free (usually only the cheapest one). */
  guest: boolean;
  /** Parameter names users may pass; all others are dropped. */
  allowedParameters: readonly string[];
  defaults?: Readonly<Record<string, unknown>>;
  /** Max reference images; 0 means text-to-image only. */
  maxReferences: number;
  /** Upstream cost cap per job (USD string), so the upstream can't route to an expensive channel. For effects it caps the whole job; the sum of segment maxCost must not exceed it. */
  maxCost?: string;
  /** How long to poll before timing out and refunding. */
  timeoutMinutes: number;
  /** Role of the user's reference image for the upstream; defaults to reference_image for image models, first_frame for video models. */
  referenceRole?: 'reference_image' | 'first_frame';
  /** Effects: prompts and reference videos are preset server-side; users only upload photos per slot. */
  effect?: EffectSpec;
  /**
   * Manual review queue (effects with checks/compose): once the model has rendered, anything but a clear face-check pass (clear fail, grey zone,
   * check unavailable) and any compose failure put the job in needs_review instead of delivering or refunding it. Credits stay spent until an admin
   * approves (deliver) or rejects (refund once). Without it, the older automatic behaviour applies.
   */
  manualReview?: boolean;
}

export interface EffectSlot {
  id: string;
  label: string;
  /** Must be uploaded; if none are required, at least one must be uploaded (otherwise there's nothing to render). */
  required: boolean;
  /** Prep prompt (applies when effect.prep exists): first edits the user's photo into a consistent half-body outfit shot; video segments use the edited image. */
  prep?: string;
}

/** Prep sub-task: one per slot with prep, using the user's photo as reference. */
export interface EffectPrep {
  upstreamModel: string;
  parameters: Readonly<Record<string, unknown>>;
  /** Cost cap per prep run (USD string). */
  maxCost: string;
}

export interface EffectSegment {
  id: string;
  /**
   * Reference video: an R2 key (assets/...) or a full https URL. Pass a function to pick a variant by the filled slots
   * (in this segment's slot order), e.g. a clip with those people's eyes masked so the model can't keep the original faces.
   */
  referenceVideo: string | ((filled: readonly string[]) => string);
  /** Reference audio (assets/*.mp3 or https), retimed like the reference video; passed to the upstream as reference_audio. */
  referenceAudio?: string;
  /** Swappable slots in this shot; filled slots map to @image1, @image2… in this order. */
  slots: readonly string[];
  /** images only contains filled slots; values are how the prompt refers to them (e.g. @image1). */
  prompt: (images: Readonly<Record<string, string>>) => string;
  parameters: Readonly<Record<string, unknown>>;
  /** Upstream cost cap for this segment (USD string), passed to the upstream as max_cost. */
  maxCost: string;
  /** For compose (required when effect.compose exists): seconds this segment occupies in the output. */
  target?: number;
  /** For compose: base clip (R2 key) used when nobody in this segment is swapped, retimed to target. */
  base?: string;
  /**
   * For compose: how the model output goes into the final video. 'stretch' (default) retimes the whole segment to target;
   * 'trim' takes the first target seconds at real speed (for reference videos cut longer than the shot without retiming; better lip sync).
   */
  fit?: 'stretch' | 'trim';
  /**
   * For compose: shot cut times of this segment in the final cut (seconds, increasing, inside (0, target)). Overrides fit:
   * compose finds the scene cuts in the model output, matches each to the nearest one within 0.5 s and retimes every shot to its exact length,
   * for edit models that keep the shots but not the exact timing. A missing cut fails the job with a refund.
   */
  cuts?: readonly number[];
  /**
   * Output check (needs effect.compose): for each filled slot listed in faces, look for the original person's face in the output.
   * If any of them is still there (face similarity ≥ maxSimilarity) the swap didn't take: the whole job fails with a refund, no rerun.
   */
  check?: EffectCheck;
}

export interface EffectCheck {
  /** Unmasked original clip of this shot (assets/*.mp4); the original faces are read from its first frame, or from the frame at a point's t. */
  original: string;
  /**
   * Slot → face center as fractions of width and height, in the original's first frame ([x, y]) or at t seconds ([x, y, t]),
   * for clips where people appear in different shots.
   */
  faces: Readonly<Record<string, FacePoint>>;
  /** Face similarity (cosine, 0–1) at or above which a slot still shows the original person. */
  maxSimilarity: number;
}

export type FacePoint = readonly [number, number] | readonly [number, number, number];

/** Every non-empty subset of a segment's slots, in slot order. */
function slotCombinations(slots: readonly string[]): string[][] {
  const result: string[][] = [];
  for (let mask = 1; mask < 1 << slots.length; mask++) {
    result.push(slots.filter((_, i) => mask & (1 << i)));
  }
  return result;
}

/** The reference video for the filled slots of a segment. */
export function referenceVideoOf(segment: EffectSegment, filled: readonly string[]): string {
  return typeof segment.referenceVideo === 'function'
    ? segment.referenceVideo(filled)
    : segment.referenceVideo;
}

/** Compose config: segments are stitched in order into one video, mixed with the original track, plus a silent version. */
export interface EffectCompose {
  /** Original track (R2 key), cut audioDuration seconds starting at audioStart. */
  audio: string;
  audioStart: number;
  audioDuration: number;
  width: number;
  height: number;
  fps: number;
}

export interface EffectSpec {
  slots: readonly EffectSlot[];
  segments: readonly EffectSegment[];
  compose?: EffectCompose;
  prep?: EffectPrep;
}

/** Role of the user's reference image. */
export function referenceRoleOf(model: ModelDefinition): string {
  return model.referenceRole ?? (model.kind === 'video' ? 'first_frame' : 'reference_image');
}

export function defineModels<const T extends readonly ModelDefinition[]>(models: T): T {
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) throw new Error(`duplicate model id: ${model.id}`);
    ids.add(model.id);
    if (model.effect) validateEffect(model, model.effect);
  }
  return models;
}

function validateEffect(model: ModelDefinition, effect: EffectSpec) {
  const modelId = model.id;
  const slotIds = new Set(effect.slots.map((slot) => slot.id));
  if (slotIds.size !== effect.slots.length) throw new Error(`model ${modelId}: duplicate effect slot`);
  const segmentIds = new Set<string>();
  for (const segment of effect.segments) {
    if (segmentIds.has(segment.id) || !/^[a-z0-9_-]+$/.test(segment.id))
      throw new Error(`model ${modelId}: bad segment id ${segment.id}`);
    segmentIds.add(segment.id);
    // A function is called for every slot combination here, so a bad key fails at startup, not on a paid job.
    for (const filled of slotCombinations(segment.slots)) {
      const video = referenceVideoOf(segment, filled);
      if (
        typeof video !== 'string' ||
        !/^(https:\/\/|assets\/[a-z0-9][a-z0-9/_-]*\.mp4$)/.test(video) ||
        video.includes('..')
      )
        throw new Error(
          `model ${modelId}: segment ${segment.id} referenceVideo must be https or assets/*.mp4`,
        );
    }
    if (
      segment.referenceAudio !== undefined &&
      (!/^(https:\/\/|assets\/[a-z0-9][a-z0-9/_-]*\.mp3$)/.test(segment.referenceAudio) ||
        segment.referenceAudio.includes('..'))
    )
      throw new Error(`model ${modelId}: segment ${segment.id} referenceAudio must be https or assets/*.mp3`);
    for (const slot of segment.slots) {
      if (!slotIds.has(slot))
        throw new Error(`model ${modelId}: segment ${segment.id} uses unknown slot ${slot}`);
    }
  }
  // Whole-job cap: even with every segment rendered it must not exceed the model's maxCost (compared in cents to avoid float error).
  const cents = (value: string) => Math.round(Number(value) * 100);
  if (effect.prep && !(cents(effect.prep.maxCost) > 0))
    throw new Error(`model ${modelId}: prep needs a positive maxCost`);
  const prepCount = effect.prep ? effect.slots.filter((slot) => slot.prep).length : 0;
  // A slow prep may run twice (runner PREP_HEDGE_MS).
  const total =
    effect.segments.reduce((sum, segment) => sum + cents(segment.maxCost), 0) +
    prepCount * 2 * (effect.prep ? cents(effect.prep.maxCost) : 0);
  if (effect.segments.some((segment) => !(cents(segment.maxCost) > 0)))
    throw new Error(`model ${modelId}: every segment needs a positive maxCost`);
  if (model.maxCost === undefined || total > cents(model.maxCost))
    throw new Error(
      `model ${modelId}: segment maxCost sum ${total / 100} exceeds model maxCost ${model.maxCost}`,
    );
  if (effect.compose) {
    const asset = /^assets\/[a-z0-9][a-z0-9/_.-]*$/;
    if (!asset.test(effect.compose.audio) || effect.compose.audio.includes('..'))
      throw new Error(`model ${modelId}: compose.audio must be an assets/ key`);
    for (const segment of effect.segments) {
      if (!(segment.target! > 0) || !segment.base || !asset.test(segment.base) || segment.base.includes('..'))
        throw new Error(
          `model ${modelId}: segment ${segment.id} needs target and an assets/ base for compose`,
        );
      const cuts = segment.cuts;
      if (
        cuts !== undefined &&
        (cuts.length === 0 ||
          !cuts.every(
            (cut, i) => Number.isFinite(cut) && cut > (i === 0 ? 0 : cuts[i - 1]!) && cut < segment.target!,
          ))
      )
        throw new Error(`model ${modelId}: segment ${segment.id} cuts must increase inside (0, target)`);
    }
  } else if (effect.segments.some((segment) => segment.cuts))
    throw new Error(`model ${modelId}: segment cuts need compose`);
  for (const segment of effect.segments) {
    const check = segment.check;
    if (!check) continue;
    if (!effect.compose) throw new Error(`model ${modelId}: segment ${segment.id} check needs compose`);
    if (!/^assets\/[a-z0-9][a-z0-9/_-]*\.mp4$/.test(check.original) || check.original.includes('..'))
      throw new Error(`model ${modelId}: segment ${segment.id} check.original must be assets/*.mp4`);
    const faces = Object.entries(check.faces);
    if (
      faces.length === 0 ||
      faces.some(
        ([slot, point]) =>
          !segment.slots.includes(slot) ||
          (point.length !== 2 && point.length !== 3) ||
          !point.slice(0, 2).every((value) => value >= 0 && value <= 1) ||
          (point.length === 3 && !(point[2]! >= 0 && point[2]! <= 60)),
      )
    )
      throw new Error(
        `model ${modelId}: segment ${segment.id} check.faces must map this segment's slots to 0–1 points (and 0–60 s)`,
      );
    if (!(check.maxSimilarity > 0 && check.maxSimilarity < 1))
      throw new Error(`model ${modelId}: segment ${segment.id} check.maxSimilarity must be between 0 and 1`);
  }
  for (const slot of effect.slots) {
    if (!effect.segments.some((segment) => segment.slots.includes(slot.id)))
      throw new Error(`model ${modelId}: slot ${slot.id} is in no segment`);
  }
}

export function sanitizeParameters(model: ModelDefinition, input: unknown): Record<string, unknown> {
  const result: Record<string, unknown> = { ...model.defaults };
  if (input && typeof input === 'object') {
    for (const key of model.allowedParameters) {
      const value = (input as Record<string, unknown>)[key];
      if (
        value !== undefined &&
        (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      ) {
        result[key] = value;
      }
    }
  }
  return result;
}

export function creditsFor(model: ModelDefinition, parameters: Record<string, unknown>): number {
  const value = typeof model.credits === 'function' ? model.credits(parameters) : model.credits;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`model ${model.id}: invalid credit price ${value}`);
  return value;
}

/** One upstream sub-task. Effect jobs resolve their segments at creation; regular model jobs have a single part. */
export interface JobPart {
  id: string;
  /** image for prep segments; defaults to the model's kind. Prep segments come before video segments and finish first. */
  kind?: 'image' | 'video';
  upstreamModel: string;
  prompt: string;
  references: { url: string; role: string }[];
  parameters: Record<string, unknown>;
  maxCost?: string;
  /** Effect video segments: the filled slots this part swaps, in segment slot order (the output check only looks at these). */
  slots?: string[];
}

/**
 * Effects: resolve the segments to render from the slots the user filled. Prompts and reference videos come from site presets, never user input.
 * uploadUrl validates and converts user upload paths (null if invalid); assetUrl turns an R2 key into a public URL.
 * Returns null for invalid slots (missing required, unknown slot, invalid file) or when no segment needs rendering.
 */
export function effectParts(
  model: ModelDefinition,
  slots: unknown,
  uploadUrl: (ref: unknown) => string | null,
  assetUrl: (key: string) => string,
): JobPart[] | null {
  const effect = model.effect;
  if (!effect || !slots || typeof slots !== 'object' || Array.isArray(slots)) return null;
  const filled = new Map<string, string>();
  for (const [slotId, ref] of Object.entries(slots)) {
    if (!effect.slots.some((slot) => slot.id === slotId)) return null;
    const url = uploadUrl(ref);
    if (!url) return null;
    filled.set(slotId, url);
  }
  if (effect.slots.some((slot) => slot.required && !filled.has(slot.id))) return null;
  const parts: JobPart[] = [];
  // Prep segments: one per filled slot with prep; in video segments that slot's reference image is a placeholder, replaced with the prep result at submit.
  const prepared = new Set<string>();
  const prep = effect.prep;
  if (prep) {
    for (const slot of effect.slots) {
      if (!slot.prep || !filled.has(slot.id)) continue;
      prepared.add(slot.id);
      parts.push({
        id: `prep-${slot.id}`,
        kind: 'image',
        upstreamModel: prep.upstreamModel,
        prompt: slot.prep,
        references: [{ url: filled.get(slot.id)!, role: 'reference_image' }],
        parameters: { ...prep.parameters },
        maxCost: prep.maxCost,
      });
    }
  }
  const imageUrl = (slotId: string) => (prepared.has(slotId) ? `${PREP_REF}${slotId}` : filled.get(slotId)!);
  const mediaUrl = (ref: string) => (/^https:\/\//.test(ref) ? ref : assetUrl(ref));
  let rendered = 0;
  for (const segment of effect.segments) {
    const used = segment.slots.filter((slotId) => filled.has(slotId));
    if (used.length === 0) continue;
    rendered++;
    parts.push({
      id: segment.id,
      upstreamModel: model.upstreamModel,
      prompt: segment.prompt(Object.fromEntries(used.map((slotId, i) => [slotId, `@image${i + 1}`]))),
      references: [
        { url: mediaUrl(referenceVideoOf(segment, used)), role: 'reference_video' },
        ...used.map((slotId) => ({ url: imageUrl(slotId), role: 'reference_image' })),
        ...(segment.referenceAudio
          ? [{ url: mediaUrl(segment.referenceAudio), role: 'reference_audio' }]
          : []),
      ],
      parameters: { ...segment.parameters },
      maxCost: segment.maxCost,
      slots: used,
    });
  }
  return rendered > 0 ? parts : null;
}

/** Placeholder prefix for video segment reference images: `prep:<slot>` is replaced with that slot's prep result URL at submit. */
export const PREP_REF = 'prep:';
