#!/usr/bin/env python3
"""
Samples each poster's dominant colours once and stores them in
data/poster-colors.json, so the site already knows a film's backdrop and
label colours when it renders - instead of downloading and sampling the
poster in the browser every time, which finished after the poster had
already appeared and made the hero's label visibly change colour.

Mirrors dominantColors() in assets/app.js: shrink the poster to 32x48,
skip near-black/near-white/greyish pixels, bucket the rest by 4 bits per
channel, then take up to three buckets that aren't near-duplicates of
each other, most common first. Stores the raw colours; the site still
runs them through vivify() itself.

Keyed by TMDB poster path, so a poster that changes (a manual override,
say) gets re-sampled automatically. Only posters not already in the file
are downloaded, so re-runs are quick.

Run by .github/workflows/update-film-data.yml. Needs Pillow.
"""
import io
import json
import math
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
TMDB = ROOT / 'data' / 'tmdb.json'
OUT = ROOT / 'data' / 'poster-colors.json'


def color_distance(a, b):
    return math.sqrt(sum((a[i] - b[i]) ** 2 for i in range(3)))


def dominant_colors(img, size=32, count=3):
    h = round(size * 1.5)
    img = img.convert('RGBA').resize((size, h), Image.BILINEAR)
    buckets = {}
    fallback = [0, 0, 0, 0]
    for r, g, b, a in img.getdata():
        if a < 200:
            continue
        fallback[0] += r; fallback[1] += g; fallback[2] += b; fallback[3] += 1
        mx, mn = max(r, g, b), min(r, g, b)
        lightness = (mx + mn) / 510
        sat = 0 if mx == 0 else (mx - mn) / mx
        if lightness < 0.12 or lightness > 0.88 or sat < 0.18:
            continue
        key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
        bucket = buckets.setdefault(key, [0, 0, 0, 0])
        bucket[0] += r; bucket[1] += g; bucket[2] += b; bucket[3] += 1

    # Stable sort by count, descending - same ordering as the JS version
    # (insertion order for ties).
    ranked = sorted(buckets.values(), key=lambda bk: -bk[3])
    colors = []
    for bk in ranked:
        rgb = [round(bk[i] / bk[3]) for i in range(3)]
        if any(color_distance(p, rgb) < 40 for p in colors):
            continue
        colors.append(rgb)
        if len(colors) == count:
            break
    if not colors and fallback[3]:
        colors.append([round(fallback[i] / fallback[3]) for i in range(3)])
    return colors


def fetch_image(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'avoidtherut-poster-colors'})
    with urllib.request.urlopen(req, timeout=30) as res:
        return Image.open(io.BytesIO(res.read()))


def main():
    tmdb = json.loads(TMDB.read_text())
    image_base = tmdb.get('imageBase', 'https://image.tmdb.org/t/p')
    existing = {}
    if OUT.exists():
        existing = json.loads(OUT.read_text()).get('colors', {})

    wanted = sorted({f['posterPath'] for f in tmdb.get('films', {}).values() if f.get('posterPath')})
    colors = {p: existing[p] for p in wanted if p in existing}
    todo = [p for p in wanted if p not in colors]
    failed = 0
    for path in todo:
        try:
            colors[path] = dominant_colors(fetch_image(f'{image_base}/w185{path}'))
            print(f'sampled {path}: {colors[path]}')
        except Exception as err:  # one bad poster shouldn't sink the rest
            failed += 1
            print(f'could not sample {path}: {err}', file=sys.stderr)

    if not todo and set(existing) == set(colors):
        print('No new posters.')
        return
    OUT.write_text(json.dumps({
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'note': 'Dominant poster colours for the hero backdrop - see scripts/poster-colors.py.',
        'colors': dict(sorted(colors.items())),
    }, indent=2) + '\n')
    print(f'{len(colors)} posters, {len(todo) - failed} newly sampled, {failed} failed.')


if __name__ == '__main__':
    main()
