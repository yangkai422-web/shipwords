"""Version 2: sequential sampling, per-role spatial matching, conservative verdicts."""
import json
import math
import os
import sys

import cv2

MODELS = os.environ.get('FACE_MODELS', '/app/models')
SAMPLES = 16
SAMPLES_PER_SECOND = 2
WEAK = 0.55
STRONG = 0.80
MIN_VALID = 4
MIN_COVERAGE = 0.60
MAX_DISTANCE = 0.20

detector = cv2.FaceDetectorYN.create(f'{MODELS}/yunet.onnx', '', (320, 320), 0.6)
recognizer = cv2.FaceRecognizerSF.create(f'{MODELS}/sface.onnx', '')


def faces(image):
    height, width = image.shape[:2]
    detector.setInputSize((width, height))
    _, found = detector.detect(image)
    result = []
    for face in found if found is not None else []:
        if face[2] * face[3] < 0.003 * width * height:
            continue
        feature = recognizer.feature(recognizer.alignCrop(image, face))
        result.append(((face[0] + face[2] / 2) / width,
                       (face[1] + face[3] / 2) / height, feature))
    return result


def similarity(a, b):
    return min(1.0, max(0.0, float(recognizer.match(a, b, cv2.FaceRecognizerSF_FR_COSINE))))


def video_info(path):
    cap = cv2.VideoCapture(path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    if not math.isfinite(fps) or fps <= 0 or total <= 0:
        raise ValueError('video has no usable FPS/frame count')
    return fps, total


def frames(path, times):
    """Decode once. Never seek. Record actual timestamp and reject duplicates."""
    fps, total = video_info(path)
    wanted = {min(total - 1, max(0, round(t * fps))): float(t) for t in times}
    cap = cv2.VideoCapture(path)
    result = []
    seen = set()
    try:
        for index in range(max(wanted, default=-1) + 1):
            ok, image = cap.read()
            if not ok:
                break
            if index not in wanted:
                continue
            actual = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000
            if not math.isfinite(actual) or abs(actual - index / fps) > 1 / fps:
                continue
            stamp = round(actual, 6)
            if stamp in seen:
                continue
            seen.add(stamp)
            result.append({'index': index, 'requested': wanted[index],
                           'actual': actual, 'image': image})
    finally:
        cap.release()
    return result


def longest_run(rows, threshold):
    best = run = 0
    for row in rows:
        if row['score'] is not None and row['score'] >= threshold:
            run += 1
            best = max(best, run)
        else:
            run = 0
    return best


def role_verdict(visible, rows, anchor_found):
    values = [row['score'] for row in rows if row['score'] is not None]
    valid = len(values)
    strong = sum(value >= STRONG for value in values)
    weak = sum(value >= WEAK for value in values)
    run = longest_run(rows, STRONG)
    fraction = strong / valid if valid else 0.0
    peak = max(values, default=0.0)
    # Insufficient evidence is review, never automatic failure.
    if not anchor_found or visible < MIN_VALID or valid < MIN_VALID or valid / visible < MIN_COVERAGE:
        verdict = 'review'
    elif strong >= 3 and (fraction >= 0.50 or run >= 4):
        verdict = 'fail'
    elif weak >= 2 or peak >= 0.75:
        verdict = 'review'
    else:
        verdict = 'pass'
    return {'verdict': verdict, 'visible': visible, 'valid': valid,
            'peak': round(peak, 3), 'strong': strong,
            'strongFraction': round(fraction, 3), 'longestStrongRun': run,
            'weak': weak, 'rows': rows}


def inspect(output, original, seconds, points):
    if not math.isfinite(seconds) or not 0 < seconds <= 60:
        raise ValueError('bad seconds')
    count = max(SAMPLES, round(seconds * SAMPLES_PER_SECOND))
    sampled = frames(output, [seconds * (i + 0.5) / count for i in range(count)])
    fps, total = video_info(original)
    duration = total / fps
    anchors = frames(original, [float(p[2]) if len(p) > 2 else 0.0 for p in points])
    anchor_faces = {row['index']: faces(row['image']) for row in anchors}
    targets = []
    for point in points:
        x, y = float(point[0]), float(point[1])
        t = float(point[2]) if len(point) > 2 else 0.0
        found = anchor_faces.get(min(total - 1, max(0, round(t * fps))), [])
        nearest = min(found, key=lambda f: (f[0] - x) ** 2 + (f[1] - y) ** 2, default=None)
        targets.append(nearest[2] if nearest and (nearest[0] - x) ** 2 + (nearest[1] - y) ** 2 < 0.15 ** 2 else None)
    # Scale template timing to output timing; ambiguous cut/position matches go to review.
    base = frames(original, [row['actual'] / seconds * duration for row in sampled])
    base_faces = {row['index']: faces(row['image']) for row in base}
    output_faces = [faces(row['image']) for row in sampled]
    roles = []
    for index, target in enumerate(targets):
        rows = []
        visible = 0
        for sample, detected in zip(sampled, output_faces):
            row = {'time': round(sample['actual'], 6), 'score': None}
            template_index = min(total - 1, max(0, round(sample['actual'] / seconds * duration * fps)))
            refs = base_faces.get(template_index, [])
            if target is not None and refs:
                ref = max(refs, key=lambda f: similarity(target, f[2]))
                # Find this role in the unmodified template, not arbitrary output faces.
                if similarity(target, ref[2]) >= 0.50:
                    visible += 1
                    candidate = min(detected, key=lambda f: (f[0] - ref[0]) ** 2 + (f[1] - ref[1]) ** 2, default=None)
                    if candidate and (candidate[0] - ref[0]) ** 2 + (candidate[1] - ref[1]) ** 2 <= MAX_DISTANCE ** 2:
                        row['score'] = round(similarity(target, candidate[2]), 6)
                        row['x'], row['y'] = round(float(candidate[0]), 4), round(float(candidate[1]), 4)
            rows.append(row)
        roles.append({'index': index, **role_verdict(visible, rows, target is not None)})
    decisions = [role['verdict'] for role in roles]
    verdict = 'fail' if 'fail' in decisions else 'review' if 'review' in decisions else 'pass'
    if len(sampled) < math.ceil(count * 0.90):
        verdict = 'review'
    return {'version': 2, 'verdict': verdict, 'similarity': [r['peak'] for r in roles],
            'roles': roles, 'sampleCount': len(sampled), 'requestedSamples': count,
            'timestamps': [{'requested': round(r['requested'], 6), 'actual': round(r['actual'], 6)} for r in sampled]}


def main():
    output, original, seconds, points = sys.argv[1], sys.argv[2], float(sys.argv[3]), json.loads(sys.argv[4])
    print(json.dumps(inspect(output, original, seconds, points), allow_nan=False))


if __name__ == '__main__':
    main()
