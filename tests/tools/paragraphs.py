"""Paragraph reflow checks (npm run test:paragraphs).

  python paragraphs.py locate <pdf> <phrase>          → JSON box (page space, top-left origin) of the phrase
  python paragraphs.py check <spec.json>              → checks each exported case, prints RESULT PASS/FAIL

A case: {"name", "out" (exported pdf), "src" (source pdf), "region": [x0, y0, x1, y1] (paragraph box in
the source, page space), "text" (expected paragraph text), and optional checks:
"justify": true, "hanging": x (continuation lines start here), "bold": [words], "bengali": true,
"other": [[x0, y0, x1, y1]] (regions whose text must stay as in the source), "within": bottom limit}.
"""
import ctypes
import json
import re
import sys
import unicodedata

import pypdfium2 as pdfium
import pypdfium2.raw as raw

sys.stdout.reconfigure(encoding='utf-8')


def chars(path, page_index=0):
    doc = pdfium.PdfDocument(path)
    page = doc[page_index]
    h = page.get_height()
    tp = page.get_textpage()
    out = []
    buf = ctypes.create_string_buffer(256)
    flags = ctypes.c_int()
    for i in range(tp.count_chars()):
        u = raw.FPDFText_GetUnicode(tp, i)
        l, b, r, t = (ctypes.c_double() for _ in range(4))
        raw.FPDFText_GetCharBox(tp, i, l, r, b, t)
        n = raw.FPDFText_GetFontInfo(tp, i, buf, 256, flags)
        font = buf.raw[: max(0, n - 1)].decode('utf-8', 'replace')
        ox, oy = ctypes.c_double(), ctypes.c_double()
        raw.FPDFText_GetCharOrigin(tp, i, ox, oy)
        out.append({'c': chr(u) if u else '', 'x0': l.value, 'x1': r.value, 'y0': h - t.value, 'y1': h - b.value, 'base': h - oy.value, 'font': font})
    return out, (doc, page, tp)


def base_fonts(path, font_name):
    """Exact /BaseFont names (subset tag included) of the source fonts called font_name."""
    import pikepdf
    pdf = pikepdf.open(path)
    res = pdf.pages[0].get('/Resources')
    return {str(f.get('/BaseFont')) for f in res.get('/Font', {}).values() if font_name.split('+')[-1] in str(f.get('/BaseFont', ''))}


def own_codes(path, bases):
    """Counter of 2-byte glyph codes drawn in fonts with exactly these /BaseFont names."""
    import collections
    import pikepdf
    pdf = pikepdf.open(path)
    out = collections.Counter()

    def walk(stream_owner, resources, depth=0):
        fonts = resources.get('/Font', {}) if resources is not None else {}
        cur = None
        for operands, op in pikepdf.parse_content_stream(stream_owner):
            op = str(op)
            if op == 'Tf':
                f = fonts.get(str(operands[0]))
                cur = f is not None and str(f.get('/BaseFont', '')) in bases
            elif op in ('Tj', 'TJ', "'", '"') and cur:
                items = operands[0] if op == 'TJ' else operands[-1:]
                for it in items:
                    if isinstance(it, pikepdf.String):
                        b = bytes(it)
                        for k in range(0, len(b) - 1, 2):
                            out[(b[k] << 8) | b[k + 1]] += 1
            elif op == 'Do' and depth < 5:
                xo = resources.get('/XObject', {}).get(str(operands[0]))
                if xo is not None and xo.get('/Subtype') == '/Form':
                    walk(xo, xo.get('/Resources', resources), depth + 1)

    page = pdf.pages[0]
    walk(page, page.get('/Resources'))
    return out


def norm(s):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFC', s)).strip()


def region_text(cs, reg):
    x0, y0, x1, y1 = reg
    sel = [c for c in cs if c['c'].strip() and c['x0'] >= x0 - 0.5 and c['x1'] <= x1 + 0.5 and (c['y0'] + c['y1']) / 2 >= y0 and (c['y0'] + c['y1']) / 2 <= y1]
    return sel


def lines_of(sel):
    rows = []
    for c in sorted(sel, key=lambda c: (round(c['base'], 1), c['x0'])):
        if rows and abs(rows[-1][0]['base'] - c['base']) < 1:
            rows[-1].append(c)
        else:
            rows.append([c])
    return [sorted(r, key=lambda c: c['x0']) for r in rows]


def row_text(row):
    s = ''
    prev = None
    for c in row:
        if prev is not None and c['x0'] - prev['x1'] > 1.2:
            s += ' '
        s += c['c']
        prev = c
    return s


if sys.argv[1] == 'locate':
    cs, keep = chars(sys.argv[2])
    text = ''.join(c['c'] for c in cs)
    i = text.find(sys.argv[3])
    if i < 0:
        print(json.dumps(None))
    else:
        sel = [c for c in cs[i : i + len(sys.argv[3])] if c['c'].strip()]
        print(json.dumps({'x': min(c['x0'] for c in sel), 'y': min(c['y0'] for c in sel), 'x1': max(c['x1'] for c in sel), 'y1': max(c['y1'] for c in sel)}))
    sys.exit(0)

