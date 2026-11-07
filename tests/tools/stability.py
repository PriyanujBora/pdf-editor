"""Scores tests/edit-stability.mjs runs. Usage: stability.py dir/spec.json [...]
Prints pass rates per check and file, and "RESULT PASS|FAIL": generated fixtures must pass
everything, corpus files at least 95 % of lines per check."""
import ctypes
import json
import os
import sys

import numpy as np
import pypdf
import pypdfium2 as pdfium
import pypdfium2.raw as raw
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")
S = 3  # render scale, px per pt


def png(p):
    return np.asarray(Image.open(p).convert('RGB')).astype(np.int16)


def render(path):
    return np.asarray(pdfium.PdfDocument(path)[0].render(scale=S).to_pil().convert('RGB')).astype(np.int16)


def chars(path):
    """All chars of page 1: (char, origin x, origin y (page space, y down), font name, tight height)."""
    pdf = pdfium.PdfDocument(path)
    pg = pdf[0]
    h = pg.get_size()[1]
    tp = pg.get_textpage()
    x, y = ctypes.c_double(), ctypes.c_double()
    buf = ctypes.create_string_buffer(256)
    flags = ctypes.c_int()
    out = []
    for i in range(tp.count_chars()):
        c = tp.get_text_range(i, 1)
        raw.FPDFText_GetCharOrigin(tp.raw, i, ctypes.byref(x), ctypes.byref(y))
        n = raw.FPDFText_GetFontInfo(tp.raw, i, buf, 256, ctypes.byref(flags))
        name = buf.raw[: max(0, n - 1)].decode('latin-1')
        l, b, r, t = tp.get_charbox(i, loose=False)
        out.append((c, x.value, h - y.value, name, t - b))
    return out


def on_line(cs, baseline, tol):
    return [c for c in cs if c[0].strip() and abs(c[2] - baseline) < tol]


def diff_count(a, b, x0, x1, y0, y1):
    ya, yb = max(0, int(y0 * S)), int(y1 * S) + 1
    xa, xb = max(0, int(x0 * S)), int(x1 * S) + 1
    return int((np.abs(a[ya:yb, xa:xb] - b[ya:yb, xa:xb]).max(axis=2) > 24).sum())


