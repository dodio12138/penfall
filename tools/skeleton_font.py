"""Outline font → single-line glyph library (penfall/glyph-library v1) by skeletonization.

    .venv/bin/python -m pip install -r tools/requirements.txt
    .venv/bin/python tools/skeleton_font.py FONT.ttf OUT.json --id skeleton-kai --name "骨架楷体（单线）" \
        --license-file OFL.txt --copyright "…" [--chars gb2312|level1|TEXT] [--preview sheet.png]

Each character is rendered, thinned to a 1-pixel skeleton, traced into a graph of strokes, cleaned
(short spurs at stroke ends / corners removed, strokes that run straight through a junction joined),
simplified and ordered roughly like handwriting (top → bottom, left → right). The result is an
approximation of the centre line, not the calligrapher's real stroke order.
"""
import argparse
import json
import math
import sys
from multiprocessing import Pool

import numpy as np
from PIL import Image, ImageDraw, ImageFont
from skimage.morphology import remove_small_holes, remove_small_objects, skeletonize

SIZE = 256          # render size of one em (px)
PAD = 24            # margin around the em box (px); strokes may overshoot it
UNITS = 1000        # output units per em
NEIGHBOURS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
PUNCTUATION = '，。、；：？！“”‘’（）《》〈〉【】「」『』—…·～'
# Maths symbols used by the formula engine (web/js/math.js), beyond GB2312.
MATH_EXTRA = '∓∼⇒⊂⊃∂∇△⊙⋯→←↑↓∈∪∩∠⊥∥∵∴°′″≈≡≠≤≥∝∞∑∏∫∮√±×÷·'


def gb2312(level=None):
    """GB2312 characters: level 1 / 2 hanzi, or (level=None) all hanzi plus symbol rows (Greek, maths, full-width)."""
    chars = []
    rows = [*range(0xA1, 0xAA), *range(0xB0, 0xF8)] if level is None else range(0xB0, 0xD8) if level == 1 else range(0xD8, 0xF8)
    for high in rows:
        for low in range(0xA1, 0xFF):
            try:
                char = bytes([high, low]).decode('gb2312')
            except UnicodeDecodeError:
                continue
            if char.strip():
                chars.append(char)
    return chars


def render(font, char, baseline):
    image = Image.new('L', (SIZE + PAD * 2, SIZE + PAD * 2), 0)
    ImageDraw.Draw(image).text((PAD, PAD + baseline), char, font=font, fill=255, anchor='ls')
    ink = np.array(image) > 110
    if ink.sum() < 6:
        return None
    ink = remove_small_holes(ink, 24)
    ink = remove_small_objects(ink, 6)
    return ink


def trace(skeleton):
    """Skeleton pixels → list of polylines (pixel coordinates) between junctions / endpoints."""
    pixels = set(zip(*np.nonzero(skeleton)))
    neighbours = {p: [(p[0] + dy, p[1] + dx) for dy, dx in NEIGHBOURS if (p[0] + dy, p[1] + dx) in pixels] for p in pixels}
    nodes = {p for p, n in neighbours.items() if len(n) != 2}
    # Adjacent junction pixels (a thinned crossing is a small blob) form one junction with one representative.
    representative = {}
    for p in [p for p in nodes if len(neighbours[p]) >= 3]:
        if p in representative:
            continue
        cluster, queue = {p}, [p]
        while queue:
            q = queue.pop()
            for n in neighbours[q]:
                if n not in cluster and n in nodes and len(neighbours[n]) >= 3:
                    cluster.add(n)
                    queue.append(n)
        cy, cx = sum(c[0] for c in cluster) / len(cluster), sum(c[1] for c in cluster) / len(cluster)
        centre = min(cluster, key=lambda c: (c[0] - cy) ** 2 + (c[1] - cx) ** 2)
        for c in cluster:
            representative[c] = centre
    used = set()
    edges = [[p] for p in nodes if not neighbours[p]]  # isolated pixel = a dot (、：。 strokes)

    def key(a, b):
        return (a, b) if a <= b else (b, a)

    for start in nodes:
        for first in neighbours[start]:
            if key(start, first) in used:
                continue
            path, previous, current = [start], start, first
            used.add(key(start, first))
            while True:
                path.append(current)
                if current in nodes:
                    break
                following = [n for n in neighbours[current] if n != previous and key(current, n) not in used]
                if not following:
                    break
                previous, current = current, following[0]
                used.add(key(previous, current))
            a, b = representative.get(path[0], path[0]), representative.get(path[-1], path[-1])
            if a == b and all(p in representative for p in path):
                continue  # edge inside one junction blob
            edges.append([a] + path[1:-1] + [b] if len(path) > 1 else path)
    # Closed loops without any node (e.g. 口 drawn as a ring).
    remaining = {p for p in pixels if p not in nodes and all(key(p, n) not in used for n in neighbours[p])}
    while remaining:
        start = remaining.pop()
        path, previous, current = [start], None, start
        while True:
            following = [n for n in neighbours[current] if n != previous and n in remaining]
            if not following:
                break
            previous, current = current, following[0]
            remaining.discard(current)
            path.append(current)
        path.append(start)
        if len(path) > 3:
            edges.append(path)
    return edges