if sys.argv[1] == 'font':
    cs, keep = chars(sys.argv[2])
    text = ''.join(c['c'] for c in cs)
    print(json.dumps(cs[text.find(sys.argv[3])]['font']))
    sys.exit(0)

spec = json.load(open(sys.argv[2], encoding='utf-8'))
fails = 0
for case in spec:
    problems = []
    cs, keep = chars(case['out'])
    reg = case['region']
    grow = case.get('within', reg[3]) + 1
    sel = region_text(cs, [reg[0] - 2, reg[1] - 2, reg[2] + 2, grow])
    rows = lines_of(sel)
    got = norm(' '.join(row_text(r) for r in rows))
    want = norm(case['text'])
    if case.get('prefix') is not None:
        # Expected = a new first word + the paragraph as the source PDF itself extracts.
        src_cs, keep3 = chars(case['src'])
        want = norm(case['prefix'] + ' ' + ' '.join(row_text(r) for r in lines_of(region_text(src_cs, [reg[0] - 2, reg[1] - 2, reg[2] + 2, reg[3] + 1]))))
    squash = lambda s: re.sub(r'\s+', '', s)
    if case.get('bengali'):
        # Our shaped stand-in words extract oddly (PDFium orders their marks first), so for complex
        # scripts: every glyph in the PDF's own font is still there, in order.
        # Glyph codes drawn with the PDF's own font (content stream, forms included), as a multiset:
        # edited text moves glyphs, it must never lose or double one. (PDFium's text extraction of
        # reordered Bengali clusters depends on glyph order, so text isn't compared.)
        bases = base_fonts(case['src'], case['font'])
        a, b = own_codes(case['src'], bases), own_codes(case['out'], bases)
        if a != b:
            problems.append(f'printed glyphs changed: lost {dict(a - b)} added {dict(b - a)}')
        got = want
    if squash(got) != squash(want):
        problems.append(f'text differs:\n      got  {got[:200]}\n      want {want[:200]}')
    for r in rows:
        if r[-1]['x1'] > reg[2] + 1.0 or r[0]['x0'] < reg[0] - 1.0:
            problems.append(f'line outside the column: {row_text(r)[:50]!r} x {r[0]["x0"]:.1f}..{r[-1]["x1"]:.1f} col {reg[0]:.1f}..{reg[2]:.1f}')
    if case.get('justify') and len(rows) > 1:
        right = max(r[-1]['x1'] for r in rows[:-1])
        for r in rows[:-1]:
            if right - r[-1]['x1'] > 1.0:
                problems.append(f'justified line ends short: {row_text(r)[-30:]!r} ({right - r[-1]["x1"]:.1f} pt)')
    if case.get('hanging') is not None:
        for r in rows[1:]:
            if abs(r[0]['x0'] - case['hanging']) > 1.2:
                problems.append(f'continuation line not at the hanging indent: {r[0]["x0"]:.1f} vs {case["hanging"]:.1f}')
    for w in case.get('bold', []):
        text = ''.join(c['c'] for c in cs)
        i = text.find(w)
        if i < 0:
            problems.append(f'bold word {w!r} not found')
        elif not all('Bold' in c['font'] for c in cs[i : i + len(w)] if c['c'].strip()):
            problems.append(f'{w!r} lost its bold font: {set(c["font"] for c in cs[i : i + len(w)])}')
    if case.get('bengali'):
        # Rows the new word isn't on (our shaped stand-in extracts its marks first).
        for r in rows[1:]:
            first = r[0]['c']
            if first and unicodedata.category(first) in ('Mn', 'Mc'):
                problems.append(f'line starts inside a cluster: {row_text(r)[:20]!r}')
    if case.get('other'):
        src_cs, keep2 = chars(case['src'])
        for x0, y0, x1, y1 in case['other']:
            box = [x0 - 2, y0 - 2, x1 + 2, y1 + 2]
            o = norm(' '.join(row_text(r) for r in lines_of(region_text(cs, box))))
            t = norm(' '.join(row_text(r) for r in lines_of(region_text(src_cs, box))))
            if squash(o) != squash(t):
                problems.append(f'neighbour changed: {o[:80]!r} (was {t[:80]!r})')
    if 'within' in case and rows and max(c['y1'] for r in rows for c in r) > case['within'] + 1:
        problems.append('text runs below the paragraph')
    print(('ok    ' if not problems else 'FAIL  ') + case['name'] + ''.join('\n    ' + p for p in problems))
    fails += bool(problems)
print('RESULT ' + ('PASS' if not fails else f'FAIL ({fails})'))
sys.exit(1 if fails else 0)