def score(spec_path):
    spec = json.load(open(spec_path, encoding='utf-8'))
    d = spec['dir']
    res = {k: [0, 0] for k in ('1 no-op', '2 editing', '3 same-length', '4 missing glyph', '5 size')}
    fails = {k: [] for k in res}

    def mark(k, ok, i, why=''):
        res[k][1] += 1
        res[k][0] += ok
        if not ok:
            fails[k].append(f'line {i}: {why} {spec["lines"][i]["text"][:50]!r}')

    for e in spec['editor']:
        i = e['i']
        if 'error' in e:
            mark('1 no-op', False, i, e['error'])
            mark('2 editing', False, i, e['error'])
            continue
        a, b, c = png(f'{d}/{i}-a.png'), png(f'{d}/{i}-b.png'), png(f'{d}/{i}-c.png')
        same = a.shape == c.shape and int((np.abs(a - c).max(axis=2) > 0).sum()) == 0
        mark('1 no-op', same and e['els'] == 0 and e['undo'] == 0, i, f'els={e["els"]} undo={e["undo"]} same={same}')
        if a.shape != b.shape:
            mark('2 editing', False, i, 'shape')
            continue
        cols = np.nonzero((np.abs(a - b).max(axis=2) > 32).any(axis=0))[0]
        caret_only = len(cols) == 0 or (cols.max() - cols.min() <= 4)
        mark('2 editing', caret_only, i, f'{len(cols)} columns differ')

    orig = render(spec['file'])
    oc = chars(spec['file'])
    n_orig = len(oc)
    if os.path.exists(f'{d}/c3.pdf'):
        e3 = render(f'{d}/c3.pdf')
        ec = chars(f'{d}/c3.pdf')
        for t in spec['c3']:
            i = t['i']
            if 'error' in t:
                mark('3 same-length', False, i, t['error'])
                continue
            bx, w = t['box'], t['word']
            # This line's own ink band (ascenders ~0.76 em, descenders ~0.23 em): in tight paragraphs the
            # font box overlaps the neighbours, whose own edits must not count against this line.
            em = 0.8 * bx['height']
            y0, y1 = max(bx['y'] - 0.5, t['baseline'] - 0.8 * em), min(bx['y'] + bx['height'] + 0.5, t['baseline'] + 0.25 * em)
            left = diff_count(orig, e3, bx['x'] - 1, w['x0'] - 1, y0, y1)
            right = diff_count(orig, e3, w['x1'] + 1, bx['x'] + bx['width'] + 1, y0, y1)
            mark('3 same-length', left == 0 and right == 0, i, f'{left}+{right} px changed outside the word')
            tol = 0.3 * bx['height']
            new = [c for c in on_line(ec[n_orig:], t['baseline'], tol) if w['x0'] - 0.6 <= c[1] <= w['x1'] + 0.6]
            new = new[-len([c for c in on_line(oc, t['baseline'], tol) if w['x0'] - 0.6 <= c[1] <= w['x1'] + 0.6]):] if new else new
            old = [c for c in on_line(oc, t['baseline'], tol) if w['x0'] - 0.6 <= c[1] <= w['x1'] + 0.6]
            hs = [n[4] / o[4] for o, n in zip(sorted(old, key=lambda c: c[0]), sorted(new, key=lambda c: c[0])) if o[0] == n[0] and o[4] > 0.5 and o[3] and n[3]]
            if hs:
                mark('5 size', 0.98 <= float(np.median(hs)) <= 1.02, i, f'height ratio {np.median(hs)}')
    if os.path.exists(f'{d}/c4.pdf'):
        e4 = render(f'{d}/c4.pdf')
        ec = chars(f'{d}/c4.pdf')
        for t in spec['c4']:
            i = t['i']
            if 'error' in t:
                mark('4 missing glyph', False, i, t['error'])
                continue
            bx = t['box']
            # This line's own ink band (ascenders ~0.76 em, descenders ~0.23 em): in tight paragraphs the
            # font box overlaps the neighbours, whose own edits must not count against this line.
            em = 0.8 * bx['height']
            y0, y1 = max(bx['y'] - 0.5, t['baseline'] - 0.8 * em), min(bx['y'] + bx['height'] + 0.5, t['baseline'] + 0.25 * em)
            left = diff_count(orig, e4, bx['x'] - 1, t['insertX'] - 1.5, y0, y1)
            tol = 0.3 * bx['height']
            right = bx['x'] + bx['width']
            old = [c for c in on_line(oc, t['baseline'], tol) if t['insertX'] - 0.05 <= c[1] <= right]
            moved = [c for c in on_line(ec[n_orig:], t['baseline'], tol) if c[0] != '₹' and t['insertX'] - 0.05 <= c[1] <= right + 20]
            if False:
                # Justified: later words move back towards their place (right edge kept), so offsets
                # shrink along the line; check font, no vertical drift, and that nothing jumps.
                pairs = list(zip(old, moved))
                fonts = all(o[3] == m[3] for o, m in pairs)
                dxs = [m[1] - o[1] for o, m in pairs]
                ok = fonts and max(abs(m[2] - o[2]) for o, m in pairs) <= 0.25 and min(dxs) >= -0.25
                mark('4 missing glyph', ok, i, f'justified: same fonts {fonts} dx {min(dxs):.2f}..{max(dxs):.2f}')
                continue
            # Pair each moved glyph with the printed one of the same character at the typical offset
            # (ligatures can extract as one or two characters, so counts may differ by a little).
            pairs = []
            old = sorted(old, key=lambda c: c[1])
            moved = sorted(moved, key=lambda c: c[1])
            k = 0
            for m in moved:
                # Reading order: the next printed glyph with the same character (small look-ahead).
                for look in range(k, min(k + 4, len(old))):
                    if old[look][0] == m[0]:
                        pairs.append((old[look], m))
                        k = look + 1
                        break
            # Justified lines: words near the end settle back into place and aren't redrawn at all.
            ok = left == 0 and (len(pairs) >= max(1, len(old) - 2) or (t.get('justified') and len(pairs) >= 1))
            why = f'{left} px changed before the insertion; {len(pairs)} paired of {len(old)} glyphs'
            if ok and t.get('justified'):
                # Justified: later words settle back towards their place (right edge kept), so the
                # offset only shrinks along the line; same fonts, no vertical drift.
                dxs = [m[1] - o[1] for o, m in pairs]
                fonts = all(o[3] == m[3] for o, m in pairs)
                ok = fonts and max(abs(m[2] - o[2]) for o, m in pairs) <= 0.25 and min(dxs) >= -0.25 and max(dxs) <= dxs[0] + 0.25
                mark('4 missing glyph', ok, i, f'justified: same fonts {fonts} dx {min(dxs):.2f}..{max(dxs):.2f}')
                continue
            if ok:
                dxs = [m[1] - o[1] for o, m in pairs]
                dys = [abs(m[2] - o[2]) for o, m in pairs]
                fonts = all(o[3] == m[3] for o, m in pairs)
                old, moved = [o for o, _ in pairs], [m for _, m in pairs]
                ok = max(dxs) - min(dxs) <= 0.25 and max(dys) <= 0.25 and fonts
                why = f'dx spread {max(dxs) - min(dxs):.3f} dy {max(dys):.3f} same fonts {fonts}'
                if not ok and fonts and max(dys) <= 0.25 and len(dxs) > 8:
                    # PDFium truncates fractional glyph widths (pdfTeX, pdf-lib) when placing the
                    # printed glyphs; redrawn glyphs sit at the exact positions (as pdf.js draws
                    # them). That is a smooth drift along the line, not a jump: allow it if small.
                    xs = np.arange(len(dxs))
                    slope, icpt = np.polyfit(xs, dxs, 1)
                    resid = np.array(dxs) - (slope * xs + icpt)
                    if abs(slope) <= 0.012 and resid.max() - resid.min() <= 0.1:
                        ok = True
                        why = f'PDFium width-truncation drift {slope:.4f} pt/glyph'
                hs = [m[4] / o[4] for o, m in zip(old, moved) if o[4] > 0.5 and o[3] and m[3]]
                if hs:
                    mark('5 size', 0.98 <= float(np.median(hs)) <= 1.02, i, f'height ratio {np.median(hs)}')
            mark('4 missing glyph', ok, i, why)
    return spec, res, fails


