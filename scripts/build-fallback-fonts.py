"""Builds the metric-compatible fallback fonts in public/fonts (dev-only, needs fontTools).

Sources: google/fonts (all SIL OFL 1.1) -- ofl/arimo, ofl/carlito, ofl/cousine, ofl/gelasio.
Download the TTFs into one folder (variable fonts keep their "[wght]" names), then run:

    python scripts/build-fallback-fonts.py <download-folder>

Each style is a static instance, unhinted (PDF embedding and canvas text don't need hinting),
subset to Latin + Latin-1 + Latin Extended-A + punctuation + currency (incl. U+20B9 rupee).
Advance widths are untouched: that is the whole point of these fonts.
"""
import io
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

SRC = sys.argv[1]
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'fonts')
UNICODES = (
    list(range(0x20, 0x7F)) + list(range(0xA0, 0x180)) + list(range(0x2000, 0x2070))
    + list(range(0x20A0, 0x20C1)) + [0x2116, 0x2122, 0x2212, 0x2219, 0x25CF, 0xFB01, 0xFB02]
)
STYLES = {'Regular': (400, False), 'Bold': (700, False), 'Italic': (400, True), 'BoldItalic': (700, True)}


def source(family, style):
    wght, italic = STYLES[style]
    static = os.path.join(SRC, f'{family}-{style}.ttf')
    if os.path.exists(static):
        return TTFont(static)
    var = os.path.join(SRC, f'{family}-Italic[wght].ttf' if italic else f'{family}[wght].ttf')
    font = instancer.instantiateVariableFont(TTFont(var), {'wght': wght})
    # Instancing keeps the default ("Regular") names: name the style properly.
    sub = {'Regular': 'Regular', 'Bold': 'Bold', 'Italic': 'Italic', 'BoldItalic': 'Bold Italic'}[style]
    for rec in font['name'].names:
        if rec.nameID == 2:
            rec.string = sub
        elif rec.nameID == 4:
            rec.string = f'{family} {sub}'
        elif rec.nameID == 6:
            rec.string = f'{family}-{style}'
        elif rec.nameID in (16, 17):
            rec.string = family if rec.nameID == 16 else sub
    font['OS/2'].usWeightClass = wght
    font['OS/2'].fsSelection = (font['OS/2'].fsSelection & ~0b1100001) | (0b100000 if wght >= 700 else 0) | (1 if italic else 0) | (0 if (wght >= 700 or italic) else 0b1000000)
    font['head'].macStyle = (1 if wght >= 700 else 0) | (2 if italic else 0)
    return font


for family in ('Arimo', 'Carlito', 'Cousine', 'Gelasio'):
    for style in STYLES:
        font = source(family, style)
        buf = io.BytesIO()
        font.save(buf)
        font = TTFont(io.BytesIO(buf.getvalue()))
        opts = subset.Options()
        opts.layout_features = ['*']
        opts.name_IDs = ['*']
        opts.notdef_outline = True
        opts.hinting = False
        sub = subset.Subsetter(opts)
        sub.populate(unicodes=UNICODES)
        sub.subset(font)
        path = os.path.join(OUT, f'{family}-{style}.ttf')
        font.save(path)
        print(f'{path}: {os.path.getsize(path) // 1024} KB')