def length(path):
    return sum(math.dist(a, b) for a, b in zip(path, path[1:]))


def degree(edges):
    count = {}
    for edge in edges:
        for end in (edge[0], edge[-1]):
            count[end] = count.get(end, 0) + 1
    return count


def prune(edges, minimum):
    """Drop short branches that end freely next to a junction (thinning artefacts at corners / stroke ends)."""
    for _ in range(3):
        counts = degree(edges)
        kept = [e for e in edges if not (length(e) < minimum and ((min(counts[e[0]], counts[e[-1]]) == 1 and max(counts[e[0]], counts[e[-1]]) >= 3) or (e[0] == e[-1] and len(e) > 1)))]
        if len(kept) == len(edges):
            break
        edges = merge_through(kept, 180)
    return edges


def contract(edges, minimum):
    """A crossing thins into two nearby junctions joined by a tiny edge: collapse it into one junction."""
    while True:
        counts = degree(edges)
        short = next((i for i, e in enumerate(edges) if length(e) < minimum and e[0] != e[-1] and counts[e[0]] >= 3 and counts[e[-1]] >= 3), None)
        if short is None:
            return edges
        a, b = edges[short][0], edges[short][-1]
        middle = (round((a[0] + b[0]) / 2), round((a[1] + b[1]) / 2))
        rest = []
        for i, edge in enumerate(edges):
            if i == short:
                continue
            edge = list(edge)
            if edge[0] in (a, b):
                edge[0] = middle
            if edge[-1] in (a, b):
                edge[-1] = middle
            rest.append(edge)
        edges = rest


def direction(path, at_start, span=10):
    """Unit vector leaving the path at one end, measured over a few pixels."""
    points = path if at_start else path[::-1]
    a, b = points[0], points[min(len(points) - 1, span)]
    d = (b[0] - a[0], b[1] - a[1])
    n = math.hypot(*d) or 1
    return (d[0] / n, d[1] / n)


def merge_through(edges, max_turn):
    """Join pairs of edges meeting at a node when one continues the other (turn ≤ max_turn degrees)."""
    changed = True
    while changed:
        changed = False
        ends = {}
        for index, edge in enumerate(edges):
            ends.setdefault(edge[0], []).append((index, True))
            ends.setdefault(edge[-1], []).append((index, False))
        for node, items in ends.items():
            if len(items) < 2 or len({i for i, _ in items}) < 2:
                continue
            best = None
            for x in range(len(items)):
                for y in range(x + 1, len(items)):
                    (i, si), (j, sj) = items[x], items[y]
                    if i == j:
                        continue
                    a, b = direction(edges[i], si), direction(edges[j], sj)
                    turn = 180 - math.degrees(math.acos(max(-1, min(1, a[0] * b[0] + a[1] * b[1]))))
                    if (len(items) == 2 or turn <= max_turn) and (best is None or turn < best[0]):
                        best = (turn, i, si, j, sj)
            if best and (len(items) == 2 or best[0] <= max_turn):
                _, i, si, j, sj = best
                first = edges[i][::-1] if si else edges[i]          # ends at node
                second = edges[j] if sj else edges[j][::-1]         # starts at node
                joined = first + second[1:]
                edges = [e for k, e in enumerate(edges) if k not in (i, j)] + [joined]
                changed = True
                break
    return edges


def simplify(points, tolerance):
    """Ramer–Douglas–Peucker (vectorized)."""
    if len(points) < 3:
        return points
    array = np.asarray(points, float)
    keep = np.zeros(len(array), bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(array) - 1)]
    while stack:
        start, end = stack.pop()
        if end - start < 2:
            continue
        a, b = array[start], array[end]
        segment = array[start + 1:end]
        d = b - a
        norm = math.hypot(d[0], d[1])
        distances = np.abs(d[0] * (segment[:, 1] - a[1]) - d[1] * (segment[:, 0] - a[0])) / norm if norm > 1e-9 else np.hypot(*(segment - a).T)
        index = int(np.argmax(distances))
        if distances[index] > tolerance:
            keep[start + 1 + index] = True
            stack += [(start, start + 1 + index), (start + 1 + index, end)]
    return [tuple(p) for p in array[keep]]


def smooth(points, window=2):
    """Moving average that keeps the end points: removes the pixel staircase of the skeleton."""
    if len(points) < 2 * window + 2:
        return points
    array = np.asarray(points, float)
    closed = math.dist(points[0], points[-1]) < 1.5
    result = array.copy()
    for i in range(1, len(array) - 1):
        lo, hi = max(0, i - window), min(len(array), i + window + 1)
        result[i] = array[lo:hi].mean(axis=0)
    if closed:
        result[-1] = result[0]
    return [tuple(p) for p in result]