def producer(spec):
    if spec['file'].startswith('tests/fixtures/'):
        return spec['name'] + ' (fixture)'
    try:
        m = pypdf.PdfReader(spec['file']).metadata or {}
        return f"{spec['name']} ({(m.get('/Producer') or m.get('/Creator') or 'unknown')[:24]})"
    except Exception:
        return spec['name']


rows = []
ok_all = True
corpus_tot = {}
for p in sys.argv[1:]:
    spec, res, fails = score(p)
    corpus = not spec['file'].startswith('tests/fixtures/')
    rows.append((producer(spec), res))
    for k, (good, total) in res.items():
        if not corpus and total and good < total:
            ok_all = False  # generated fixtures: every line must pass
        if corpus:
            c = corpus_tot.setdefault(k, [0, 0])
            c[0] += good
            c[1] += total
    for k, f in fails.items():
        for line in f[:6]:
            print(f'  FAIL {spec["name"]} check {k}: {line}')
    if spec['errors']:
        ok_all = False
        print(f'  page errors in {spec["name"]}: {spec["errors"][:3]}')

keys = list(rows[0][1]) if rows else []
print('\n| File (producer) | ' + ' | '.join(keys) + ' |')
print('|---|' + '---|' * len(keys))
tot = {k: [0, 0] for k in keys}
for name, res in rows:
    cells = []
    for k in keys:
        g, t = res[k]
        tot[k][0] += g
        tot[k][1] += t
        cells.append(f'{g}/{t}' if t else '–')
    print(f'| {name} | ' + ' | '.join(cells) + ' |')
print('| **all** | ' + ' | '.join(f'{g}/{t} ({100 * g / t:.0f} %)' if t else '–' for g, t in tot.values()) + ' |')
for k, (g, t) in corpus_tot.items():
    if t and g / t < 0.95:
        ok_all = False  # corpus: at least 95 % of lines per check
print('corpus: ' + ', '.join(f'{k} {100 * g / t:.1f} %' for k, (g, t) in corpus_tot.items() if t))
print('RESULT PASS' if ok_all else 'RESULT FAIL')
