"""Verify real translated PDF geometry/images and render pages for visual review."""
import argparse
import hashlib
import json
from pathlib import Path
import fitz

parser = argparse.ArgumentParser()
parser.add_argument('original', type=Path)
parser.add_argument('mono', type=Path)
parser.add_argument('dual', type=Path)
parser.add_argument('output', type=Path)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)
docs = [fitz.open(path) for path in (args.original, args.mono, args.dual)]
original, mono, dual = docs
assert len(original) == len(mono) == len(dual), 'page count changed'

def images(doc, page):
    found = []
    for item in page.get_images(full=True):
        pix = fitz.Pixmap(doc, item[0])
        digest = hashlib.sha256(pix.samples).hexdigest()
        for rect in page.get_image_rects(item[0]):
            found.append({'hash': digest, 'rect': list(rect)})
    return found

results = []
for number, (src, zh, bi) in enumerate(zip(*docs), 1):
    assert abs(src.rect.width - zh.rect.width) < 1
    assert abs(src.rect.height - zh.rect.height) < 1
    assert abs(src.rect.width * 2 - bi.rect.width) < 1
    assert abs(src.rect.height - bi.rect.height) < 1
    assert any('\u4e00' <= char <= '\u9fff' for char in zh.get_text()), 'no Chinese text in translated PDF'
    src_images, zh_images, bi_images = [images(doc, page) for doc, page in zip(docs, (src, zh, bi))]
    for expected in src_images:
        assert any(found['hash'] == expected['hash'] and all(abs(a-b) < 1 for a,b in zip(found['rect'], expected['rect'])) for found in zh_images), 'raster image moved or lost'
        for shift in (0, src.rect.width):
            target = [value + (shift if index % 2 == 0 else 0) for index, value in enumerate(expected['rect'])]
            assert any(found['hash'] == expected['hash'] and all(abs(a-b) < 1 for a,b in zip(found['rect'], target)) for found in bi_images), 'bilingual raster image moved or lost'
    if args.original.name == 'layout_images.pdf':
        chart = fitz.Rect(330, src.rect.height-555, 530, src.rect.height-425)
        reference = src.get_pixmap(clip=chart).samples
        assert zh.get_pixmap(clip=chart).samples == reference, 'translated vector chart changed'
        assert bi.get_pixmap(clip=chart).samples == reference, 'bilingual original vector chart changed'
        shifted = chart + (src.rect.width, 0, src.rect.width, 0)
        align = fitz.Matrix(1, 1).pretranslate(-src.rect.width, 0)
        rendered = bi.get_pixmap(clip=shifted, matrix=align).samples
        assert len(rendered) == len(reference)
        differences = [abs(a-b) for a,b in zip(reference, rendered)]
        # PDF float coordinates can produce tiny antialias differences after shifting.
        assert max(differences) < 16 and sum(differences)/len(differences) < .1, 'bilingual translated vector chart changed'
        source_vectors = src.get_drawings()
        translated_vectors = bi.get_drawings()[len(source_vectors):]
        assert len(source_vectors) == len(translated_vectors)
        for expected, actual in zip(source_vectors, translated_vectors):
            target = expected['rect'] + (src.rect.width, 0, src.rect.width, 0)
            assert all(abs(a-b)<.001 for a,b in zip(target, actual['rect']))
            assert expected['fill'] == actual['fill'] and expected['color'] == actual['color']
    for label, page in zip(('original', 'chinese', 'bilingual'), (src, zh, bi)):
        page.get_pixmap(matrix=fitz.Matrix(1.2, 1.2)).save(args.output / f'{label}-{number}.png')
    results.append({'page': number, 'images': {'original': src_images, 'chinese': zh_images, 'bilingual': bi_images}, 'boxes': [list(page.rect) for page in (src, zh, bi)]})
(args.output / 'layout-results.json').write_text(json.dumps(results, indent=2), encoding='utf-8')
print(json.dumps({'pages': len(original), 'raster_images_preserved': True, 'render_directory': str(args.output)}))