def orient_and_order(strokes):
    """Write horizontals left→right, verticals / diagonals top→bottom; order strokes top-left first."""
    oriented = []
    for s in strokes:
        (y0, x0), (y1, x1) = s[0], s[-1]
        if abs(x1 - x0) > abs(y1 - y0) * 1.2:
            if x1 < x0:
                s = s[::-1]
        elif y1 < y0 or (abs(y1 - y0) < 2 and x1 < x0):
            s = s[::-1]
        oriented.append(s)
    band = SIZE * .08
    return sorted(oriented, key=lambda s: (round(min(p[0] for p in s) / band), min(p[1] for p in s)))


def convert(font, char, baseline, advance):
    ink = render(font, char, baseline)
    if ink is None:
        return None
    edges = trace(skeletonize(ink))
    edges = merge_through(edges, 180)  # first join plain degree-2 chains
    edges = prune(edges, SIZE * .06)
    edges = contract(edges, SIZE * .05)
    edges = merge_through(edges, 38)   # strokes running straight through a crossing stay one stroke
    strokes = [simplify(smooth(e), .9) for e in edges if length(e) >= 3 or len(e) == 1]
    strokes = orient_and_order([s for s in strokes if s])
    scale = UNITS / SIZE
    out = [[[round((x - PAD) * scale), round((y - PAD) * scale)] for y, x in s] for s in strokes]
    return {'id': 'v1', 'advance': advance, 'strokes': out[:64]} if out else None


_font = _baseline = None


def _init(path):
    global _font, _baseline
    _font = ImageFont.truetype(path, SIZE)
    ascent, descent = _font.getmetrics()
    _baseline = round(SIZE * ascent / (ascent + descent))  # ideographic em box: top at 0, bottom at SIZE


def _work(char):
    advance = round(_font.getlength(char) / SIZE * UNITS) or UNITS
    return char, convert(_font, char, _baseline, advance)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('font')
    parser.add_argument('output')
    parser.add_argument('--id', required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('--description', default='')
    parser.add_argument('--author', default='')
    parser.add_argument('--copyright', default='')
    parser.add_argument('--license-file')
    parser.add_argument('--chars', default='gb2312', help='gb2312 | level1 | literal characters')
    parser.add_argument('--preview', help='write a PNG contact sheet of the first 120 characters')
    args = parser.parse_args()
    chars = gb2312() if args.chars == 'gb2312' else gb2312(1) if args.chars == 'level1' else list(dict.fromkeys(args.chars))
    chars = list(dict.fromkeys(chars + list(PUNCTUATION + MATH_EXTRA + ''.join(chr(code) for code in range(33, 127)))))
    # Only characters the font really has: a missing glyph would be skeletonized from the .notdef box.
    from fontTools.ttLib import TTFont
    cmap = TTFont(args.font, lazy=True).getBestCmap()
    absent = [c for c in chars if ord(c) not in cmap]
    chars = [c for c in chars if ord(c) in cmap]
    if absent:
        print(f'not in font, skipped: {"".join(absent[:80])}', file=sys.stderr)
    glyphs, failed = [], []
    with Pool(initializer=_init, initargs=(args.font,)) as pool:
        for index, (char, variant) in enumerate(pool.imap(_work, chars, chunksize=16)):
            if variant:
                glyphs.append({'char': char, 'variants': [variant]})
            else:
                failed.append(char)
            if index % 500 == 0:
                print(f'{index}/{len(chars)}', file=sys.stderr, flush=True)
    license_text = open(args.license_file, encoding='utf-8').read() if args.license_file else ''
    library = {
        'format': 'penfall/glyph-library', 'version': 1, 'id': args.id, 'name': args.name,
        'author': args.author, 'description': args.description,
        'license': (args.copyright + '\n\n' + license_text).strip()[:200] if not license_text else 'SIL Open Font License 1.1（全文见同目录 LICENSE 文件）。' + args.copyright,
        'unitsPerEm': UNITS, 'glyphs': glyphs,
    }
    with open(args.output, 'w', encoding='utf-8') as handle:
        json.dump(library, handle, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(glyphs)} glyphs, {len(failed)} failed: {"".join(failed[:50])}', file=sys.stderr)
    if args.preview:
        cell, columns = 96, 12
        sample = glyphs[:120]
        sheet = Image.new('RGB', (cell * columns, cell * math.ceil(len(sample) / columns)), 'white')
        draw = ImageDraw.Draw(sheet)
        for i, glyph in enumerate(sample):
            ox, oy = (i % columns) * cell + 8, (i // columns) * cell + 8
            for stroke in glyph['variants'][0]['strokes']:
                points = [(ox + x * (cell - 16) / UNITS, oy + y * (cell - 16) / UNITS) for x, y in stroke]
                draw.line(points if len(points) > 1 else points * 2, fill=(30, 35, 40), width=2, joint='curve')
        sheet.save(args.preview)


if __name__ == '__main__':
    main()
